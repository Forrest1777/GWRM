import test from "node:test";
import assert from "node:assert/strict";
import { parseGutOutput } from "../src/gut-runner.mjs";

const success = `Scripts: 130\nTests: 1375\nPassing Tests: 1375\nFailing Tests: 0\nAsserts: 7070\nWarnings: 1\nErrors: 0`;

test("accept real successful GUT result", () => {
  const result = parseGutOutput(success, "", 0, false);
  assert.equal(result.passed, true);
  assert.equal(result.counts.tests, 1375);
});

test("reject exit code zero with no tests", () => {
  const result = parseGutOutput("Some GUT class_names have not been imported.", "", 0, false);
  assert.equal(result.passed, false);
  assert.ok(result.fatal_patterns.length > 0);
});

test("reject failing tests", () => {
  const result = parseGutOutput("Scripts: 1\nTests: 2\nPassing Tests: 1\nFailing Tests: 1\nAsserts: 3\nErrors: 0", "", 0, false);
  assert.equal(result.passed, false);
});
