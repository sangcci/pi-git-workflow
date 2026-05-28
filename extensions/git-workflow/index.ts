import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_STATUS_KEY = "git-workflow";
const CONFIG_RELATIVE_PATH = ".pi/git-workflow.json";
const TASK_RELATIVE_PATH = "docs/task.md";

type WorkflowMode = "direct" | "branch" | "observe" | "disabled";

type GitWorkflowConfig = {
	mode: WorkflowMode;
	protectDestructiveGit: boolean;
	protectDefaultBranchWrites: boolean;
	requireChecksBeforeCommit: boolean;
	taskLedger: boolean;
};

const DEFAULT_CONFIG: GitWorkflowConfig = {
	mode: "observe",
	protectDestructiveGit: true,
	protectDefaultBranchWrites: false,
	requireChecksBeforeCommit: false,
	taskLedger: false,
};

export default function gitWorkflowExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const repo = await getGitSummary(pi);
		if (!repo.inRepo) {
			ctx.ui.setStatus(EXTENSION_STATUS_KEY, undefined);
			return;
		}

		const config = await loadOrCreateConfig(pi, ctx, repo);
		if (config.mode === "disabled") {
			ctx.ui.setStatus(EXTENSION_STATUS_KEY, "git: disabled");
			return;
		}

		ctx.ui.setStatus(EXTENSION_STATUS_KEY, `git: ${config.mode} ${repo.branch}${repo.dirty ? " dirty" : " clean"}`);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const repo = await getGitSummary(pi);
		if (!repo.inRepo) return;

		const config = await loadOrCreateConfig(pi, ctx, repo);
		if (config.mode === "disabled") return;

		const taskLedger = config.taskLedger ? await readTaskLedger(repo.root) : null;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGitWorkflowContext(repo, config, taskLedger)}`,
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		const repo = await getGitSummary(pi);
		if (!repo.inRepo) return;

		const config = await loadOrCreateConfig(pi, ctx, repo);
		if (!config.taskLedger || config.mode === "disabled") return;

		const taskLedger = await readTaskLedger(repo.root);
		if (!taskLedger.exists && repo.dirty && ctx.hasUI) {
			ctx.ui.notify(`Git changes detected without ${TASK_RELATIVE_PATH}. Run /git-task init <title>.`, "warning");
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		const repo = await getGitSummary(pi);
		if (!repo.inRepo) return;

		const config = await loadOrCreateConfig(pi, ctx, repo);
		if (config.mode === "disabled") return;

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			const risk = detectRiskyGitCommand(command, repo, config);
			if (!risk) return;

			return confirmOrBlockRisk(ctx, repo, config, risk);
		}

		if (shouldGuardDefaultBranchFileMutation(config, repo, event.toolName)) {
			return confirmOrBlockRisk(ctx, repo, config, {
				reason: `file mutation on default branch (${repo.defaultBranch})`,
				policy: "confirm",
			});
		}
	});

	pi.registerCommand("git-workflow-status", {
		description: "Show Git workflow context used by pi-git-workflow",
		handler: async (_args, ctx) => {
			const repo = await getGitSummary(pi);
			if (!repo.inRepo) {
				ctx.ui.notify("Not in a Git repository", "warning");
				return;
			}

			const config = await loadOrCreateConfig(pi, ctx, repo);
			const taskLedger = config.taskLedger ? await readTaskLedger(repo.root) : null;
			ctx.ui.notify(buildGitWorkflowContext(repo, config, taskLedger), "info");
		},
	});

	pi.registerCommand("git-task", {
		description: "Manage docs/task.md task ledger: init, status, done",
		getArgumentCompletions: (prefix) => {
			return ["init", "status", "done"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const repo = await getGitSummary(pi);
			if (!repo.inRepo) {
				ctx.ui.notify("Not in a Git repository", "warning");
				return;
			}

			const config = await loadOrCreateConfig(pi, ctx, repo);
			if (config.mode === "disabled") {
				ctx.ui.notify("pi-git-workflow is disabled for this repo", "warning");
				return;
			}

			const [action = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const title = rest.join(" ").trim();

			if (action === "init") {
				await createTaskLedger(repo, title || `Task on ${repo.branch}`);
				ctx.ui.notify(`Created ${TASK_RELATIVE_PATH}`, "info");
				return;
			}

			if (action === "done") {
				await markTaskLedgerDone(repo);
				ctx.ui.notify(`Marked ${TASK_RELATIVE_PATH} done`, "info");
				return;
			}

			const taskLedger = await readTaskLedger(repo.root);
			ctx.ui.notify(taskLedger.exists ? taskLedger.content : `${TASK_RELATIVE_PATH} does not exist. Run /git-task init <title>.`, "info");
		},
	});
}

type ToolCallContext = ExtensionContext;

type GitSummary =
	| { inRepo: false }
	| {
			inRepo: true;
			root: string;
			branch: string;
			defaultBranch: string;
			onDefaultBranch: boolean;
			dirty: boolean;
			changedFileCount: number;
			statusShort: string;
			diffStat: string;
			recentCommits: string;
		};

async function getGitSummary(pi: ExtensionAPI): Promise<GitSummary> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return { inRepo: false };

	const [branch, defaultBranch, status, diffStat, recentCommits] = await Promise.all([
		pi.exec("git", ["branch", "--show-current"]),
		getDefaultBranch(pi),
		pi.exec("git", ["status", "--short"]),
		pi.exec("git", ["diff", "--stat"]),
		pi.exec("git", ["log", "--oneline", "-10"]),
	]);

	const currentBranch = branch.stdout.trim() || "(detached)";
	const statusShort = status.stdout.trim();
	const changedFileCount = statusShort ? statusShort.split("\n").filter(Boolean).length : 0;

	return {
		inRepo: true,
		root: root.stdout.trim(),
		branch: currentBranch,
		defaultBranch,
		onDefaultBranch: currentBranch === defaultBranch,
		dirty: changedFileCount > 0,
		changedFileCount,
		statusShort,
		diffStat: diffStat.stdout.trim(),
		recentCommits: recentCommits.stdout.trim(),
	};
}

async function loadOrCreateConfig(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	repo: Extract<GitSummary, { inRepo: true }>,
): Promise<GitWorkflowConfig> {
	const existing = await loadConfig(repo.root);
	if (existing) return existing;

	if (!ctx.hasUI) return DEFAULT_CONFIG;

	const selected = await ctx.ui.select("pi-git-workflow: choose Git management mode for this repo", [
		"direct - allow main/default branch work; keep destructive Git guard",
		"branch - prefer feature branches/worktrees; protect default branch",
		"observe - inject Git context only; keep destructive Git guard",
		"disabled - no Git workflow integration for this repo",
	]);

	const config = configForMode(parseModeSelection(selected));
	await saveConfig(repo.root, config);
	ctx.ui.notify(`Saved ${CONFIG_RELATIVE_PATH} with mode: ${config.mode}`, "info");
	return config;
}

async function loadConfig(root: string): Promise<GitWorkflowConfig | null> {
	try {
		const raw = await readFile(join(root, CONFIG_RELATIVE_PATH), "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return null;
	}
}

async function saveConfig(root: string, config: GitWorkflowConfig): Promise<void> {
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, CONFIG_RELATIVE_PATH), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseModeSelection(selection: string): WorkflowMode {
	if (selection.startsWith("direct")) return "direct";
	if (selection.startsWith("branch")) return "branch";
	if (selection.startsWith("disabled")) return "disabled";
	return "observe";
}

function configForMode(mode: WorkflowMode): GitWorkflowConfig {
	if (mode === "branch") {
		return {
			mode,
			protectDestructiveGit: true,
			protectDefaultBranchWrites: true,
			requireChecksBeforeCommit: true,
			taskLedger: true,
		};
	}

	if (mode === "direct") {
		return {
			mode,
			protectDestructiveGit: true,
			protectDefaultBranchWrites: false,
			requireChecksBeforeCommit: true,
			taskLedger: true,
		};
	}

	if (mode === "disabled") {
		return {
			mode,
			protectDestructiveGit: false,
			protectDefaultBranchWrites: false,
			requireChecksBeforeCommit: false,
			taskLedger: false,
		};
	}

	return DEFAULT_CONFIG;
}

function normalizeConfig(value: unknown): GitWorkflowConfig {
	const partial = typeof value === "object" && value !== null ? (value as Partial<GitWorkflowConfig>) : {};
	const mode = isWorkflowMode(partial.mode) ? partial.mode : DEFAULT_CONFIG.mode;
	const base = configForMode(mode);

	return {
		mode,
		protectDestructiveGit: typeof partial.protectDestructiveGit === "boolean" ? partial.protectDestructiveGit : base.protectDestructiveGit,
		protectDefaultBranchWrites:
			typeof partial.protectDefaultBranchWrites === "boolean"
				? partial.protectDefaultBranchWrites
				: base.protectDefaultBranchWrites,
		requireChecksBeforeCommit:
			typeof partial.requireChecksBeforeCommit === "boolean"
				? partial.requireChecksBeforeCommit
				: base.requireChecksBeforeCommit,
		taskLedger: typeof partial.taskLedger === "boolean" ? partial.taskLedger : base.taskLedger,
	};
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
	return value === "direct" || value === "branch" || value === "observe" || value === "disabled";
}

type TaskLedger =
	| { exists: false }
	| {
			exists: true;
			content: string;
		};

async function readTaskLedger(root: string): Promise<TaskLedger> {
	try {
		return { exists: true, content: await readFile(join(root, TASK_RELATIVE_PATH), "utf8") };
	} catch {
		return { exists: false };
	}
}

async function createTaskLedger(repo: Extract<GitSummary, { inRepo: true }>, title: string): Promise<void> {
	await mkdir(join(repo.root, "docs"), { recursive: true });
	const content = [
		"# Task",
		"",
		"## Current objective",
		"",
		title,
		"",
		"## Scope",
		"",
		"- ",
		"",
		"## Out of scope",
		"",
		"- ",
		"",
		"## Changed files",
		"",
		repo.statusShort ? indent(repo.statusShort) : "None yet.",
		"",
		"## Checks",
		"",
		"- Not run yet.",
		"",
		"## Commit plan",
		"",
		"- ",
		"",
		"## Open questions",
		"",
		"- ",
		"",
		"## Status",
		"",
		"In progress.",
		"",
	].join("\n");

	await writeFile(join(repo.root, TASK_RELATIVE_PATH), content, "utf8");
}

async function markTaskLedgerDone(repo: Extract<GitSummary, { inRepo: true }>): Promise<void> {
	const taskLedger = await readTaskLedger(repo.root);
	if (!taskLedger.exists) {
		await createTaskLedger(repo, `Task on ${repo.branch}`);
		return markTaskLedgerDone(repo);
	}

	const next = taskLedger.content.includes("## Status")
		? taskLedger.content.replace(/## Status[\s\S]*$/u, "## Status\n\nDone.\n")
		: `${taskLedger.content.trim()}\n\n## Status\n\nDone.\n`;
	await writeFile(join(repo.root, TASK_RELATIVE_PATH), next, "utf8");
}

