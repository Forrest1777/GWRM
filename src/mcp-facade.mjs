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
  const url = `http://127.0.0.1:${config.service.controlPort}/api/v1/tools/call`;
  const safeToRetry = isSafeToRetrySupervisorTool(name);
  const retryDelays = safeToRetry ? [0, 250, 500, 1000, 2000, 3000] : [0];
  const retryableStatusCodes = new Set([502, 503, 504]);
  const timeoutMs = supervisorRequestTimeoutMs(config, name);
  let lastError = null;

  for (const delay of retryDelays) {
    if (delay > 0) await sleep(delay);
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
          `Failed to call ${name} on the supervisor after ${timeoutMs} ms: ${error.message}. ` +
          "The operation may still be running in the supervisor; do not repeat it automatically before checking status/logs.",
        );
      }
      continue;
    }

    const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (response.ok) return payload.result;

    const responseError = new Error(payload.error || `Supervisor returned HTTP ${response.status}.`);
    if (!safeToRetry || !retryableStatusCodes.has(response.status)) throw responseError;
    lastError = responseError;
  }

  throw new Error("GWRM supervisor is temporarily unavailable: " + (lastError?.message || "unknown failure"));
}

const server = new RawMcpServer({
  name: "gwrm",
  version: "1.1.0",
  instructions: "Always provide worktree_name. Godot, GUT, and GUI operations are routed to the isolated worktree runtime. For GUI work, prefer gui_inspect_window without screenshots, use element_token when available, keep delivery_mode=background by default, and call gui_capture_window only when visual evidence is required.",
  tools: buildTools(),
  handler: callSupervisor,
  logger,
});
await server.start();
