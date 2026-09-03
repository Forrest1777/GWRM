import test from "node:test";
import assert from "node:assert/strict";
import { parseGutJunitXml, parseGutOutput } from "../src/gut-runner.mjs";

const success = `Scripts: 130\nTests: 1375\nPassing Tests: 1375\nFailing Tests: 0\nAsserts: 7070\nWarnings: 1\nErrors: 0`;

const successfulJunit = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="GutTests" failures="0" tests="4">
  <testsuite name="res://tests/test_one.gd" tests="3" failures="0" skipped="1">
    <testcase name="test_pass_one" assertions="2" status="pass" classname="res://tests/test_one.gd"></testcase>
    <testcase name="test_pass_two" assertions="3" status="pass" classname="res://tests/test_one.gd"></testcase>
    <testcase name="test_pending" assertions="0" status="pending" classname="res://tests/test_one.gd"><skipped message="pending">later</skipped></testcase>
  </testsuite>
  <testsuite name="res://tests/test_two.gd" tests="1" failures="0" skipped="0">
    <testcase name="test_pass_three" assertions="4" status="pass" classname="res://tests/test_two.gd"></testcase>
  </testsuite>
</testsuites>`;

test("accept real successful legacy GUT result", () => {
  const result = parseGutOutput(success, "", 0, false);
  assert.equal(result.passed, true);
  assert.equal(result.counts.tests, 1375);
  assert.equal(result.result_source, "stdout_fallback");
});

test("accept compact GUT ratio output with ANSI and CRLF", () => {
  const output = "\u001b[32m1360/1360 tests passed\u001b[0m\r\n6993 asserts\r\nErrors: 0";
  const result = parseGutOutput(output, "", 0, false);
  assert.equal(result.passed, true);
  assert.equal(result.counts.tests, 1360);
  assert.equal(result.counts.passing_tests, 1360);
  assert.equal(result.counts.asserts, 6993);
});

test("parse successful GUT JUnit result", () => {
  const result = parseGutJunitXml(successfulJunit, 0, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.counts, {
    scripts: 2,
    tests: 4,
    passing_tests: 3,
    failing_tests: 0,
    pending_tests: 1,
    asserts: 9,
    errors: 0,
    warnings: null,
  });
  assert.equal(result.result_source, "junit_xml");
});

test("reject JUnit result with a failing test and expose failure", () => {
  const xml = `<?xml version="1.0"?><testsuites failures="1" tests="2">
    <testsuite name="res://tests/test_fail.gd" tests="2" failures="1" skipped="0">
      <testcase name="test_ok" assertions="1" status="pass"></testcase>
      <testcase name="test_bad" assertions="1" status="fail"><failure message="failed">Expected 1 &lt; 0</failure></testcase>
    </testsuite>
  </testsuites>`;
  const result = parseGutJunitXml(xml, 1, false);
  assert.equal(result.passed, false);
  assert.equal(result.counts.failing_tests, 1);
  assert.equal(result.failure[0].details, "Expected 1 < 0");
});

test("reject exit code zero with no tests", () => {
  const result = parseGutOutput("Some GUT class_names have not been imported.", "", 0, false);
  assert.equal(result.passed, false);
  assert.ok(result.fatal_patterns.length > 0);
});

test("reject JUnit with zero tests", () => {
  const result = parseGutJunitXml('<?xml version="1.0"?><testsuites failures="0" tests="0"></testsuites>', 0, false);
  assert.equal(result.passed, false);
  assert.equal(result.counts.tests, 0);
});

test("reject failing tests in legacy output", () => {
  const result = parseGutOutput("Scripts: 1\nTests: 2\nPassing Tests: 1\nFailing Tests: 1\nAsserts: 3\nErrors: 0", "", 0, false);
  assert.equal(result.passed, false);
});

test("generic SCRIPT ERROR does not override otherwise green fallback counts", () => {
  const result = parseGutOutput(`${success}\nSCRIPT ERROR: expected error captured by GUT`, "", 0, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.fatal_patterns, []);
});

test("reject malformed JUnit XML", () => {
  assert.throws(() => parseGutJunitXml("not xml", 0, false), /malformado/);
});

test("timeout always rejects green JUnit", () => {
  const result = parseGutJunitXml(successfulJunit, 0, true);
  assert.equal(result.passed, false);
});
