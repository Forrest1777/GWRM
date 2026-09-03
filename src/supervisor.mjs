import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { startControlApi } from "./control-api.mjs";
import { ComputerUseService } from "./computer-use-service.mjs";
import { GutRunner } from "./gut-runner.mjs";
import { Logger } from "./logger.mjs";
import { SessionManager } from "./session-manager.mjs";
import { buildToolHandler } from "./tools.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } }, allowPositionals: false });
const config = await loadConfig(values.config);
const logger = new Logger(config.paths.logsDirectory);
await logger.init();
await logger.info("Initializing GWRM supervisor.", { config: config.configPath, version: "1.1.0" });

const sessions = new SessionManager(config, logger);
await sessions.init();
const gut = new GutRunner(config, sessions, logger);
const computerUse = new ComputerUseService(config, sessions, logger);
await computerUse.init();
const toolHandler = buildToolHandler(config, sessions, gut, computerUse);
const controlServer = startControlApi(config, sessions, toolHandler, logger);

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  await logger.info("Shutting down GWRM supervisor.", { signal });
  await new Promise((resolve) => controlServer.close(() => resolve()));
  await sessions.shutdown();
  await computerUse.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", async (error) => { await logger.error("Unhandled exception.", { error: error.stack || error.message }); await shutdown("uncaughtException"); });
process.on("unhandledRejection", async (error) => { await logger.error("Unhandled promise rejection.", { error: error?.stack || String(error) }); });
