import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { Logger } from "./logger.mjs";
import { RawMcpServer } from "./raw-mcp-server.mjs";
import { buildTools } from "./tools.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } }, allowPositionals: false });
const config = await loadConfig(values.config);
const logger = new Logger(config.paths.logsDirectory);
await logger.init();

async function callSupervisor(name, args) {
  const response = await fetch(`http://127.0.0.1:${config.service.controlPort}/api/v1/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": config.service.apiKey },
    body: JSON.stringify({ name, arguments: args }),
  });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(payload.error || `Supervisor retornou HTTP ${response.status}.`);
  return payload.result;
}

const server = new RawMcpServer({
  name: "gwrm",
  version: "1.0.0",
  instructions: "Sempre informe worktree_name. Ative a worktree antes do trabalho e desative ao concluir. Todas as tools Godot e GUT sao roteadas ao runtime isolado da worktree.",
  tools: buildTools(),
  handler: callSupervisor,
  logger,
});
await server.start();