function buildGitWorkflowContext(
	repo: Extract<GitSummary, { inRepo: true }>,
	config: GitWorkflowConfig,
	taskLedger: TaskLedger | null,
): string {
	return [
		"Pi Git Workflow context:",
		`- Mode: ${config.mode}`,
		`- Current branch: ${repo.branch}`,
		`- Default branch: ${repo.defaultBranch}`,
		branchSafetyLine(repo, config),
		`- Dirty files: ${repo.changedFileCount}`,
		repo.statusShort ? `- Status:\n${indent(repo.statusShort)}` : "- Status: clean",
		repo.diffStat ? `- Diff stat:\n${indent(repo.diffStat)}` : "- Diff stat: none",
		repo.recentCommits ? `- Recent commits:\n${indent(repo.recentCommits)}` : "- Recent commits: none",
		"- Match recent commit message style when drafting commits.",
		"- Keep commit scope small and logical; suggest amend/squash for related small follow-up fixes.",
		"- Do not create, close, or mutate GitHub issues automatically.",
		config.requireChecksBeforeCommit
			? "- Before commit or PR preparation, run configured project checks."
			: "- Checks are advisory unless the user asks for commit/PR preparation.",
		config.taskLedger
			? taskLedger?.exists
				? `- Task ledger (${TASK_RELATIVE_PATH}) exists. Keep it current when scope, checks, or commit plan changes.`
				: `- Task ledger enabled but ${TASK_RELATIVE_PATH} is missing. For scoped coding work, create it with /git-task init <title>.`
			: "- Task ledger is not required in this repo mode.",
		taskLedger?.exists ? `- Current task ledger:\n${indent(truncate(taskLedger.content, 3000))}` : undefined,
	]
		.filter(Boolean)
		.join("\n");
}

