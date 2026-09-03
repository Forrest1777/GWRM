import { readFile } from "node:fs/promises";
import path from "node:path";

const [configPath, keyPath] = process.argv.slice(2);
if (!configPath || !keyPath) process.exit(2);
const config = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
let value = config;
for (const key of keyPath.split(".")) value = value?.[key];
if (value === undefined || value === null || typeof value === "object") process.exit(3);
process.stdout.write(String(value));
