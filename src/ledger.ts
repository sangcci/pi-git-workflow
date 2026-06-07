import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitSummary, TaskLedger } from "./types.js";

export const TASK_RELATIVE_PATH = ".pi/moonpi/git-task.md";

export async function readTaskLedger(root: string): Promise<TaskLedger> {
	try {
		return { exists: true, content: await readFile(join(root, TASK_RELATIVE_PATH), "utf8") };
	} catch {
		return { exists: false };
	}
}

export async function createTaskLedger(repo: Extract<GitSummary, { inRepo: true }>, title: string): Promise<void> {
	await mkdir(dirname(join(repo.root, TASK_RELATIVE_PATH)), { recursive: true });
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

export async function updateTaskLedger(repo: Extract<GitSummary, { inRepo: true }>): Promise<void> {
	let taskLedger = await readTaskLedger(repo.root);
	if (!taskLedger.exists) {
		await createTaskLedger(repo, `Task on ${repo.branch}`);
		taskLedger = await readTaskLedger(repo.root);
	}
	if (!taskLedger.exists) return;

	const changedFiles = repo.statusShort ? repo.statusShort : "None.";
	const commitPlan = repo.diffStat
		? [
				"Review these changes and group them into logical commits:",
				"",
				indent(repo.diffStat),
				"",
				"Prefer amend/squash for small follow-up fixes that belong to the same logical change.",
			].join("\n")
		: "No diff to commit.";

	await replaceTaskSection(repo, taskLedger.content, "Changed files", changedFiles);
	const refreshed = await readTaskLedger(repo.root);
	await replaceTaskSection(repo, refreshed.exists ? refreshed.content : taskLedger.content, "Commit plan", commitPlan);
}

export async function markTaskLedgerDone(repo: Extract<GitSummary, { inRepo: true }>): Promise<void> {
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

export async function appendChecksToTaskLedger(repo: Extract<GitSummary, { inRepo: true }>, report: string): Promise<void> {
	const taskLedger = await readTaskLedger(repo.root);
	if (!taskLedger.exists) return;

	await replaceTaskSection(repo, taskLedger.content, "Checks", report);
}

export async function appendCommitPlanToTaskLedger(repo: Extract<GitSummary, { inRepo: true }>, report: string): Promise<void> {
	const taskLedger = await readTaskLedger(repo.root);
	if (!taskLedger.exists) return;

	await replaceTaskSection(repo, taskLedger.content, "Commit plan", report);
}

async function replaceTaskSection(
	repo: Extract<GitSummary, { inRepo: true }>,
	content: string,
	section: string,
	body: string,
): Promise<void> {
	const sectionText = `## ${section}\n\n${body}\n`;
	const pattern = new RegExp(`## ${escapeRegExp(section)}[\\s\\S]*?(?=\\n## |$)`, "u");
	const next = content.includes(`## ${section}`)
		? content.replace(pattern, sectionText.trimEnd())
		: `${content.trim()}\n\n${sectionText}`;
	await writeFile(join(repo.root, TASK_RELATIVE_PATH), `${next.trim()}\n`, "utf8");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}
