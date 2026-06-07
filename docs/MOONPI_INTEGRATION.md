# Moonpi Git integration plan

## Purpose

`pi-git-workflow` should become a moonpi-dependent Git decision layer. Moonpi keeps ownership of modes, TODOs, sprint loops, tool availability, prompt-cache stability, and file safety guards. The Git layer observes Git state, records task history, protects risky Git operations, and asks the user what to do next.

The design must support many workflows. It should not force a single `issue -> branch -> code -> commit -> PR` path.

## Lifecycle mapping

| Moonpi point | Git layer behavior |
| --- | --- |
| `session_start` | Detect repository, load config, show compact status. Do not force setup prompts. |
| `before_agent_start` | Add factual Git context when enabled. Avoid broad instructions that compete with moonpi mode prompts. |
| `tool_call` | Protect destructive Git commands. Let moonpi Plan-phase mutation guard win. |
| `agent_end` in Plan phases | Do nothing. Planning should stay read-only and not trigger Git UI. |
| `agent_end` in Act-like phases | If dirty state changed, update ledger and offer decision UI. |

Act-like phases are `act`, `fast`, `auto` with `autoPhase=act`, and `sprint:act`.

## Act-after decision UI

The Git layer should open a decision UI only when all conditions hold:

- current cwd is inside a Git repository
- Git workflow is enabled
- current moonpi phase is Act-like
- working tree has staged or unstaged changes
- dirty-state fingerprint has not already been handled or ignored

Dirty-state fingerprint can be derived from:

- current branch
- `git status --short`
- `git diff --stat`
- `git diff --cached --stat`

The UI should show:

- branch and default branch
- dirty file count
- staged and unstaged diff stats
- changed paths
- recent commits
- completed moonpi TODOs from the just-finished turn when available
- latest checks recorded in ledger

Choices:

1. `Record task state only`
   - Update `.pi` ledger.
   - Mark this dirty fingerprint handled.

2. `Run checks`
   - Run configured checks.
   - Store results in ledger.
   - Return to decision UI or show next suggested action.

3. `Prepare commit`
   - Verify branch policy.
   - Run required checks if configured.
   - Summarize commit grouping candidates.
   - Draft or hand off to the configured commit skill or adapter.
   - Validate the resulting commit message with commitlint when available.
   - Do not commit automatically in the first implementation.

4. `Review history cleanup`
   - Show read-only history review.
   - Offer amend/squash/fixup/rework suggestions.
   - Require explicit confirmation before any rewrite command.

5. `Continue coding`
   - Do not update ignore state permanently.
   - Let the next Act turn continue.

6. `Ignore for now`
   - Mark this dirty fingerprint ignored for the current session.

## Ledger

Default moonpi-integrated ledger path:

```text
.pi/moonpi/git-task.md
```

Standalone compatibility path:

```text
.pi/git-workflow/task.md
```

The ledger is operational state. It should not live in `docs/` by default when moonpi integration is enabled.

Suggested format:

```markdown
# Moonpi Git Task

## Current context

- Branch:
- Default branch:
- Issue/ticket:
- Mode/phase:
- Updated:

## Completed moonpi TODOs

- 

## Changed files

```text

```

## Diff stat

```text

```

## Checks

- Not run yet.

## Commit candidates

- 

## History cleanup notes

- 

## Open questions

- 
```

Ledger update rules:

- Preserve previous sections where possible.
- Append timestamped check results instead of overwriting all history.
- Keep commit candidates short and derived from current diff.
- Never treat ledger as source of truth over Git state.
- Do not replace moonpi in-session TODOs; mirror completed work for persistence.

## Commit message linting

Commit readiness should include two check layers:

1. project checks before commit drafting
   - lint
   - typecheck
   - test
   - format check
   - generic check scripts

2. commit message checks after a draft message exists
   - `commitlint`
   - `lint:commit`
   - `commit:lint`
   - `commitlint:check`
   - explicit config command such as `npx commitlint --edit <file>` or `echo "$message" | npx commitlint`

