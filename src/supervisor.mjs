import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { startControlApi } from "./control-api.mjs";
import { GutRunner } from "./gut-runner.mjs";
import { Logger } from "./logger.mjs";
import { SessionManager } from "./session-manager.mjs";
import { buildToolHandler } from "./tools.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } }, allowPositionals: false });
const config = await loadConfig(values.config);
const logger = new Logger(config.paths.logsDirectory);
await logger.init();
await logger.info("Inicializando supervisor GWRM.", { config: config.configPath, version: "1.0.0" });

const sessions = new SessionManager(config, logger);
await sessions.init();
const gut = new GutRunner(config, sessions, logger);
const toolHandler = buildToolHandler(config, sessions, gut);
const controlServer = startControlApi(config, sessions, toolHandler, logger);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await logger.info("Encerrando supervisor GWRM.", { signal });
  await new Promise((resolve) => controlServer.close(() => resolve()));
  await sessions.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", async (error) => { await logger.error("Excecao nao tratada.", { error: error.stack || error.message }); await shutdown("uncaughtException"); });
process.on("unhandledRejection", async (error) => { await logger.error("Promise rejeitada sem tratamento.", { error: error?.stack || String(error) }); });
