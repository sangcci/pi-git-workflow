# pi-git-workflow

`pi-git-workflow` is a Pi extension package for integrating Git into coding-agent work without turning GitHub issues into an unsafe automatic conveyor belt.

The goal is not to make the agent blindly run `issue -> branch -> code -> commit -> PR`. The goal is to make local Git workflow safer, more consistent, and easier to keep clean while the human and the agent explore the actual problem together.

## Problems this extension is designed around

### Issues are not always truth

A GitHub issue can be incomplete, misleading, duplicated, outdated, or simply wrong. During an agent conversation, the team may discover that the reported issue is not the real problem, that the solution belongs elsewhere, or that no code change is needed.

Because of that, this project does not treat issues as mandatory workflow anchors. Issue creation, issue closing, and PR creation should stay explicit or semi-automated, not fully automatic.

### Long agent sessions forget Git conventions

Prompt instructions and skill files help, but long conversations drift. The agent can forget branch naming style, commit message style, commit size expectations, or how previous commits in the repository were written.

This extension should inject fresh Git context into the agent workflow repeatedly instead of relying only on memory.

### AI-generated changes can become too broad

Agents often keep editing without committing at good boundaries. By the time the user asks for a commit, unrelated fixes, refactors, chores, and feature work may be tangled together.

This extension should encourage task-level work tracking through a workspace-local `docs/task.md` ledger and help the agent notice when the current diff has grown too broad.

### Rules should be enforced by software, not vibes

The agent may generate code, commit messages, and PR text, but quality gates should be enforced by deterministic tools where possible.

Before commit or PR steps, the workflow should support test, lint, format, typecheck, and commit message lint commands. The extension should make these gates part of the workflow rather than optional reminders.

### Commit history should stay readable

A write-ahead stream of tiny agent commits is not always the desired history. The preferred style for this project is clean, reviewable commits:

- Combine similar changes.
- Amend small fixes into the related commit.
- Squash noisy follow-up commits when they belong together.
- Use history rewrite intentionally, with explicit user confirmation.
- Rework from a previous clean commit when the current approach is wrong.

### Destructive Git operations need guardrails

Commands such as hard reset, clean, force push, branch deletion, rebase, and squash can be useful, but they are risky. The extension should intercept dangerous operations and require explicit confirmation.

## Design intent

`pi-git-workflow` separates responsibility into three layers:

1. Pi extension
   - Inject Git context.
   - Guard dangerous commands.
   - Track task ledger state.
   - Run quality gates.
   - Expose workflow commands.

2. Existing skills
   - Generate issue text, commit messages, and PR descriptions.
   - Preserve project-specific writing conventions.
   - Stay human-triggered or extension-orchestrated.

3. External tools
   - Git, test runners, linters, formatters, typecheckers, and commit message linters enforce rules.
   - GitHub or MCP integrations may be added later, but they are not the core safety model.

## Initial scope

- Detect Git repository and current branch.
- Protect default branches from direct coding work.
- Inject recent Git style context before agent work.
- Block or confirm dangerous Git commands.
- Create and maintain `docs/task.md` in each workspace.
- Provide commands for status, task ledger, checks, and commit preparation.
- Keep issue and PR operations explicit.

## Non-goals

- Fully automatic issue-to-PR pipeline.
- Automatic issue closing.
- Automatic force push or history rewrite.
- Replacing project test/lint tools.
- Forcing one global commit convention across all repositories.

## Package usage

During development:

```bash
pi -e ~/Tools/pi-git-workflow
```

After publishing or installing as a local package:

```bash
pi install ~/Tools/pi-git-workflow
```

Pi discovers the extension from `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/git-workflow/index.ts"]
  }
}
```
