import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitWorkflowConfig, WorkflowMode } from "./types.js";

export const CONFIG_RELATIVE_PATH = ".pi/git-workflow.json";

export const DEFAULT_CONFIG: GitWorkflowConfig = {
	mode: "observe",
	protectDestructiveGit: true,
	protectDefaultBranchWrites: false,
	requireChecksBeforeCommit: false,
	taskLedger: false,
	checks: [],
};

export async function loadConfig(root: string): Promise<GitWorkflowConfig | null> {
	try {
		const raw = await readFile(join(root, CONFIG_RELATIVE_PATH), "utf8");
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return null;
	}
}

export async function saveConfig(root: string, config: GitWorkflowConfig): Promise<void> {
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, CONFIG_RELATIVE_PATH), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function parseModeSelection(selection: string): WorkflowMode {
	if (selection.startsWith("direct")) return "direct";
	if (selection.startsWith("branch")) return "branch";
	if (selection.startsWith("disabled")) return "disabled";
	return "observe";
}

export function configForMode(mode: WorkflowMode): GitWorkflowConfig {
	if (mode === "branch") {
		return {
			mode,
			protectDestructiveGit: true,
			protectDefaultBranchWrites: true,
			requireChecksBeforeCommit: true,
			taskLedger: true,
			checks: [],
		};
	}

	if (mode === "direct") {
		return {
			mode,
			protectDestructiveGit: true,
			protectDefaultBranchWrites: false,
			requireChecksBeforeCommit: true,
			taskLedger: true,
			checks: [],
		};
	}

	if (mode === "disabled") {
		return {
			mode,
			protectDestructiveGit: false,
			protectDefaultBranchWrites: false,
			requireChecksBeforeCommit: false,
			taskLedger: false,
			checks: [],
		};
	}

	return DEFAULT_CONFIG;
}

export function normalizeConfig(value: unknown): GitWorkflowConfig {
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
		checks: Array.isArray(partial.checks) ? partial.checks.filter((item): item is string => typeof item === "string") : base.checks,
	};
}

function isWorkflowMode(value: unknown): value is WorkflowMode {
	return value === "direct" || value === "branch" || value === "observe" || value === "disabled";
}
