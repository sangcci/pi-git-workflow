# Design plan

## Moonpi integration direction

Status: planned.

`pi-git-workflow` should move from a standalone Git extension toward a moonpi-dependent Git decision layer. Moonpi already owns planning, acting, TODO state, sprint loops, prompt-cache-stable tool schemas, and read/write guards. The Git workflow should not replace that workflow. It should attach to moonpi phase boundaries and help the user decide what to do with local Git state after the agent changes files.

The core principle is: do not build a fixed `issue -> branch -> code -> commit -> PR` conveyor belt. Git workflows vary too much across personal repositories, company repositories, trunk-based teams, GitHub-flow teams, Jira-driven teams, squash-merge teams, and rebase-heavy teams. The extension should collect facts, enforce safety, record decisions, and expose hooks where project-specific skills or adapters can decide conventions.

Goals:

- Run as a moonpi companion layer, not a competing workflow controller.
- Keep moonpi Plan/Act/Auto/Fast semantics authoritative.
- Inject concise Git context without invalidating moonpi's prompt-cache strategy more than necessary.
- After Act phases, inspect Git status and present decision UI instead of auto-committing.
- Record moonpi TODO completion and Git summaries in a workspace-local `.pi` ledger.
- Support commit readiness, checks, and history cleanup as explicit user decisions.
- Support issue, branch, commit, and PR conventions through configurable skills or adapters.

Non-goals:

- Automatic issue-to-PR pipeline.
- Automatic issue close or external ticket mutation.
- Silent commit, amend, rebase, squash, reset, or force push.
- One global branch naming, commit message, or PR body convention.
- Replacing moonpi TODOs with a separate task system.

## Moonpi lifecycle integration

Current standalone hooks should be redistributed when integrated with moonpi:

- `session_start`
  - Detect Git repo and show compact Git status.
  - Load moonpi Git config from `.pi/moonpi.json` or a nested `.pi/moonpi/git-workflow.json` fallback.
  - Do not prompt aggressively on first startup unless the user invokes setup.

- `before_agent_start`
  - Append concise Git context only when enabled and in a Git repo.
  - Keep this context factual: branch, default branch, dirty count, diff stat, recent commits, active task ledger path.
  - Avoid issuing broad workflow instructions that compete with moonpi mode prompts.

- `tool_call`
  - Keep destructive Git guard active in Act/Fast phases.
  - Let moonpi's Plan-phase guard block `bash`, `write`, and `edit` first.
  - Default branch write policy should be a Git policy layer on top of moonpi's read-before-write and cwd guards.
  - Risky Git operations should use one confirmation path so the user does not see duplicate prompts.

- `agent_end`
  - In Plan phases: do not open Git decision UI.
  - In Act/Fast/Sprint Act phases: if the repo is dirty, update the `.pi` ledger and offer a Git decision UI.
  - If the turn only answered a question or changed nothing, stay quiet.

## Act-after Git decision UI

After an Act-like phase completes and Git has dirty changes, moonpi Git should show a read-only decision surface.

Inputs:

- `git status --short`
- `git diff --stat`
- staged diff stat
- recent commits
- moonpi TODO state
- latest check results
- active issue/ticket metadata when present

Suggested choices:

- `Record task state only`
- `Run checks`
- `Prepare commit`
- `Review history cleanup`
- `Continue coding`
- `Ignore for now`

Rules:

- The UI only decides the next workflow step.
- It must not commit, amend, squash, rebase, push, create issues, close issues, or open PRs by default.
- `Prepare commit` should run required checks when configured, summarize staging candidates, and hand off to the configured commit skill or adapter.
- After a commit message draft exists, validate it with commitlint when the project provides commitlint configuration or scripts.
- `Review history cleanup` is read-only until the user explicitly confirms a rewrite operation.
- The UI should be throttled so it does not nag after every turn for the same unchanged dirty state.

## Workspace-local task ledger

The existing `docs/task.md` ledger should move under `.pi` for moonpi integration. It is operational state, not product documentation.

Preferred path:

```text
.pi/moonpi/git-task.md
```

Alternative for standalone compatibility:

```text
.pi/git-workflow/task.md
```

Ledger should record:

