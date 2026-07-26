import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveWorktreePaths, validateResPath, validateWorktreeName } from "../src/paths.mjs";

const config = {
  paths: {
    windowsWorktreesRoot: path.resolve("/tmp/worktrees"),
    containerWorktreesRoot: "/workspace/kanban-worktrees",
  },
};

test("resolve worktree paths", () => {
  const result = resolveWorktreePaths("t_abc-123", config);
  assert.equal(result.containerPath, "/workspace/kanban-worktrees/t_abc-123");
  assert.equal(result.hostPath, path.resolve("/tmp/worktrees/t_abc-123"));
});

test("reject path traversal in worktree name", () => {
  assert.throws(() => validateWorktreeName("../escape"));
  assert.throws(() => validateWorktreeName("a/b"));
});

test("validate res path", () => {
  assert.equal(validateResPath("res://tests/skill_system/ai_system/unit", "res://tests/skill_system/ai_system"), "res://tests/skill_system/ai_system/unit");
  assert.throws(() => validateResPath("res://other", "res://tests/skill_system/ai_system"));
});
