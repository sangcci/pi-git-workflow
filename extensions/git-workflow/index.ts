import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_RELATIVE_PATH, DEFAULT_CONFIG, configForMode, loadConfig, parseModeSelection, saveConfig } from "../../src/config.js";
import { runChecks, runCommitlintDraft } from "../../src/checks.js";
import { dirtyFingerprint, getGitSummary } from "../../src/git.js";
import { confirmOrBlockRisk, detectRiskyGitCommand, shouldGuardDefaultBranchFileMutation } from "../../src/guards.js";
import {
	TASK_RELATIVE_PATH,
	appendChecksToTaskLedger,
	appendCommitPlanToTaskLedger,
	createTaskLedger,
	markTaskLedgerDone,
	readTaskLedger,
	updateTaskLedger,
} from "../../src/ledger.js";
import {
	buildCommitReadinessReport,
	buildGitWorkflowContext,
	buildHistoryReviewReport,
	formatCheckResults,
	indent,
} from "../../src/reports.js";
import type { GitSummary, GitWorkflowConfig } from "../../src/types.js";

const EXTENSION_STATUS_KEY = "git-workflow";


export default function gitWorkflowExtension(pi: ExtensionAPI) {
	let handledDirtyFingerprint: string | undefined;
	let ignoredDirtyFingerprint: string | undefined;

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

		if (!repo.dirty || !ctx.hasUI) return;
		const fingerprint = dirtyFingerprint(repo);
		if (fingerprint === handledDirtyFingerprint || fingerprint === ignoredDirtyFingerprint) return;

		const choice = await ctx.ui.select("Git changes detected after agent work", [
			"Record task state only",
			"Run checks",
			"Prepare commit",
			"Review history cleanup",
			"Continue coding",
			"Ignore for now",
		]);

		if (choice === "Record task state only") {
			await updateTaskLedger(repo);
			handledDirtyFingerprint = fingerprint;
			ctx.ui.notify(`Recorded Git task state in ${TASK_RELATIVE_PATH}`, "info");
			return;
		}

		if (choice === "Run checks") {
			const results = await runChecks(pi, repo, config);
			const report = formatCheckResults(results);
			await appendChecksToTaskLedger(repo, report);
			handledDirtyFingerprint = fingerprint;
			ctx.ui.notify(report, results.every((result) => result.code === 0) ? "info" : "error");
			return;
		}

		if (choice === "Prepare commit") {
			const readiness = await buildCommitReadinessReport(pi, repo, config);
			await appendCommitPlanToTaskLedger(repo, readiness);
			handledDirtyFingerprint = fingerprint;
			ctx.ui.notify(readiness, readiness.includes("FAIL") ? "warning" : "info");
			return;
		}

		if (choice === "Review history cleanup") {
			ctx.ui.notify(await buildHistoryReviewReport(pi, repo), "info");
			handledDirtyFingerprint = fingerprint;
			return;
		}

		if (choice === "Ignore for now") {
			ignoredDirtyFingerprint = fingerprint;
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

	pi.registerCommand("git-checks", {
		description: "Run configured or inferred project checks",
		handler: async (_args, ctx) => {
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

			const results = await runChecks(pi, repo, config);
			const report = formatCheckResults(results);
			if (config.taskLedger) await appendChecksToTaskLedger(repo, report);
			ctx.ui.notify(report, results.every((result) => result.code === 0) ? "info" : "error");
		},
	});

	pi.registerCommand("git-history-review", {
		description: "Review recent commits and current diff for amend/squash/rework planning",
		handler: async (_args, ctx) => {
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

			ctx.ui.notify(await buildHistoryReviewReport(pi, repo), "info");
		},
	});

	pi.registerCommand("git-commit-ready", {
		description: "Run pre-commit readiness checks and summarize current diff",
		handler: async (_args, ctx) => {
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

			const readiness = await buildCommitReadinessReport(pi, repo, config);
			if (config.taskLedger) await appendCommitPlanToTaskLedger(repo, readiness);
			ctx.ui.notify(readiness, readiness.includes("FAIL") ? "warning" : "info");
		},
	});

	pi.registerCommand("git-branch-start", {
		description: "Prepare branch context for a configured branch naming skill",
		handler: async (_args, ctx) => {
			const repo = await getGitSummary(pi);
			if (!repo.inRepo) {
				ctx.ui.notify("Not in a Git repository", "warning");
				return;
			}
			ctx.ui.notify([
				"Branch handoff context:",
				`- Current branch: ${repo.branch}`,
				`- Default branch: ${repo.defaultBranch}`,
				"- Suggested next step: run the configured branch naming skill, e.g. /skill:git-branch.",
				"- Do not create or switch branches without explicit user confirmation.",
			].join("\n"), "info");
		},
	});

	pi.registerCommand("git-pr-draft", {
		description: "Prepare PR context for a configured PR skill",
		handler: async (_args, ctx) => {
			const repo = await getGitSummary(pi);
			if (!repo.inRepo) {
				ctx.ui.notify("Not in a Git repository", "warning");
				return;
			}
			ctx.ui.notify([
				"PR handoff context:",
				`- Branch: ${repo.branch}`,
				repo.statusShort ? `Status:\n${indent(repo.statusShort)}` : "Status: clean",
				repo.diffStat ? `Diff stat:\n${indent(repo.diffStat)}` : "Diff stat: none",
				"- Suggested next step: run the configured PR skill, e.g. /skill:github-pr.",
				"- Do not create PRs without explicit user confirmation.",
			].join("\n"), "info");
		},
	});

	pi.registerCommand("git-commitlint-draft", {
		description: "Validate a draft commit message with configured commitlint script",
		handler: async (args, ctx) => {
			const repo = await getGitSummary(pi);
			if (!repo.inRepo) {
				ctx.ui.notify("Not in a Git repository", "warning");
				return;
			}

			const message = args.trim();
			if (!message) {
				ctx.ui.notify("Usage: /git-commitlint-draft <commit message>", "warning");
				return;
			}

			const result = await runCommitlintDraft(pi, repo.root, message);
			const report = formatCheckResults([result]);
			ctx.ui.notify(report, result.code === 0 ? "info" : "error");
		},
	});

	pi.registerCommand("git-task", {
		description: "Manage .pi/moonpi/git-task.md task ledger: init, status, update, done",
		getArgumentCompletions: (prefix) => {
			return ["init", "status", "update", "done"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
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

			if (action === "update") {
				await updateTaskLedger(repo);
				ctx.ui.notify(`Updated ${TASK_RELATIVE_PATH}`, "info");
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
