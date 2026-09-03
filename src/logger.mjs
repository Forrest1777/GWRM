import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

function sanitize(value) {
  return String(value).replace(/[\r\n]+/g, " ");
}

function compactTime(iso) {
  return String(iso).slice(11, 19);
}

export class Logger {
  constructor(logDirectory) {
    this.logDirectory = logDirectory;
    this.mainLog = path.join(logDirectory, "gwrm.log");
  }

  async init() {
    await mkdir(this.logDirectory, { recursive: true });
  }

  async write(level, message, fields = {}) {
    const entry = {
      time: new Date().toISOString(),
      level,
      message: sanitize(message),
      ...fields,
    };
    const line = `${JSON.stringify(entry)}\n`;
    const worktree = sanitize(fields.worktree || "-");
    process.stderr.write(`[GWRM] ${compactTime(entry.time)} | ${worktree} | ${level.toUpperCase()} | ${entry.message}\n`);
    await appendFile(this.mainLog, line, "utf8").catch(() => {});
  }

  info(message, fields) { return this.write("info", message, fields); }
  warn(message, fields) { return this.write("warn", message, fields); }
  error(message, fields) { return this.write("error", message, fields); }
}
