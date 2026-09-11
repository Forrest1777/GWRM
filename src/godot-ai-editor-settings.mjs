import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const GODOT_AI_HTTP_PORT_KEY = "godot_ai/http_port";
export const GODOT_AI_WS_PORT_KEY = "godot_ai/ws_port";

export const GODOT_AI_EDITOR_SETTINGS_MISSING = "GODOT_AI_EDITOR_SETTINGS_MISSING";
export const GODOT_AI_EDITOR_SETTINGS_INVALID = "GODOT_AI_EDITOR_SETTINGS_INVALID";

const PORT_MIN = 1024;
const PORT_MAX = 65535;
const GD_RESOURCE_MARKER = "[gd_resource";
const RESOURCE_SECTION_RE = /^\s*\[resource\]\s*$/;

function failure(code, message) {
  return { ok: false, code, message };
}

function successApply(settingsPath, httpPort, wsPort) {
  return {
    ok: true,
    path: settingsPath,
    http_port: httpPort,
    ws_port: wsPort,
  };
}

function successRead(httpPort, wsPort) {
  return {
    ok: true,
    http_port: httpPort,
    ws_port: wsPort,
  };
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= PORT_MIN && value <= PORT_MAX;
}

function requireSettingsPath(settingsPath) {
  if (typeof settingsPath !== "string" || settingsPath.trim() === "") {
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      "settingsPath is required.",
    );
  }
  return null;
}

function validatePorts(httpPort, wsPort) {
  if (!isValidPort(httpPort) || !isValidPort(wsPort)) {
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      `httpPort and wsPort must be integers in ${PORT_MIN}-${PORT_MAX}.`,
    );
  }
  return null;
}

function decodeUtf8Strict(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function hasRequiredMarkers(text) {
  return text.includes(GD_RESOURCE_MARKER) && text.split(/\r?\n/).some((line) => RESOURCE_SECTION_RE.test(line));
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === "\r" && text[i + 1] !== "\n") {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length || text.length === 0) {
    lines.push(text.slice(start));
  }
  return lines;
}

function lineEndingOf(line) {
  if (line.endsWith("\r\n")) return "\r\n";
  if (line.endsWith("\n")) return "\n";
  if (line.endsWith("\r")) return "\r";
  return null;
}

function stripEnding(line) {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n") || line.endsWith("\r")) return line.slice(0, -1);
  return line;
}

