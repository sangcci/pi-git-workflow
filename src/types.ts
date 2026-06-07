export type WorkflowMode = "direct" | "branch" | "observe" | "disabled";

export type GitWorkflowConfig = {
	mode: WorkflowMode;
	protectDestructiveGit: boolean;
	protectDefaultBranchWrites: boolean;
	requireChecksBeforeCommit: boolean;
	taskLedger: boolean;
	checks: string[];
};

export type GitSummary =
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

export type TaskLedger =
	| { exists: false }
	| {
			exists: true;
			content: string;
		};
