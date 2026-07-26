import { spawn } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { APP_ROOT } from "./config.mjs";

const { values } = parseArgs({ options: { config: { type: "string" } }, allowPositionals: false });
const config = await loadConfig(values.config);
const configPath = config.configPath;

function spawnChild(command, args, options = {}) {
  return spawn(command, args, { cwd: APP_ROOT, env: process.env, windowsHide: false, stdio: "inherit", ...options });
}

const supervisor = spawnChild(process.execPath, [path.join(APP_ROOT, "src", "supervisor.mjs"), "--config", configPath]);

async function waitForHealth() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (supervisor.exitCode !== null) throw new Error(`Supervisor encerrou com codigo ${supervisor.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${config.service.controlPort}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Timeout aguardando o supervisor GWRM.");
}

await waitForHealth();
const proxyCommand = path.join(APP_ROOT, "node_modules", ".bin", process.platform === "win32" ? "mcp-proxy.cmd" : "mcp-proxy");
const proxyArgs = [
  "--server", "stream",
  "--port", String(config.service.mcpPort),
  "--apiKey", config.service.apiKey,
  "--connectionTimeout", "60000",
  "--requestTimeout", "900000",
  "--",
  process.execPath,
  path.join(APP_ROOT, "src", "mcp-facade.mjs"),
  "--config", configPath,
];
const proxy = spawnChild(proxyCommand, proxyArgs, { shell: process.platform === "win32" });

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { proxy.kill("SIGTERM"); } catch {}
  try { supervisor.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(code), 1500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
proxy.once("close", (code) => shutdown(code ?? 0));
supervisor.once("close", (code) => shutdown(code ?? 1));
proxy.once("error", (error) => { console.error(`Falha ao iniciar mcp-proxy: ${error.message}`); shutdown(1); });
supervisor.once("error", (error) => { console.error(`Falha ao iniciar supervisor: ${error.message}`); shutdown(1); });
