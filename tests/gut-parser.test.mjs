import test from "node:test";
import assert from "node:assert/strict";
import { parseGutJunitXml, parseGutOutput } from "../src/gut-runner.mjs";

test("JUnit parser accepts a non-empty passing GUT report", () => {
  const xml = `<?xml version="1.0"?><testsuites tests="2" failures="0" errors="0" skipped="0"><testsuite name="suite" tests="2" failures="0" errors="0" skipped="0"><testcase name="a" assertions="2" status="pass"></testcase><testcase name="b" assertions="1" status="pass"></testcase></testsuite></testsuites>`;
  const result = parseGutJunitXml(xml, 0, false);
  assert.equal(result.passed, true);
  assert.equal(result.counts.tests, 2);
  assert.equal(result.counts.asserts, 3);
});

test("text fallback requires tests and assertions and rejects fatal output", () => {
  const passing = parseGutOutput("3/3 tests passed\n5 asserts\nErrors: 0", "", 0, false);
  assert.equal(passing.passed, true);
  const fatal = parseGutOutput("3/3 tests passed\n5 asserts\nErrors: 0\nParse Error", "", 0, false);
  assert.equal(fatal.passed, false);
});
