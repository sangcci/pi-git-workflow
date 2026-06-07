import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GitSummary, GitWorkflowConfig } from "./types.js";

export type RiskyCommand = {
	reason: string;
	policy: "confirm" | "block";
};

export async function confirmOrBlockRisk(
	ctx: ExtensionContext,
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

export function shouldGuardDefaultBranchFileMutation(config: GitWorkflowConfig, repo: GitSummary, toolName: string): boolean {
	return (
		config.mode === "branch" &&
		config.protectDefaultBranchWrites &&
		repo.inRepo &&
		repo.onDefaultBranch &&
		isFileMutationTool(toolName)
	);
}

export function detectRiskyGitCommand(command: string, repo: GitSummary, config: GitWorkflowConfig): RiskyCommand | null {
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

function isFileMutationTool(toolName: string): boolean {
	return toolName === "write" || toolName === "edit";
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