- active objective or ticket key
- moonpi mode and phase that produced the work
- completed moonpi TODOs
- changed files from `git status --short`
- diff stat
- latest checks and timestamps
- commit candidates and grouping notes
- history cleanup notes
- open questions or deferred decisions

The ledger should be updated by moonpi Git after Act-like phases and by explicit commands. It should not replace moonpi's in-session TODO state; it should persist decisions across long sessions, compaction, restarts, and handoffs.

## Commitlint policy

Commit message linting should be part of commit readiness, but only after a message draft exists.

General checks can infer npm scripts such as:

- `commitlint`
- `lint:commit`
- `commit:lint`
- `commitlint:check`

For commit preparation, the preferred flow is:

1. collect Git status, diff stat, and recent commit style
2. run project checks when required
3. ask the configured commit skill or adapter to draft a commit message
4. run commitlint against that draft when available
5. if commitlint fails, revise the draft or cancel commit preparation
6. only then ask the user whether to commit

The extension should not invent commit conventions when no commitlint configuration, commit skill, or adapter is configured.

## History cleanup policy

History cleanup should stay review-first and confirmation-driven.

Trigger ideas:

- local branch has more than N commits over default branch
- more than N commits since the last clean base marker
- recent commits contain repeated fixup-style subjects
- dirty diff is small and likely belongs to the previous commit
- staged and unstaged changes are mixed across unrelated paths

UI should show:

- recent commits with subjects and decorations
- commits ahead of default branch when available
- unstaged and staged diff stats
- suggested options: amend last commit, squash/fixup related commits, split current diff, start over from a clean commit, do nothing

Safety rules:

- Read-only by default.
- Any amend, reset, rebase, squash, branch delete, or force push requires explicit confirmation.
- Prefer `--force-with-lease` over `--force` after the user confirms a push rewrite.
- Never rewrite published history silently.

## Issue, branch, code, commit, PR extensibility

Issue and PR workflow should be adapter-based. An issue can be a GitHub issue, Jira ticket, Linear issue, or a plain user-provided task ID. The extension should treat it as context, not truth.

Config should allow selecting handlers for:

- issue/ticket source and creation convention
- branch naming convention
- commit message convention
- PR title/body convention
- check command resolver
- commitlint command or npm script for drafted commit messages
- release or merge policy notes

Possible config shape:

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

The first implementation can expose commands that prepare context and tell the user which skill to run. Later implementations can add adapter APIs for direct handoff.

## Conflict mitigation with moonpi

Known conflict points and planned mitigations:

- Prompt injection: keep Git context factual and append through moonpi-owned prompt building where possible.
- Plan guard: do not show Git decision UI during Plan phases; let moonpi block mutating tools.
- Tool guard: centralize destructive Git confirmation to avoid duplicate prompts.
- Command namespace: use moonpi-prefixed commands or nest Git commands under moonpi naming.
- Task ledger: store operational ledger under `.pi`, not `docs/task.md`.
- Config: prefer moonpi config, with migration or fallback from `.pi/git-workflow.json`.
- External writes: issue creation, issue closing, PR creation, push, and history rewrite require explicit user confirmation.

## Phase 0: Package skeleton

Status: started.

Deliverables:

- Pi package manifest.
- Extension entrypoint.
- README explaining motivation and boundaries.
- Design plan.

## Phase 1: Safety guard MVP

Status: initial implementation with per-repository modes.

Goal: prevent irreversible or high-risk Git operations from happening silently.

Hooks:

- `tool_call` for `bash`.

Detect commands containing:

- `git reset --hard`
- `git clean -fd`, `git clean -xdf`, `git clean -ffdx`
- `git push --force`, `git push -f`, `--force-with-lease`
- `git branch -D`, `git branch -d`
- `git rebase`, especially interactive rebase
- `git checkout` or `git switch` when dirty state may be lost

Behavior:

- Store repo policy in `.pi/git-workflow.json`.
- `direct`: allow default branch work, keep destructive Git confirmation.
- `branch`: protect default branch writes and repository-mutating Git commands.
- `observe`: inject context and keep destructive Git confirmation without workflow enforcement.
- `disabled`: no integration for the repo.
- Non-interactive mode: use observe defaults when no config exists.
- Interactive mode: ask the user to choose repo mode on first run.
- Show current branch and dirty summary before confirmation.
- Never auto-approve history rewrite.

Success criteria:

