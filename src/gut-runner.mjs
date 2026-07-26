import { spawn } from "node:child_process";
import { validateResPath } from "./paths.mjs";
import { terminateProcessTree } from "./process-utils.mjs";

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function limitOutput(value, maxCharacters) {
  const clean = stripAnsi(value).trim();
  if (clean.length <= maxCharacters) return clean;
  return `[saida truncada; ultimos ${maxCharacters} caracteres]\n${clean.slice(-maxCharacters)}`;
}

function numberFrom(text, pattern) {
  const match = text.match(pattern);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function parseGutOutput(stdout, stderr, exitCode, timedOut = false) {
  const combined = stripAnsi(`${stdout}\n${stderr}`);
  const scripts = numberFrom(combined, /Scripts:\s*(\d+)/i);
  const tests = numberFrom(combined, /(?:^|\n)Tests:\s*(\d+)/i);
  const passingTests = numberFrom(combined, /Passing Tests:\s*(\d+)/i);
  const failingTests = numberFrom(combined, /Failing Tests:\s*(\d+)/i) ?? 0;
  const asserts = numberFrom(combined, /Asserts:\s*(\d+)/i);
  const errorsReported = numberFrom(combined, /(?:^|\n)Errors?:\s*(\d+)/i) ?? 0;
  const warnings = numberFrom(combined, /Warnings?:\s*(\d+)/i);

  const fatalPatterns = [
    /Some GUT class_names have not been imported/i,
    /Missing class_names/i,
    /Parse Error/i,
    /SCRIPT ERROR/i,
    /Could not resolve class/i,
    /Could not load script/i,
    /No tests found/i,
  ];
  const fatalMessages = fatalPatterns.filter((pattern) => pattern.test(combined)).map((pattern) => pattern.source);
  const passed = exitCode === 0
    && !timedOut
    && Number.isInteger(scripts) && scripts > 0
    && Number.isInteger(tests) && tests > 0
    && Number.isInteger(asserts) && asserts > 0
    && failingTests === 0
    && errorsReported === 0
    && fatalMessages.length === 0;

  return {
    passed,
    counts: { scripts, tests, passing_tests: passingTests, failing_tests: failingTests, asserts, errors: errorsReported, warnings },
    fatal_patterns: fatalMessages,
  };
}

class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  async acquire() {
    if (this.active < this.max) { this.active += 1; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

export class GutRunner {
  constructor(config, sessionManager, logger) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.logger = logger;
    this.semaphore = new Semaphore(config.gut.maxConcurrentProcesses);
  }

  async runDirectory(worktreeName, testDirectory) {
    const safe = validateResPath(testDirectory || this.config.gut.defaultTestDirectory, this.config.gut.allowedTestRoot, "test_directory");
    return await this.#run(worktreeName, { type: "directory", value: safe });
  }

  async runScript(worktreeName, testScript) {
    const safe = validateResPath(testScript, this.config.gut.allowedTestRoot, "test_script");
    return await this.#run(worktreeName, { type: "script", value: safe });
  }

  async #run(worktreeName, selection) {
    await this.semaphore.acquire();
    try {
      const session = await this.sessionManager.ensureWorktree(worktreeName, "gut");
      const args = [
        ...this.config.godot.executableArgsPrefix,
        "--headless",
        "--path", session.host_project_path,
        "-d",
        "-s", "addons/gut/gut_cmdln.gd",
        "-gexit",
      ];
      if (selection.type === "script") args.push(`-gtest=${selection.value}`);
      else args.push(`-gdir=${selection.value}`);

      const startedAt = Date.now();
      const result = await new Promise((resolve, reject) => {
        const child = spawn(this.config.paths.godotExecutable, args, {
          cwd: session.host_project_path,
          windowsHide: true,
          shell: false,
          env: process.env,
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
        const timer = setTimeout(async () => {
          timedOut = true;
          await terminateProcessTree(child.pid, this.config, this.logger, session.host_project_path);
        }, this.config.gut.timeoutSeconds * 1000);
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.once("error", (error) => finish(() => reject(error)));
        child.once("close", (exitCode, signal) => finish(() => resolve({ exitCode, signal, stdout, stderr, timedOut })));
      });

      const parsed = parseGutOutput(result.stdout, result.stderr, result.exitCode, result.timedOut);
      const payload = {
        ...parsed,
        exit_code: result.exitCode,
        signal: result.signal,
        timed_out: result.timedOut,
        duration_ms: Date.now() - startedAt,
        worktree_name: worktreeName,
        project_path_container: session.container_project_path,
        project_path_windows: session.host_project_path,
        selection,
        stdout: limitOutput(result.stdout, this.config.gut.maxOutputCharacters),
        stderr: limitOutput(result.stderr, this.config.gut.maxOutputCharacters),
      };
      await this.logger.info("Execucao GUT concluida.", { worktree: worktreeName, passed: payload.passed, counts: payload.counts });
      return payload;
    } finally {
      this.semaphore.release();
    }
  }
}
