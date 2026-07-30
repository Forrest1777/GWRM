import test from "node:test";
import assert from "node:assert/strict";

import { buildWindowsProcessPathProbeScript } from "../src/process-utils.mjs";

test("probe PowerShell nao gera operador -and seguido de separador", () => {
  const script = buildWindowsProcessPathProbeScript(
    "E:\\dev\\ai_agents\\hermes\\workspace\\skill_system_framework\\.worktrees\\t_123",
    ["Godot_v4.6-stable_win64_console.exe"],
  );

  assert.equal(script.includes("-and;"), false);
  assert.equal(script.includes("-or;"), false);
  assert.match(script, /Where-Object \{ \(\$_\.ProcessId -ne \$PID\).*\}/);
  assert.match(script, /\$null -ne \$_\.CommandLine/);
});

test("probe escapa apostrofos em paths e nomes serializados", () => {
  const script = buildWindowsProcessPathProbeScript("E:\\repo\\o'hare", ["Godot.exe"]);
  assert.match(script, /o''hare/);
  assert.match(script, /ConvertFrom-Json/);
});
