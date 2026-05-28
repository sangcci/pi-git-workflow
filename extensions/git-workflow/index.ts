import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		if (event.toolName !== "bash") return;

		const command = String((event.input as { command?: unknown }).command ?? "");
		const risk = detectRiskyGitCommand(command);
		if (!risk) return;

		const repo = await getGitSummary(pi);
		const message = [
			`Risky Git command detected: ${risk}`,
			repo.inRepo ? `Branch: ${repo.branch}` : "Not in a Git repository",
			repo.inRepo ? `Dirty files: ${repo.changedFileCount}` : undefined,
			"Run this command?",
		]
			.filter(Boolean)
			.join("\n");

		if (!ctx.hasUI) {
			return { block: true, reason: `Blocked risky Git command in non-interactive mode: ${risk}` };
		}

		const allowed = await ctx.ui.confirm("Risky Git command", message);
		if (!allowed) {
			return { block: true, reason: `Blocked risky Git command: ${risk}` };
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

type GitSummary =
	| { inRepo: false }
	| {
			inRepo: true;
			branch: string;
			dirty: boolean;
			changedFileCount: number;
			statusShort: string;
			diffStat: string;
			recentCommits: string;
		};

async function getGitSummary(pi: ExtensionAPI): Promise<GitSummary> {
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"]);
	if (root.code !== 0) return { inRepo: false };

	const [branch, status, diffStat, recentCommits] = await Promise.all([
		pi.exec("git", ["branch", "--show-current"]),
		pi.exec("git", ["status", "--short"]),
		pi.exec("git", ["diff", "--stat"]),
		pi.exec("git", ["log", "--oneline", "-10"]),
	]);

	const statusShort = status.stdout.trim();
	const changedFileCount = statusShort ? statusShort.split("\n").filter(Boolean).length : 0;

	return {
		inRepo: true,
		branch: branch.stdout.trim() || "(detached)",
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

function detectRiskyGitCommand(command: string): string | null {
	const normalized = command.replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();

	const checks: Array<[RegExp, string]> = [
		[/\bgit\s+reset\s+--hard\b/, "git reset --hard"],
		[/\bgit\s+clean\s+[^;&|]*\-[^;&|]*[fxd]/, "git clean with force/delete flags"],
		[/\bgit\s+push\b[^;&|]*(--force|-f|--force-with-lease)\b/, "git push force"],
		[/\bgit\s+branch\s+-(d|D)\b/, "git branch delete"],
		[/\bgit\s+rebase\b/, "git rebase/history rewrite"],
	];

	for (const [pattern, reason] of checks) {
		if (pattern.test(normalized)) return reason;
	}

	return null;
}
