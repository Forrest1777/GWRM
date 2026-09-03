import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      result.push(...await walk(fullPath));
    } else if (entry.isFile() && fullPath.endsWith(".mjs")) {
      result.push(fullPath);
    }
  }
  return result;
}

for (const file of await walk(process.cwd())) {
  const check = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (check.status !== 0) process.exit(check.status || 1);
}

console.log("JavaScript syntax is valid.");
