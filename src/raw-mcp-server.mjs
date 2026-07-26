import readline from "node:readline";

export class RawMcpServer {
  constructor({ name, version, instructions, tools, handler, logger }) {
    this.name = name;
    this.version = version;
    this.instructions = instructions;
    this.tools = tools;
    this.handler = handler;
    this.logger = logger;
  }

  async start() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let request;
      try { request = JSON.parse(line); }
      catch (error) {
        this.#write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } });
        return;
      }
      if (request.id === undefined || request.id === null) return;
      try {
        const result = await this.#dispatch(request);
        this.#write({ jsonrpc: "2.0", id: request.id, result });
      } catch (error) {
        await this.logger.error("Erro atendendo requisicao MCP.", { method: request.method, error: error.message });
        this.#write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error.message } });
      }
    });
    process.stderr.write("GWRM MCP stdio pronto.\n");
  }

  async #dispatch(request) {
    switch (request.method) {
      case "initialize":
        return {
          protocolVersion: request.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: this.name, version: this.version },
          instructions: this.instructions,
        };
      case "ping": return {};
      case "tools/list": return { tools: this.tools };
      case "tools/call": {
        const name = request.params?.name;
        const args = request.params?.arguments || {};
        const result = await this.handler(name, args);
        if (result && Array.isArray(result.content)) return result;
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      }
      default: throw new Error(`Metodo MCP nao suportado: ${request.method}`);
    }
  }

  #write(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}
