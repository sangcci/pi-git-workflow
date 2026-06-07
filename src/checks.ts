import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitWorkflowConfig, GitSummary } from "./types.js";

export type CheckResult = {
	command: string;
	code: number;
	stdout: string;
	stderr: string;
};

export async function runChecks(
	pi: ExtensionAPI,
	repo: Extract<GitSummary, { inRepo: true }>,
	config: GitWorkflowConfig,
): Promise<CheckResult[]> {
	const commands = config.checks.length > 0 ? config.checks : await inferCheckCommands(repo.root);
	if (commands.length === 0) {
		return [{ command: "(none)", code: 0, stdout: "No configured or inferred checks.", stderr: "" }];
	}

	const results: CheckResult[] = [];
	for (const command of commands) {
		const result = await pi.exec("sh", ["-lc", command]);
		results.push({ command, code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
		if (result.code !== 0) break;
	}
	return results;
}

export async function inferCheckCommands(root: string): Promise<string[]> {
	const packageJson = await readJsonFile(join(root, "package.json"));
	const scripts = getPackageScripts(packageJson);
	const commands: string[] = [];

	for (const name of ["lint", "typecheck", "test", "format:check", "check", ...COMMITLINT_SCRIPT_NAMES]) {
		if (scripts[name]) commands.push(`npm run ${name}`);
	}

	return commands;
}

const COMMITLINT_SCRIPT_NAMES = ["commitlint", "lint:commit", "commit:lint", "commitlint:check"] as const;

export async function inferCommitlintCommand(root: string, message: string): Promise<string | null> {
	const packageJson = await readJsonFile(join(root, "package.json"));
	const scripts = getPackageScripts(packageJson);
	const scriptName = COMMITLINT_SCRIPT_NAMES.find((name) => scripts[name]);
	if (!scriptName) return null;
	return `printf '%s\\n' ${shellQuote(message)} | npm run ${scriptName}`;
}

export async function runCommitlintDraft(pi: ExtensionAPI, root: string, message: string): Promise<CheckResult> {
	const command = await inferCommitlintCommand(root, message);
	if (!command) {
		return { command: "(none)", code: 0, stdout: "No configured or inferred commitlint command.", stderr: "" };
	}
	const result = await pi.exec("sh", ["-lc", command]);
	return { command, code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function readJsonFile(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

function getPackageScripts(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null) return {};
	const scripts = (value as { scripts?: unknown }).scripts;
	if (typeof scripts !== "object" || scripts === null) return {};
	return scripts as Record<string, string>;
}
