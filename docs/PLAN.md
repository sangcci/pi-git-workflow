# Design plan

## Phase 0: Package skeleton

Status: started.

Deliverables:

- Pi package manifest.
- Extension entrypoint.
- README explaining motivation and boundaries.
- Design plan.

## Phase 1: Safety guard MVP

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

- Non-interactive mode: block high-risk commands by default.
- Interactive mode: require explicit confirmation.
- Show current branch and dirty summary before confirmation.
- Never auto-approve history rewrite.

Success criteria:

- Dangerous commands are blocked or confirmed.
- Normal read-only Git commands still run.
- Normal test/lint commands are unaffected.

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
- Warn when diff touches many unrelated areas.

Success criteria:

- Each workspace can carry a lightweight task record.
- Agent can use the ledger to decide commit boundaries.
- User can inspect task state without reading the whole chat.

## Phase 4: Quality gates

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

- Run configured checks.
- Store latest check result in session state or task ledger.
- Block commit-prep command if required checks fail.

Success criteria:

- User can run one command before commit.
- Failures are surfaced clearly.
- Extension does not invent project rules when no tool exists.

## Phase 5: Skill orchestration

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

Commands to consider:

- `/git-branch-start`
- `/git-commit-draft`
- `/git-pr-draft`

Success criteria:

- Extension does not duplicate all skill content.
- Existing personal conventions remain usable.
- User keeps control over external writes.

## Phase 6: History cleanup helpers

Goal: support clean history without unsafe automation.

Commands:

- `/git-history-review`
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