function branchSafetyLine(repo: Extract<GitSummary, { inRepo: true }>, config: GitWorkflowConfig): string {
	if (!repo.onDefaultBranch) return "- Branch safety: not on default branch.";
	if (config.mode === "branch") return "- Warning: branch mode protects the default branch; use a feature branch/worktree.";
	if (config.mode === "direct") return "- Branch safety: direct mode allows work on the default branch.";
	return "- Branch safety: observe mode does not enforce branch policy.";
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n... truncated ...`;
}

async function getDefaultBranch(pi: ExtensionAPI): Promise<string> {
	const symbolicRef = await pi.exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
	const remoteHead = symbolicRef.stdout.trim();
	if (symbolicRef.code === 0 && remoteHead.startsWith("origin/")) {
		return remoteHead.slice("origin/".length);
	}

	for (const candidate of ["main", "master", "develop"]) {
		const exists = await pi.exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
		if (exists.code === 0) return candidate;
	}

	return "main";
}

type RiskyCommand = {
	reason: string;
	policy: "confirm" | "block";
};

async function confirmOrBlockRisk(
	ctx: ToolCallContext,
	repo: GitSummary,
	config: GitWorkflowConfig,
	risk: RiskyCommand,
) {
	const message = [
		`Risky Git operation detected: ${risk.reason}`,
		repo.inRepo ? `Mode: ${config.mode}` : undefined,
		repo.inRepo ? `Branch: ${repo.branch}` : "Not in a Git repository",
		repo.inRepo ? `Default branch: ${repo.defaultBranch}` : undefined,
		repo.inRepo ? `Dirty files: ${repo.changedFileCount}` : undefined,
		risk.policy === "block" ? "This operation is blocked by policy." : "Allow this operation?",
	]
		.filter(Boolean)
		.join("\n");

	if (risk.policy === "block") {
		return { block: true, reason: message };
	}

	if (!ctx.hasUI) {
		return { block: true, reason: `Blocked risky Git operation in non-interactive mode: ${risk.reason}` };
	}

	const allowed = await ctx.ui.confirm("Risky Git operation", message);
	if (!allowed) {
		return { block: true, reason: `Blocked risky Git operation: ${risk.reason}` };
	}
}

function shouldGuardDefaultBranchFileMutation(config: GitWorkflowConfig, repo: GitSummary, toolName: string): boolean {
	return (
		config.mode === "branch" &&
		config.protectDefaultBranchWrites &&
		repo.inRepo &&
		repo.onDefaultBranch &&
		isFileMutationTool(toolName)
	);
}

function isFileMutationTool(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
}

function detectRiskyGitCommand(command: string, repo: GitSummary, config: GitWorkflowConfig): RiskyCommand | null {
	const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();

	if (config.protectDestructiveGit) {
		const confirmChecks: Array<[RegExp, string]> = [
			[/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
			[/\bgit\s+reset\b[^;&|]*\bHEAD~\d+\b/, "git reset to previous commit"],
			[/\bgit\s+clean\s+[^;&|]*\-[^;&|]*[fxd]/, "git clean with force/delete flags"],
			[/\bgit\s+push\b[^;&|]*(--force|-f|--force-with-lease)\b/, "git push force"],
			[/\bgit\s+branch\s+-(d|D)\b/, "git branch delete"],
			[/\bgit\s+rebase\b/, "git rebase/history rewrite"],
			[/\bgit\s+commit\b[^;&|]*\s+--amend\b/, "git commit --amend/history rewrite"],
			[/\bgit\s+checkout\b[^;&|]*\s+(-f|--force)\b/, "git checkout force"],
			[/\bgit\s+switch\b[^;&|]*\s+(-f|--force)\b/, "git switch force"],
			[/\bgit\s+restore\b[^;&|]*\s+(-W|--worktree)\b/, "git restore worktree files"],
		];

		for (const [pattern, reason] of confirmChecks) {
			if (pattern.test(normalized)) return { reason, policy: "confirm" };
		}
	}

	if (config.mode === "branch" && config.protectDefaultBranchWrites && repo.inRepo && repo.onDefaultBranch && modifiesRepository(normalized)) {
		return { reason: `repository-modifying command on default branch (${repo.defaultBranch})`, policy: "block" };
	}

	return null;
}

function modifiesRepository(command: string): boolean {
	const writeGitCommands = [
		/\bgit\s+add\b/,
		/\bgit\s+commit\b/,
		/\bgit\s+merge\b/,
		/\bgit\s+pull\b/,
		/\bgit\s+cherry-pick\b/,
		/\bgit\s+revert\b/,
		/\bgit\s+stash\s+(push|pop|apply|drop|clear)\b/,
	];

	return writeGitCommands.some((pattern) => pattern.test(command));
}
