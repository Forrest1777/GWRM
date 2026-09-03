import test from "node:test";
import assert from "node:assert/strict";
import { supervisorStartupTimeoutMs } from "../src/startup-policy.mjs";

function config(shutdownTimeoutSeconds = 10) {
  return { service: { shutdownTimeoutSeconds } };
}

test("supervisor startup timeout has a safe floor without persisted states", () => {
  assert.equal(supervisorStartupTimeoutMs(config(10), 0), 60_000);
});

test("supervisor startup timeout grows with persisted states for reconciliation", () => {
  assert.equal(supervisorStartupTimeoutMs(config(10), 1), 60_000);
  assert.equal(supervisorStartupTimeoutMs(config(10), 3), 75_000);
  assert.equal(supervisorStartupTimeoutMs(config(10), 7), 135_000);
});

test("supervisor startup timeout remains bounded", () => {
  assert.equal(supervisorStartupTimeoutMs(config(120), 100), 600_000);
});
