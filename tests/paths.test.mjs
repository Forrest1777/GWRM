import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isInside, resolveWorktreePaths, validateResPath, validateWorktreeName } from "../src/paths.mjs";

test("worktree names and paths stay inside configured roots", () => {
  assert.equal(validateWorktreeName("t_example-1"), "t_example-1");
  assert.throws(() => validateWorktreeName("../escape"));
  const root = path.resolve("/tmp/gwrm-test-root");
  const config = { paths: { windowsWorktreesRoot: root, containerWorktreesRoot: "/workspace/project/.worktrees" } };
  const resolved = resolveWorktreePaths("t_example", config);
  assert.equal(resolved.hostPath, path.join(root, "t_example"));
  assert.equal(resolved.containerPath, "/workspace/project/.worktrees/t_example");
  assert.equal(isInside(root, resolved.hostPath), true);
});

test("res paths are constrained to the allowed root", () => {
  assert.equal(validateResPath("res://tests/unit", "res://tests"), "res://tests/unit");
  assert.throws(() => validateResPath("res://other", "res://tests"));
  assert.throws(() => validateResPath("res://tests/../secret", "res://tests"));
});
