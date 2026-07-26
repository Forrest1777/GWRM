import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") result.push(...await walk(full));
    else if (entry.isFile() && full.endsWith(".mjs")) result.push(full);
  }
  return result;
}

for (const file of await walk(process.cwd())) {
  const check = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (check.status !== 0) process.exit(check.status || 1);
}
console.log("Sintaxe JavaScript valida.");
