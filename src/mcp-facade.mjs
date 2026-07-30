import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { Logger } from "./logger.mjs";
import { RawMcpServer } from "./raw-mcp-server.mjs";
import { buildTools } from "./tools.mjs";
import { isSafeToRetrySupervisorTool, supervisorRequestTimeoutMs } from "./mcp-facade-policy.mjs";

const { values } = parseArgs({
  options: { config: { type: "string" } },
  allowPositionals: false,
});
const config = await loadConfig(values.config);
const logger = new Logger(config.paths.logsDirectory);
await logger.init();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function callSupervisor(name, args) {
  const url =
    `http://127.0.0.1:${config.service.controlPort}/api/v1/tools/call`;
  const safeToRetry = isSafeToRetrySupervisorTool(name);
  const retryDelays = safeToRetry ? [0, 250, 500, 1000, 2000, 3000] : [0];
  const retryableStatusCodes = new Set([502, 503, 504]);
  const timeoutMs = supervisorRequestTimeoutMs(config, name);
  let lastError = null;

  for (const delay of retryDelays) {
    if (delay > 0) {
      await sleep(delay);
    }

    let response;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-Key": config.service.apiKey,
        },
        body: JSON.stringify({ name, arguments: args ?? {} }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = error;
      if (!safeToRetry) {
        throw new Error(
          `Falha chamando ${name} no supervisor após ${timeoutMs} ms: ${error.message}. ` +
          "A operação pode continuar no supervisor; não repita automaticamente sem consultar o status/log.",
        );
      }
      continue;
    }

    const payload = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }));

    if (response.ok) {
      return payload.result;
    }

    const responseError = new Error(
      payload.error || `Supervisor retornou HTTP ${response.status}.`,
    );

    if (!safeToRetry || !retryableStatusCodes.has(response.status)) {
      throw responseError;
    }

    lastError = responseError;
  }

  throw new Error(
    "Supervisor GWRM temporariamente indisponível: " +
    (lastError?.message || "falha desconhecida"),
  );
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
