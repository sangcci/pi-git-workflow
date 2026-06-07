import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runChecks, type CheckResult } from "./checks.js";
import { TASK_RELATIVE_PATH, readTaskLedger } from "./ledger.js";
import type { GitSummary, GitWorkflowConfig, TaskLedger } from "./types.js";

export function formatCheckResults(results: CheckResult[]): string {
	return [
		"Check results:",
		...results.map((result) => {
			const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
			return [`- ${result.code === 0 ? "PASS" : "FAIL"}: ${result.command}`, output ? indent(truncate(output, 1200)) : undefined]
				.filter(Boolean)
				.join("\n");
		}),
	].join("\n");
}

export async function buildHistoryReviewReport(pi: ExtensionAPI, repo: Extract<GitSummary, { inRepo: true }>): Promise<string> {
	const [recentCommits, nameStatus, stagedStat] = await Promise.all([
		pi.exec("git", ["log", "--oneline", "--decorate", "-12"]),
		pi.exec("git", ["diff", "--name-status"]),
		pi.exec("git", ["diff", "--cached", "--stat"]),
	]);

	const commitCount = recentCommits.stdout.trim() ? recentCommits.stdout.trim().split("\n").filter(Boolean).length : 0;
	const shouldReview = commitCount >= 5 || /\b(fixup!|squash!|wip)\b/iu.test(recentCommits.stdout);

	return [
		"History review:",
		`- Branch: ${repo.branch}`,
		`- Dirty files: ${repo.changedFileCount}`,
		`- Cleanup threshold: ${shouldReview ? "review recommended" : "not reached"} (${commitCount} recent commits shown)`,
		"",
		recentCommits.stdout.trim() ? `Recent commits:\n${indent(recentCommits.stdout.trim())}` : "Recent commits: none",
		"",
		repo.diffStat ? `Unstaged diff stat:\n${indent(repo.diffStat)}` : "Unstaged diff stat: none",
		stagedStat.stdout.trim() ? `Staged diff stat:\n${indent(stagedStat.stdout.trim())}` : "Staged diff stat: none",
		nameStatus.stdout.trim() ? `Changed paths:\n${indent(nameStatus.stdout.trim())}` : "Changed paths: none",
		"",
		"Cleanup guidance:",
		"- If current changes are small fixes to the last commit, consider amend instead of a new commit.",
		"- If recent commits share one logical purpose, consider squash/fixup before PR.",
		"- If the current direction is wrong, identify the last clean commit and rework from there.",
		"- Do not rewrite published history without explicit user confirmation and force-with-lease.",
		"- This command only reviews. It does not run rebase, reset, amend, or push.",
	].join("\n");
}

export async function buildCommitReadinessReport(
	pi: ExtensionAPI,
	repo: Extract<GitSummary, { inRepo: true }>,
	config: GitWorkflowConfig,
): Promise<string> {
	const taskLedger = config.taskLedger ? await readTaskLedger(repo.root) : null;
	const checks = config.requireChecksBeforeCommit ? await runChecks(pi, repo, config) : [];
	const checksPassed = checks.every((result) => result.code === 0);
	const hasChanges = repo.changedFileCount > 0;
	const taskOk = !config.taskLedger || taskLedger?.exists === true;
	const branchOk = !(config.mode === "branch" && config.protectDefaultBranchWrites && repo.onDefaultBranch);

	return [
		"Commit readiness:",
		`- ${hasChanges ? "PASS" : "FAIL"}: working tree has changes to commit`,
		`- ${branchOk ? "PASS" : "FAIL"}: branch policy (${config.mode}, current: ${repo.branch})`,
		`- ${taskOk ? "PASS" : "FAIL"}: task ledger ${config.taskLedger ? TASK_RELATIVE_PATH : "not required"}`,
		config.requireChecksBeforeCommit ? `- ${checksPassed ? "PASS" : "FAIL"}: required checks` : "- PASS: checks not required by config",
		"",
		repo.statusShort ? `Status:\n${indent(repo.statusShort)}` : "Status: clean",
		repo.diffStat ? `Diff stat:\n${indent(repo.diffStat)}` : "Diff stat: none",
		"",
		repo.recentCommits ? `Recent commit style:\n${indent(repo.recentCommits)}` : "Recent commit style: none",
		checks.length > 0 ? `\n${formatCheckResults(checks)}` : undefined,
		"",
		"Next step:",
		checksPassed && hasChanges && taskOk && branchOk
			? "- Ready to draft commit message with git-commit skill. Keep commit scope logical; amend/squash related small fixes."
			: "- Not ready. Fix FAIL items before drafting commit.",
	]
		.filter(Boolean)
		.join("\n");
}

export function buildGitWorkflowContext(
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

export function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n... truncated ...`;
}