function assignmentPattern(key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(\\s*${escaped}\\s*=\\s*)(-?\\d+)(\\s*)$`);
}

function formatAssignment(key, port, ending) {
  return `${key} = ${port}${ending ?? ""}`;
}

function parseAssignmentValue(line, key) {
  const body = stripEnding(line);
  const match = body.match(assignmentPattern(key));
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isInteger(value)) return null;
  return value;
}

function isAssignmentLine(line, key) {
  return parseAssignmentValue(line, key) !== null;
}

function replaceAssignment(line, key, port) {
  const ending = lineEndingOf(line) ?? "";
  const body = stripEnding(line);
  const match = body.match(assignmentPattern(key));
  if (!match) return line;
  return `${match[1]}${port}${match[3]}${ending}`;
}

function detectDefaultEnding(lines) {
  for (const line of lines) {
    const ending = lineEndingOf(line);
    if (ending) return ending;
  }
  return "\n";
}

function upsertPortLines(text, httpPort, wsPort) {
  const lines = splitLines(text);
  if (lines.length === 0) {
    return { ok: false, code: GODOT_AI_EDITOR_SETTINGS_INVALID, message: "EditorSettings file is empty." };
  }

  let resourceIndex = -1;
  let httpIndex = -1;
  let wsIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const body = stripEnding(lines[i]);
    if (resourceIndex < 0 && RESOURCE_SECTION_RE.test(body)) {
      resourceIndex = i;
    }
    if (httpIndex < 0 && isAssignmentLine(lines[i], GODOT_AI_HTTP_PORT_KEY)) {
      httpIndex = i;
    }
    if (wsIndex < 0 && isAssignmentLine(lines[i], GODOT_AI_WS_PORT_KEY)) {
      wsIndex = i;
    }
  }

  if (resourceIndex < 0) {
    return {
      ok: false,
      code: GODOT_AI_EDITOR_SETTINGS_INVALID,
      message: "EditorSettings file lacks a [resource] section.",
    };
  }

  const ending = detectDefaultEnding(lines);
  const next = lines.slice();

  if (httpIndex >= 0) {
    next[httpIndex] = replaceAssignment(next[httpIndex], GODOT_AI_HTTP_PORT_KEY, httpPort);
  }
  if (wsIndex >= 0) {
    next[wsIndex] = replaceAssignment(next[wsIndex], GODOT_AI_WS_PORT_KEY, wsPort);
  }

  const insertions = [];
  if (httpIndex < 0) {
    insertions.push(formatAssignment(GODOT_AI_HTTP_PORT_KEY, httpPort, ending));
  }
  if (wsIndex < 0) {
    insertions.push(formatAssignment(GODOT_AI_WS_PORT_KEY, wsPort, ending));
  }

  if (insertions.length > 0) {
    // Insert missing keys immediately after the [resource] line.
    next.splice(resourceIndex + 1, 0, ...insertions);
  }

  // If the original text had no trailing newline on the final line, keep that property
  // only when we did not touch a final line that previously lacked an ending.
  return { ok: true, text: next.join("") };
}

async function readSettingsText(settingsPath) {
  let buffer;
  try {
    buffer = await fs.readFile(settingsPath);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return failure(
        GODOT_AI_EDITOR_SETTINGS_MISSING,
        `EditorSettings file not found: ${settingsPath}`,
      );
    }
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      `Failed to read EditorSettings file: ${error?.message || error}`,
    );
  }

  const text = decodeUtf8Strict(buffer);
  if (text == null) {
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      "EditorSettings file is not valid UTF-8 text.",
    );
  }

  if (!hasRequiredMarkers(text)) {
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      "EditorSettings file must contain [gd_resource] and [resource].",
    );
  }

  return { ok: true, text };
}

async function atomicWrite(settingsPath, text) {
  const dir = path.dirname(settingsPath);
  const base = path.basename(settingsPath);
  const token = randomBytes(8).toString("hex");
  const tempPath = path.join(dir, `.${base}.${process.pid}.${token}.tmp`);
  try {
    await fs.writeFile(tempPath, text, { encoding: "utf8", flag: "w" });
    await fs.rename(tempPath, settingsPath);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // best-effort cleanup only
    }
    throw error;
  }
}

/**
 * Default Windows-style EditorSettings path for Godot 4.7.2 pin.
 * Tests should pass appdataDir (or an explicit settingsPath) and never write real %APPDATA%.
 */
export function resolveDefaultPath({ appdataDir } = {}) {
  const root = appdataDir || process.env.APPDATA || "";
  return path.join(root, "Godot", "editor_settings-4.7.tres");
}

/**
 * Upsert godot_ai HTTP/WS port assignment lines into an existing EditorSettings text resource.
 * Does not create a full EditorSettings file from scratch.
 */
export async function applyPorts({ settingsPath, httpPort, wsPort } = {}) {
  const pathError = requireSettingsPath(settingsPath);
  if (pathError) return pathError;

  const portError = validatePorts(httpPort, wsPort);
  if (portError) return portError;

  const loaded = await readSettingsText(settingsPath);
  if (!loaded.ok) return loaded;

  const updated = upsertPortLines(loaded.text, httpPort, wsPort);
  if (!updated.ok) return updated;

  try {
    await atomicWrite(settingsPath, updated.text);
  } catch (error) {
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      `Failed to write EditorSettings file: ${error?.message || error}`,
    );
  }

  return successApply(settingsPath, httpPort, wsPort);
}

/**
 * Read godot_ai HTTP/WS ports from an existing EditorSettings text resource.
 * Fail-closed: never returns plugin defaults 8000/9500 when keys are absent.
 */
export async function readPorts({ settingsPath } = {}) {
  const pathError = requireSettingsPath(settingsPath);
  if (pathError) return pathError;

  const loaded = await readSettingsText(settingsPath);
  if (!loaded.ok) return loaded;

  const lines = splitLines(loaded.text);
  let httpPort = null;
  let wsPort = null;

  for (const line of lines) {
    if (httpPort == null) {
      const value = parseAssignmentValue(line, GODOT_AI_HTTP_PORT_KEY);
      if (value != null) httpPort = value;
    }
    if (wsPort == null) {
      const value = parseAssignmentValue(line, GODOT_AI_WS_PORT_KEY);
      if (value != null) wsPort = value;
    }
    if (httpPort != null && wsPort != null) break;
  }

  if (httpPort == null || wsPort == null) {
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      "EditorSettings file is missing godot_ai/http_port and/or godot_ai/ws_port.",
    );
  }

  if (!isValidPort(httpPort) || !isValidPort(wsPort)) {
    return failure(
      GODOT_AI_EDITOR_SETTINGS_INVALID,
      `EditorSettings godot_ai ports must be integers in ${PORT_MIN}-${PORT_MAX}.`,
    );
  }

  return successRead(httpPort, wsPort);
}

export const GodotAiEditorSettings = Object.freeze({
  resolveDefaultPath,
  applyPorts,
  readPorts,
  HTTP_PORT_KEY: GODOT_AI_HTTP_PORT_KEY,
  WS_PORT_KEY: GODOT_AI_WS_PORT_KEY,
  MISSING: GODOT_AI_EDITOR_SETTINGS_MISSING,
  INVALID: GODOT_AI_EDITOR_SETTINGS_INVALID,
});
