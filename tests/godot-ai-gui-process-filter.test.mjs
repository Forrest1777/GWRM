import test from "node:test";
import assert from "node:assert/strict";

import {
  godotGuiProcessNameForExecutable,
  godotGuiProcessNamesForExecutable,
  godotProcessNamesForExecutable,
  isConfiguredGodotProcess,
  isConfiguredGodotGuiProcess,
} from "../src/session-manager.mjs";
import { buildWindowsProcessPathProbeScript } from "../src/process-utils.mjs";

const configured =
  "E:\\dev\\IDE\\Godot_v4.7.2-stable_win64\\Godot_v4.7.2-stable_win64_console.exe";
const guiName = "Godot_v4.7.2-stable_win64.exe";
const consoleName = "Godot_v4.7.2-stable_win64_console.exe";
const worktree =
  "E:\\dev\\ai_agents\\hermes\\workspace\\skill_system_framework\\.worktrees\\t_3ac8e309";

function consoleRow(pid = 400) {
  return {
    pid,
    name: consoleName,
    command_line:
      `"E:\\dev\\IDE\\Godot_v4.7.2-stable_win64\\${consoleName}" -e --path "${worktree}"`,
  };
}

function guiRow(pid = 401) {
  return {
    pid,
    name: guiName,
    command_line:
      `"E:\\dev\\IDE\\Godot_v4.7.2-stable_win64\\${guiName}" -e --path "${worktree}"`,
  };
}

test("configured console executable derives the real GUI executable", () => {
  assert.equal(
    godotGuiProcessNameForExecutable(configured),
    guiName.toLowerCase(),
  );
  assert.deepEqual(
    godotGuiProcessNamesForExecutable(configured),
    [guiName.toLowerCase()],
  );
});

test("broad Godot ownership still recognizes wrapper and GUI", () => {
  assert.deepEqual(
    godotProcessNamesForExecutable(configured).sort(),
    [consoleName.toLowerCase(), guiName.toLowerCase()].sort(),
  );
  assert.equal(isConfiguredGodotProcess(consoleRow(), configured), true);
  assert.equal(isConfiguredGodotProcess(guiRow(), configured), true);
});

test("console wrapper plus its main GUI collapses to one GUI candidate", () => {
  const rows = [consoleRow(410), guiRow(411)];

  const guiCandidates = rows.filter((row) =>
    isConfiguredGodotGuiProcess(row, configured),
  );

  assert.deepEqual(guiCandidates.map((row) => row.pid), [411]);
});

test("console wrapper is never eligible as godot_ai_gui_pid", () => {
  assert.equal(
    isConfiguredGodotGuiProcess(consoleRow(420), configured),
    false,
  );
  assert.equal(
    isConfiguredGodotGuiProcess(guiRow(421), configured),
    true,
  );
});

test("two real GUI processes remain ambiguous and therefore fail closed upstream", () => {
  const rows = [consoleRow(430), guiRow(431), guiRow(432)];

  const guiCandidates = rows.filter((row) =>
    isConfiguredGodotGuiProcess(row, configured),
  );

  assert.deepEqual(guiCandidates.map((row) => row.pid), [431, 432]);
  assert.equal(guiCandidates.length, 2);
});

test("non-Godot helper referencing the worktree is rejected", () => {
  const helper = {
    pid: 440,
    name: "powershell.exe",
    command_line: `powershell.exe -Command Write-Host "${worktree}"`,
  };

  assert.equal(isConfiguredGodotProcess(helper, configured), false);
  assert.equal(isConfiguredGodotGuiProcess(helper, configured), false);
});

test("GUI process probe allowlist excludes the console wrapper", () => {
  const guiNames = godotGuiProcessNamesForExecutable(configured);
  const probe = buildWindowsProcessPathProbeScript(worktree, guiNames);

  assert.match(probe, /godot_v4\.7\.2-stable_win64\.exe/i);
  assert.doesNotMatch(probe, /godot_v4\.7\.2-stable_win64_console\.exe/i);
  assert.match(probe, /\$allowed -contains \$_.Name\.ToLowerInvariant\(\)/);
});