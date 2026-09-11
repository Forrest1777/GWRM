import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GODOT_AI_EDITOR_SETTINGS_INVALID,
  GODOT_AI_EDITOR_SETTINGS_MISSING,
  GODOT_AI_HTTP_PORT_KEY,
  GODOT_AI_WS_PORT_KEY,
  GodotAiEditorSettings,
  applyPorts,
  readPorts,
  resolveDefaultPath,
} from "../src/godot-ai-editor-settings.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, "fixtures", "editor_settings_godot_ai.tres");

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "godot-ai-editor-settings-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function copyFixture(destPath) {
  await fs.copyFile(FIXTURE_PATH, destPath);
  return destPath;
}

async function readRaw(filePath) {
  return await fs.readFile(filePath, "utf8");
}

test("resolveDefaultPath uses APPDATA/Godot/editor_settings-4.tres", () => {
  const explicit = resolveDefaultPath({ appdataDir: "C:\\\\Users\\\\test\\\\AppData\\\\Roaming" });
  assert.equal(
    explicit,
    path.join("C:\\\\Users\\\\test\\\\AppData\\\\Roaming", "Godot", "editor_settings-4.tres"),
  );

  const previous = process.env.APPDATA;
  process.env.APPDATA = "D:\\\\RoamingAppData";
  try {
    assert.equal(
      resolveDefaultPath(),
      path.join("D:\\\\RoamingAppData", "Godot", "editor_settings-4.tres"),
    );
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
  }

  assert.equal(typeof GodotAiEditorSettings.resolveDefaultPath, "function");
  assert.equal(
    GodotAiEditorSettings.resolveDefaultPath({ appdataDir: "/tmp/appdata" }),
    path.join("/tmp/appdata", "Godot", "editor_settings-4.tres"),
  );
});

test("applyPorts fails closed when file is missing", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "missing.tres");
    const result = await applyPorts({
      settingsPath,
      httpPort: 18001,
      wsPort: 19501,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, GODOT_AI_EDITOR_SETTINGS_MISSING);
    assert.match(String(result.message), /not found/i);
  });
});

test("applyPorts rejects invalid EditorSettings text", async () => {
  await withTempDir(async (dir) => {
    const noMarkers = path.join(dir, "no-markers.tres");
    await fs.writeFile(noMarkers, "not a godot resource\n", "utf8");
    const invalidMarkers = await applyPorts({
      settingsPath: noMarkers,
      httpPort: 18001,
      wsPort: 19501,
    });
    assert.equal(invalidMarkers.ok, false);
    assert.equal(invalidMarkers.code, GODOT_AI_EDITOR_SETTINGS_INVALID);

    const binaryPath = path.join(dir, "binary.tres");
    await fs.writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]));
    const invalidUtf8 = await applyPorts({
      settingsPath: binaryPath,
      httpPort: 18001,
      wsPort: 19501,
    });
    assert.equal(invalidUtf8.ok, false);
    assert.equal(invalidUtf8.code, GODOT_AI_EDITOR_SETTINGS_INVALID);

    const badPort = path.join(dir, "ports.tres");
    await copyFixture(badPort);
    const portResult = await applyPorts({
      settingsPath: badPort,
      httpPort: 80,
      wsPort: 19501,
    });
    assert.equal(portResult.ok, false);
    assert.equal(portResult.code, GODOT_AI_EDITOR_SETTINGS_INVALID);
  });
});

test("applyPorts inserts missing godot_ai keys after [resource]", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "insert.tres");
    await copyFixture(settingsPath);
    const before = await readRaw(settingsPath);

    const result = await applyPorts({
      settingsPath,
      httpPort: 18011,
      wsPort: 19511,
    });
    assert.equal(result.ok, true);
    assert.equal(result.path, settingsPath);
    assert.equal(result.http_port, 18011);
    assert.equal(result.ws_port, 19511);

    const after = await readRaw(settingsPath);
    const lines = after.split(/\r?\n/);
    const resourceIndex = lines.findIndex((line) => line.trim() === "[resource]");
    assert.ok(resourceIndex >= 0);
    assert.equal(lines[resourceIndex + 1], `${GODOT_AI_HTTP_PORT_KEY} = 18011`);
    assert.equal(lines[resourceIndex + 2], `${GODOT_AI_WS_PORT_KEY} = 19511`);

    assert.match(after, /interface\/editor\/single_window_mode = true/);
    assert.match(after, /network\/connection\/network_mode = 1/);
    assert.match(after, /docks\/filesystem\/thumbnail_size = 64/);
    assert.ok(after.includes("[gd_resource type=\"EditorSettings\" format=3]"));
    assert.notEqual(before, after);
  });
});

