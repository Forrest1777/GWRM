import test from "node:test";
import assert from "node:assert/strict";
import { buildWindowsProcessPathProbeScript } from "../src/process-utils.mjs";

test("PowerShell process probe never emits an operator followed by a statement separator", () => {
  const script = buildWindowsProcessPathProbeScript(
    "C:\\workspaces\\project\\.worktrees\\t_123",
    ["Godot_console.exe"],
  );
  assert.equal(script.includes("-and;"), false);
  assert.equal(script.includes("-or;"), false);
  assert.match(script, /Where-Object \{ \(\$_\.ProcessId -ne \$PID\).*\}/);
  assert.match(script, /\$null -ne \$_\.CommandLine/);
});

test("PowerShell process probe escapes apostrophes", () => {
  const script = buildWindowsProcessPathProbeScript("C:\\workspaces\\o'hare", ["Godot.exe"]);
  assert.match(script, /o''hare/);
  assert.match(script, /ConvertFrom-Json/);
});
