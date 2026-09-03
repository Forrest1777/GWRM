import { spawn } from "node:child_process";
import readline from "node:readline";
import { once } from "node:events";

async function waitForChildClose(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    once(child, "close").then(() => true).catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export class StdioMcpClient {
  constructor({ command, args, cwd, env, protocolVersion, startupTimeoutMs, requestTimeoutMs, logger, label, serverName = "Dedicated Godot MCP" }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.protocolVersion = protocolVersion;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;
    this.label = label;
    this.serverName = serverName;
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.closed = false;
    this.readline = null;
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.logger.info(`Output from ${this.serverName}.`, { worktree: this.label || undefined, component: this.serverName, text: text.slice(-2000) });
    });
    this.child.once("error", (error) => this.#failAll(error));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.readline?.close();
      this.#failAll(new Error(`${this.serverName}${this.label ? ` ${this.label}` : ""} exited (code=${code}, signal=${signal}).`));
    });

    this.readline = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.readline.on("line", (line) => this.#onLine(line));

    await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "gwrm", version: "1.1.0" },
    }, this.startupTimeoutMs);
    this.notify("notifications/initialized", {});
    const listed = await this.request("tools/list", {}, this.startupTimeoutMs);
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return this;
  }

  #onLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch {
      this.logger.warn(`Non-JSON line received from ${this.serverName}.`, { worktree: this.label || undefined, component: this.serverName, line: line.slice(0, 1000) });
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #send(message) {
    if (!this.child?.stdin || this.closed) throw new Error(`${this.serverName}${this.label ? ` ${this.label}` : ""} is not active.`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout in ${method} for ${this.serverName}${this.label ? ` ${this.label}` : ""}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    this.#send({ jsonrpc: "2.0", method, params });
  }

  async callTool(name, args) {
    return await this.request("tools/call", { name, arguments: args }, this.requestTimeoutMs);
  }

  hasTool(name) {
    return this.tools.some((tool) => tool.name === name);
  }

  async close() {
    const child = this.child;
    this.closed = true;
    this.#failAll(new Error(`${this.serverName}${this.label ? ` ${this.label}` : ""} was closed.`));

    if (!child) {
      this.readline?.close();
      return;
    }

    try { child.stdin?.end(); } catch {}

    let closed = await waitForChildClose(child, 1500);
    if (!closed) {
      try { child.kill("SIGTERM"); } catch {}
      closed = await waitForChildClose(child, 2000);
    }
    if (!closed) {
      try { child.kill("SIGKILL"); } catch {}
      closed = await waitForChildClose(child, 3000);
    }

    this.readline?.close();
    if (!closed) {
      throw new Error(`${this.serverName}${this.label ? ` ${this.label}` : ""} remained active after cleanup.`);
    }

    try { child.stdout?.destroy(); } catch {}
    try { child.stderr?.destroy(); } catch {}
  }

  get pid() { return this.child?.pid ?? null; }
  get isAlive() { return Boolean(this.child && this.child.exitCode === null && !this.closed); }
}
