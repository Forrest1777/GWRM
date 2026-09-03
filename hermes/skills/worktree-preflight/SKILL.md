---
name: worktree-preflight
description: Fully validates a dispatcher-provisioned Kanban worktree before GWRM activation or project edits.
---

# Worktree Preflight

Run this at the beginning of any task that may technically read, edit, test, or validate files in a worktree. The dispatcher must already have materialized the workspace. This skill never creates, repairs, moves, or removes worktrees.

## Invariants

- `HERMES_KANBAN_WORKSPACE` is required and authoritative.
- The worktree must be under `/workspace`.
- Git toplevel must exactly match the resolved workspace.
- The worktree must share the expected repository Git common directory.
- Branch and `HEAD` must match the task/base contract.
- Initial Git state must be clean.
- Sparse checkout, sparse index, and `SKIP_WORKTREE` are forbidden.
- Every `git ls-files` path must physically exist.
- `project.godot` and `AGENTS.md` must exist.
- Failure means `BLOCKED_OPERATIONAL`; do not attempt to repair the workspace.

## Execution

```bash
./scripts/worktree-preflight.sh \
  --workspace "$HERMES_KANBAN_WORKSPACE" \
  --expected-branch "${HERMES_KANBAN_BRANCH:-}" \
  --base-ref "<task-base-ref>"
```

Capture the JSON output. Proceed to GWRM activation only when `passed` is true.
