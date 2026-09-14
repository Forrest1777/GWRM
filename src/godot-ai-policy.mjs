// Canonical Godot AI integration policy for GWRM.
// TODO5 / POLISH_DEBUG: one owner for package pin, process identity and
// bounded session-readiness cadence.

export const GODOT_AI_VERSION = "4.1.0";
export const GODOT_AI_PACKAGE_SPEC = `godot-ai==${GODOT_AI_VERSION}`;
export const GODOT_AI_SESSION_POLL_INTERVAL_MS = 250;
export const GODOT_AI_MIN_SESSION_READINESS_TIMEOUT_MS = 1_000;

function processExecutableBasename(value) {
  const text = String(value || "").trim().replace(/^"|"$/g, "");
  if (!text) return "";
  return text.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || "";
}

export function godotGuiProcessNameForExecutable(godotExecutable) {
  const configured = processExecutableBasename(godotExecutable);
  if (!configured) return "";

  for (const suffix of ["_console.exe", ".console.exe", " console.exe", "console.exe"]) {
    if (configured.endsWith(suffix)) {
      return `${configured.slice(0, -suffix.length)}.exe`;
    }
  }

  return configured;
}

export function godotGuiProcessNamesForExecutable(godotExecutable) {
  const guiName = godotGuiProcessNameForExecutable(godotExecutable);
  return guiName ? [guiName] : [];
}

export function godotProcessNamesForExecutable(godotExecutable) {
  const configured = processExecutableBasename(godotExecutable);
  if (!configured) return [];

  const names = new Set([configured]);
  const guiName = godotGuiProcessNameForExecutable(godotExecutable);
  if (guiName) names.add(guiName);

  return [...names];
}

function processMatchesAllowedNames(processInfo, allowedNames) {
  const allowed = new Set((allowedNames || []).map((name) => String(name).toLowerCase()));
  if (allowed.size === 0) return false;

  const byName = processExecutableBasename(processInfo?.name);
  if (byName && allowed.has(byName)) return true;

  const commandLine = String(processInfo?.command_line || "").trim();
  if (!commandLine) return false;

  const match = commandLine.match(/^"([^"]+)"|^(\S+)/);
  const executable = processExecutableBasename(match?.[1] || match?.[2] || "");
  return Boolean(executable && allowed.has(executable));
}

export function isConfiguredGodotProcess(processInfo, godotExecutable) {
  return processMatchesAllowedNames(
    processInfo,
    godotProcessNamesForExecutable(godotExecutable),
  );
}

export function isConfiguredGodotGuiProcess(processInfo, godotExecutable) {
  return processMatchesAllowedNames(
    processInfo,
    godotGuiProcessNamesForExecutable(godotExecutable),
  );
}