- Dangerous commands are blocked or confirmed.
- Normal read-only Git commands still run.
- Normal test/lint commands are unaffected.
- File mutation tools require confirmation on the default branch.

## Phase 2: Git context injection

Goal: repeatedly provide the agent with repository-specific Git conventions.

Hook:

- `before_agent_start`.

Collected context:

- Current branch.
- Default branch guess.
- `git status --short`.
- `git diff --stat`.
- `git log --oneline -10`.
- Recent commit subjects.
- Branch naming examples from local branches.
- Optional project files such as `AGENTS.md`, commitlint config, or package scripts.

Injected guidance:

- Match recent commit message style.
- Keep commits logically scoped.
- Prefer amend/squash for small follow-up fixes related to the same task.
- Do not create or close GitHub issues automatically.
- Before commit/PR, run configured checks.

Success criteria:

- Agent receives fresh Git context at each coding request.
- Context stays concise enough not to flood prompt.
- Injection works even in long sessions.

## Phase 3: Task ledger

Status: initial implementation.

Goal: keep work scoped and prevent giant mixed diffs.

File:

- `docs/task.md` in the active workspace.

Commands:

- `/git-task init [title]`
- `/git-task status`
- `/git-task update`
- `/git-task done`

Suggested ledger sections:

```markdown
# Task

## Current objective

## Scope

## Out of scope

## Changed files

## Checks

## Commit plan

## Open questions
```

Behavior:

- If coding starts without `docs/task.md`, notify or offer to create it.
- At `agent_end`, summarize changed files and suggest ledger update.
- Refresh changed files and commit plan from Git status/diff.
- Warn when diff touches many unrelated areas later.

Success criteria:

- Each workspace can carry a lightweight task record.
- Agent can use the ledger to decide commit boundaries.
- User can inspect task state without reading the whole chat.

## Phase 4: Quality gates

Status: initial implementation.

Goal: force deterministic checks before commit or PR preparation.

Config sources, in priority order:

1. Project config file, likely `.pi/git-workflow.json`.
2. Package manager scripts from `package.json`.
3. Common fallback commands.

Possible checks:

- test
- lint
- format check
- typecheck
- commit message lint

Commands:

- `/git-checks`
- `/git-commit-ready`

Behavior:

- Run configured checks from `.pi/git-workflow.json`.
- Infer npm scripts when no checks are configured.
- Store latest check result in task ledger when enabled.
- Report commit readiness failures before the user runs commit generation.

Success criteria:

- User can run one command before commit.
- Failures are surfaced clearly.
- Extension does not invent project rules when no tool exists.

## Phase 5: Skill orchestration

Status: documented workflow handoff.

Goal: reuse existing skills for text generation and conventions.

Existing skills to integrate conceptually:

- `git-branch`
- `git-commit`
- `github-issue`
- `github-pr`

Behavior:

- Extension commands prepare context and checks.
- Skills generate branch names, commit messages, issue text, or PR text.
- Issue/PR creation remains explicit.
- README documents handoff to `git-commit`, `github-issue`, and `github-pr` skills.

Commands to consider:

- `/git-branch-start`
- `/git-commit-draft`
- `/git-pr-draft`

Success criteria:

- Extension does not duplicate all skill content.
- Existing personal conventions remain usable.
- User keeps control over external writes.

## Phase 6: History cleanup helpers

Status: initial read-only implementation.

Goal: support clean history without unsafe automation.

Commands:

- `/git-history-review`

Planned later:

- `/git-squash-plan`
- `/git-amend-plan`
- `/git-rework-from <commit>`

Behavior:

- Analyze recent commits and current diff.
- Suggest squash/amend/fixup grouping.
- Require confirmation for any history rewrite.
- Prefer `--force-with-lease` over `--force` only after confirmation.

Success criteria:

- User can keep history clean.
- Agent cannot silently rewrite history.
- Similar small fixes are merged into related commits when user approves.

## Phase 7: GitHub/MCP integration, optional

Goal: add issue/PR convenience only after local workflow is stable.

Rules:

- No automatic issue close.
- No automatic PR creation without confirmation.
- Issue can be used as context, not as truth.
- PR text generation can use skills and current diff.

Success criteria:

- GitHub operations are explicit.
- Local Git safety remains independent from GitHub availability.
