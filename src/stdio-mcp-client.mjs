import { spawn } from "node:child_process";
import readline from "node:readline";

export class StdioMcpClient {
  constructor({ command, args, cwd, env, protocolVersion, startupTimeoutMs, requestTimeoutMs, logger, label }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.protocolVersion = protocolVersion;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;
    this.label = label;
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
      if (text) this.logger.info("Saida do Godot MCP dedicado.", { worktree: this.label, text: text.slice(-2000) });
    });
    this.child.once("error", (error) => this.#failAll(error));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.readline?.close();
      this.#failAll(new Error(`Godot MCP ${this.label} encerrou (codigo=${code}, sinal=${signal}).`));
    });

    this.readline = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.readline.on("line", (line) => this.#onLine(line));

    await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "gwrm", version: "1.0.0" },
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
      this.logger.warn("Linha nao JSON recebida do Godot MCP.", { worktree: this.label, line: line.slice(0, 1000) });
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
    if (!this.child?.stdin || this.closed) throw new Error(`Godot MCP ${this.label} nao esta ativo.`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout MCP em ${method} para ${this.label}.`));
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
    if (this.closed) {
      this.readline?.close();
      return;
    }

    this.closed = true;
    this.readline?.close();
    this.#failAll(new Error(`Godot MCP ${this.label} foi encerrado.`));
    try { this.child.stdin.end(); } catch {}
    try { this.child.stdout?.destroy(); } catch {}
    try { this.child.stderr?.destroy(); } catch {}

    // O SessionManager encerra a arvore com taskkill /T antes deste cleanup.
    // Este kill e apenas um fallback para usos isolados do cliente.
    if (this.child.exitCode === null) {
      try { this.child.kill("SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (this.child.exitCode === null) {
      try { this.child.kill("SIGKILL"); } catch {}
    }
  }

  get pid() { return this.child?.pid ?? null; }
  get isAlive() { return Boolean(this.child && this.child.exitCode === null && !this.closed); }
}