General `/git-checks` can run commitlint-like npm scripts when they are configured and do not need a draft message. Commit readiness should be more precise: after the commit skill or adapter produces a message draft, the Git layer should pass that draft through the configured commitlint command before the user commits.

Rules:

- Do not invent a commit convention when no commitlint or commit skill is configured.
- If commitlint fails, show the error and ask whether to revise the message, continue without linting, or cancel commit preparation.
- Commitlint failure should block automatic commit creation. Since the first implementation does not auto-commit, it should mark the draft as not ready.
- Store the latest commitlint result in the `.pi` ledger.

## History review

History review is read-only by default.

Trigger candidates:

- branch has at least `history.reviewCommitThreshold` commits ahead of default branch
- recent commit subjects include `fixup!`, `squash!`, `wip`, or repeated small follow-up wording
- dirty diff is small and only touches files changed by the previous commit
- staged and unstaged changes appear unrelated
- user selects `Review history cleanup`

Review output should include:

- commits ahead of default branch when available
- last 10-20 commits with decorations
- staged diff stat
- unstaged diff stat
- changed path list
- suggested cleanup paths

Rewrite safety:

- `commit --amend`, `reset`, `rebase`, branch delete, and force push require confirmation.
- Confirmation text must describe branch, dirty count, command, and risk.
- Prefer `git push --force-with-lease` when rewriting remote history after explicit confirmation.
- Never run rewrite steps from automatic Act-after UI without a second explicit user choice.

## Issue, branch, commit, and PR extensibility

Treat issues and tickets as context objects, not mandatory workflow anchors.

A context object can represent:

- GitHub issue
- Jira ticket
- Linear issue
- user-provided task ID
- plain text objective

The Git layer should support configurable handlers:

```json
{
  "gitWorkflow": {
    "enabled": true,
    "ledgerPath": ".pi/moonpi/git-task.md",
    "decisionUi": {
      "afterAct": true,
      "dirtyStateThrottle": true
    },
    "history": {
      "reviewCommitThreshold": 5,
      "requireRewriteConfirmation": true
    },
    "skills": {
      "branch": "git-branch",
      "commit": "git-commit",
      "issue": "github-issue",
      "pr": "github-pr"
    },
    "adapters": {
      "issueProvider": "github",
      "ticketProvider": "jira"
    }
  }
}
```

Initial implementation can be skill-handoff based:

- `/git-branch-start` prepares branch context and instructs the user to run the configured branch skill.
- `/git-commit-ready` prepares checks, diff summary, and recent style for the configured commit skill.
- `/git-commitlint-draft <message>` validates a draft commit message with an inferred commitlint script.
- `/moonpi-git:issue` is still planned; it should prepare issue/ticket context but must not create external records without confirmation.
- `/git-pr-draft` prepares PR context but does not create PRs without confirmation.

Later implementation can define adapter interfaces for direct integration.

## Conflict mitigation

Moonpi conflicts to avoid:

- Plan-phase mutation block should win over Git guard.
- Git prompt text should be factual and concise.
- Decision UI should not open during Plan phases.
- Destructive Git confirmation should be centralized.
- Commands should use a moonpi namespace, such as `/moonpi-git:status` or `/moonpi:git status`.
- Config should live under moonpi config, with fallback migration from `.pi/git-workflow.json`.
- Ledger should move from `docs/task.md` to `.pi` in moonpi mode.

## Suggested implementation phases

1. Extract Git summary, config, checks, guard, history, and ledger helpers from the standalone extension.
2. Add moonpi adapter that can inspect moonpi mode/phase without taking ownership of mode changes.
3. Move ledger path to `.pi/moonpi/git-task.md` for moonpi mode.
4. Add read-only Act-after decision UI with throttling.
5. Add checks, commit readiness handoff, and commitlint validation for draft messages.
6. Add history review threshold and UI.
7. Add configurable skill handoff for branch, issue, commit, and PR.
8. Add optional provider adapters for GitHub/Jira/Linear only after local workflow is stable.
