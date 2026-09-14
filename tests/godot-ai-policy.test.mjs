import test from "node:test";
import assert from "node:assert/strict";

import {
  GODOT_AI_VERSION,
  GODOT_AI_PACKAGE_SPEC,
  GODOT_AI_SESSION_POLL_INTERVAL_MS,
  GODOT_AI_MIN_SESSION_READINESS_TIMEOUT_MS,
  godotGuiProcessNameForExecutable,
  godotProcessNamesForExecutable,
  isConfiguredGodotGuiProcess,
} from "../src/godot-ai-policy.mjs";

const configured =
  "E:\\dev\\IDE\\Godot_v4.7.2-stable_win64\\Godot_v4.7.2-stable_win64_console.exe";

test("TODO5 canonical Godot AI package pin is 4.1.0", () => {
  assert.equal(GODOT_AI_VERSION, "4.1.0");
  assert.equal(GODOT_AI_PACKAGE_SPEC, "godot-ai==4.1.0");
});

test("session readiness policy remains bounded and short cadence", () => {
  assert.equal(GODOT_AI_SESSION_POLL_INTERVAL_MS, 250);
  assert.equal(GODOT_AI_MIN_SESSION_READINESS_TIMEOUT_MS, 1000);
});

test("console wrapper and GUI identity are owned by one policy module", () => {
  assert.equal(
    godotGuiProcessNameForExecutable(configured),
    "godot_v4.7.2-stable_win64.exe",
  );
  assert.deepEqual(
    godotProcessNamesForExecutable(configured).sort(),
    [
      "godot_v4.7.2-stable_win64.exe",
      "godot_v4.7.2-stable_win64_console.exe",
    ].sort(),
  );

  assert.equal(
    isConfiguredGodotGuiProcess(
      {
        name: "Godot_v4.7.2-stable_win64_console.exe",
        command_line: `"${configured}" -e --path "E:\\tmp\\project"`,
      },
      configured,
    ),
    false,
  );
});
