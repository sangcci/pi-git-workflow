import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitSummary } from "./types.js";

export async function getGitSummary(pi: ExtensionAPI): Promise<GitSummary> {
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

export function dirtyFingerprint(repo: Extract<GitSummary, { inRepo: true }>): string {
	return [repo.branch, repo.statusShort, repo.diffStat].join("\n---\n");
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
