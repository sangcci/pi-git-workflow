import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_STATUS_KEY = "git-workflow";

export default function gitWorkflowExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const repo = await getGitSummary(pi);
		if (!repo.inRepo) {
			ctx.ui.setStatus(EXTENSION_STATUS_KEY, undefined);
			return;
		}

		ctx.ui.setStatus(EXTENSION_STATUS_KEY, `git: ${repo.branch}${repo.dirty ? " dirty" : " clean"}`);
	});

	pi.on("before_agent_start", async (event) => {
		const repo = await getGitSummary(pi);
		if (!repo.inRepo) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGitWorkflowContext(repo)}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const repo = await getGitSummary(pi);

		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			const risk = detectRiskyGitCommand(command, repo);
			if (!risk) return;

			return confirmOrBlockRisk(ctx, repo, risk);
		}

		if (isFileMutationTool(event.toolName) && repo.inRepo && repo.onDefaultBranch) {
			return confirmOrBlockRisk(ctx, repo, {
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

			ctx.ui.notify(buildGitWorkflowContext(repo), "info");
		},
	});
}

type ToolCallContext = ExtensionContext;

type GitSummary =
	| { inRepo: false }
	| {
			inRepo: true;
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

function buildGitWorkflowContext(repo: Extract<GitSummary, { inRepo: true }>): string {
	return [
		"Pi Git Workflow context:",
		`- Current branch: ${repo.branch}`,
		`- Default branch: ${repo.defaultBranch}`,
		repo.onDefaultBranch ? "- Warning: current branch is default branch; do not make coding changes here." : "- Branch safety: not on default branch.",
		`- Dirty files: ${repo.changedFileCount}`,
		repo.statusShort ? `- Status:\n${indent(repo.statusShort)}` : "- Status: clean",
		repo.diffStat ? `- Diff stat:\n${indent(repo.diffStat)}` : "- Diff stat: none",
		repo.recentCommits ? `- Recent commits:\n${indent(repo.recentCommits)}` : "- Recent commits: none",
		"- Match recent commit message style when drafting commits.",
		"- Keep commit scope small and logical; suggest amend/squash for related small follow-up fixes.",
		"- Do not create, close, or mutate GitHub issues automatically.",
		"- Before commit or PR preparation, run project checks when available.",
	].join("\n");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
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

async function confirmOrBlockRisk(ctx: ToolCallContext, repo: GitSummary, risk: RiskyCommand) {
	const message = [
		`Risky Git operation detected: ${risk.reason}`,
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

function isFileMutationTool(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
}

function detectRiskyGitCommand(command: string, repo: GitSummary): RiskyCommand | null {
	const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();

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

	if (repo.inRepo && repo.onDefaultBranch && modifiesRepository(normalized)) {
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