test("applyPorts replaces existing godot_ai keys and preserves unrelated settings", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "replace.tres");
    const seed = [
      "[gd_resource type=\"EditorSettings\" format=3]",
      "",
      "[resource]",
      "interface/editor/single_window_mode = true",
      "godot_ai/http_port = 8000",
      "network/connection/network_mode = 1",
      "godot_ai/ws_port = 9500",
      "docks/filesystem/thumbnail_size = 64",
      "metadata/godot_ai/http_port = \"ignore-me\"",
      "",
    ].join("\n");
    await fs.writeFile(settingsPath, seed, "utf8");

    const result = await applyPorts({
      settingsPath,
      httpPort: 18022,
      wsPort: 19522,
    });
    assert.equal(result.ok, true);
    assert.equal(result.http_port, 18022);
    assert.equal(result.ws_port, 19522);

    const after = await readRaw(settingsPath);
    assert.match(after, /^godot_ai\/http_port = 18022$/m);
    assert.match(after, /^godot_ai\/ws_port = 19522$/m);
    assert.doesNotMatch(after, /^godot_ai\/http_port = 8000$/m);
    assert.doesNotMatch(after, /^godot_ai\/ws_port = 9500$/m);

    // Unrelated settings and non-assignment metadata lines stay put.
    assert.match(after, /^interface\/editor\/single_window_mode = true$/m);
    assert.match(after, /^network\/connection\/network_mode = 1$/m);
    assert.match(after, /^docks\/filesystem\/thumbnail_size = 64$/m);
    assert.match(after, /^metadata\/godot_ai\/http_port = "ignore-me"$/m);

    // Keys stay in their original positions (not re-inserted after [resource]).
    const lines = after.split(/\r?\n/);
    assert.equal(lines[3], "interface/editor/single_window_mode = true");
    assert.equal(lines[4], "godot_ai/http_port = 18022");
    assert.equal(lines[5], "network/connection/network_mode = 1");
    assert.equal(lines[6], "godot_ai/ws_port = 19522");
  });
});

test("readPorts round-trip after applyPorts", async () => {
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "roundtrip.tres");
    await copyFixture(settingsPath);

    const applied = await GodotAiEditorSettings.applyPorts({
      settingsPath,
      httpPort: 18033,
      wsPort: 19533,
    });
    assert.equal(applied.ok, true);

    const read = await readPorts({ settingsPath });
    assert.equal(read.ok, true);
    assert.equal(read.http_port, 18033);
    assert.equal(read.ws_port, 19533);

    const missing = await readPorts({
      settingsPath: path.join(dir, "nope.tres"),
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, GODOT_AI_EDITOR_SETTINGS_MISSING);

    // Fixture without keys must not fall back to 8000/9500.
    const barePath = path.join(dir, "bare.tres");
    await copyFixture(barePath);
    const bare = await readPorts({ settingsPath: barePath });
    assert.equal(bare.ok, false);
    assert.equal(bare.code, GODOT_AI_EDITOR_SETTINGS_INVALID);
    assert.notEqual(bare.http_port, 8000);
    assert.notEqual(bare.ws_port, 9500);
  });
});

test("tracked fixture is not mutated by write tests", async () => {
  const before = await fs.readFile(FIXTURE_PATH);
  await withTempDir(async (dir) => {
    const settingsPath = path.join(dir, "copy.tres");
    await copyFixture(settingsPath);
    const result = await applyPorts({
      settingsPath,
      httpPort: 18044,
      wsPort: 19544,
    });
    assert.equal(result.ok, true);
  });
  const after = await fs.readFile(FIXTURE_PATH);
  assert.deepEqual(after, before);
  const text = before.toString("utf8");
  assert.match(text, /\[gd_resource/);
  assert.match(text, /\[resource\]/);
  assert.doesNotMatch(text, /godot_ai\/http_port/);
  assert.doesNotMatch(text, /godot_ai\/ws_port/);
});
