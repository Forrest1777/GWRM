import path from "node:path";

const WORKTREE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validateWorktreeName(name) {
  if (typeof name !== "string" || !WORKTREE_RE.test(name)) {
    throw new Error("Invalid worktree_name. Use only letters, numbers, dots, underscores, and hyphens.");
  }
  return name;
}

export function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWorktreePaths(name, config) {
  const safeName = validateWorktreeName(name);
  const hostPath = path.resolve(config.paths.windowsWorktreesRoot, safeName);
  if (!isInside(config.paths.windowsWorktreesRoot, hostPath)) throw new Error("Worktree is outside the allowed root.");
  const containerPath = `${config.paths.containerWorktreesRoot}/${safeName}`;
  return { name: safeName, hostPath, containerPath };
}

export function validateResPath(value, allowedRoot, label = "res_path") {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  const root = allowedRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized.startsWith("res://")) throw new Error(`${label} must start with res://.`);
  if (normalized.includes("..")) throw new Error(`${label} must not contain '..'.`);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) throw new Error(`${label} is outside the allowed root: ${root}.`);
  return normalized;
}
