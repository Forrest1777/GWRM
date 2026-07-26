import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.mjs";
import { APP_ROOT } from "./config.mjs";

const { values } = parseArgs({
  options: { config: { type: "string" } },
  allowPositionals: false,
});
const config = await loadConfig(values.config);
const configPath = config.configPath;

function spawnChild(command, args, options = {}) {
  return spawn(command, args, {
    cwd: APP_ROOT,
    env: process.env,
    windowsHide: false,
    stdio: "inherit",
    ...options,
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let supervisor = null;
let proxy = null;
let supervisorRestartTimer = null;
let shuttingDown = false;

function scheduleSupervisorRestart() {
  if (shuttingDown || supervisorRestartTimer) return;

  supervisorRestartTimer = setTimeout(() => {
    supervisorRestartTimer = null;
    startSupervisor();
  }, 2000);
}

function startSupervisor() {
  if (shuttingDown) return;

  if (supervisor && supervisor.exitCode === null && !supervisor.killed) {
    return;
  }

  const child = spawnChild(process.execPath, [
    path.join(APP_ROOT, "src", "supervisor.mjs"),
    "--config",
    configPath,
  ]);

  supervisor = child;

  child.once("error", (error) => {
    console.error(`Falha ao iniciar supervisor: ${error.message}`);
  });

  child.once("close", (code, signal) => {
    if (supervisor === child) {
      supervisor = null;
    }

    if (shuttingDown) return;

    const reason = signal
      ? `sinal ${signal}`
      : `codigo ${code ?? "desconhecido"}`;

    console.error(
      `Supervisor GWRM encerrou com ${reason}. Reiniciando em 2 segundos...`,
    );
    scheduleSupervisorRestart();
  });
}

async function waitForHealth(timeoutMilliseconds = 30000) {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${config.service.controlPort}/health`,
        { signal: AbortSignal.timeout(1500) },
      );

      if (response.ok) return;
    } catch {
      // O supervisor pode estar iniciando ou reiniciando.
    }

    await sleep(300);
  }

  throw new Error("Timeout aguardando o supervisor GWRM.");
}

async function resolveProxyScript() {
  const proxyPackagePath = path.join(
    APP_ROOT,
    "node_modules",
    "mcp-proxy",
    "package.json",
  );

  const proxyPackage = JSON.parse(
    await readFile(proxyPackagePath, "utf8"),
  );

  const proxyBin =
    typeof proxyPackage.bin === "string"
      ? proxyPackage.bin
      : proxyPackage.bin?.["mcp-proxy"];

  if (!proxyBin) {
    throw new Error(
      "Executável do mcp-proxy não encontrado no package.json.",
    );
  }

  return path.resolve(path.dirname(proxyPackagePath), proxyBin);
}

async function startProxy() {
  const proxyScript = await resolveProxyScript();
  const proxyArgs = [
    "--server", "stream",
    "--stateless",
    "--port", String(config.service.mcpPort),
    "--apiKey", config.service.apiKey,
    "--connectionTimeout", "60000",
    "--requestTimeout", "900000",
    "--",
    process.execPath,
    path.join(APP_ROOT, "src", "mcp-facade.mjs"),
    "--config", configPath,
  ];

  return spawnChild(
    process.execPath,
    [proxyScript, ...proxyArgs],
    { shell: false },
  );
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (supervisorRestartTimer) {
    clearTimeout(supervisorRestartTimer);
    supervisorRestartTimer = null;
  }

  try { proxy?.kill("SIGTERM"); } catch {}
  try { supervisor?.kill("SIGTERM"); } catch {}

  setTimeout(() => process.exit(code), 1500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  startSupervisor();
  await waitForHealth();

  proxy = await startProxy();

  proxy.once("close", (code) => {
    if (!shuttingDown) {
      console.error(
        `mcp-proxy encerrou com codigo ${code ?? "desconhecido"}.`,
      );
    }
    shutdown(code ?? 1);
  });

  proxy.once("error", (error) => {
    console.error(`Falha ao iniciar mcp-proxy: ${error.message}`);
    shutdown(1);
  });
} catch (error) {
  console.error(`Falha ao iniciar GWRM: ${error.message}`);
  await shutdown(1);
}
