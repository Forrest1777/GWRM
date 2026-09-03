import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, APP_ROOT } from "./config.mjs";

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

function canConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
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
  if (supervisor && supervisor.exitCode === null && !supervisor.killed) return;

  const child = spawnChild(process.execPath, [path.join(APP_ROOT, "src", "supervisor.mjs"), "--config", configPath]);
  supervisor = child;
  child.once("error", (error) => console.error(`Falha ao iniciar supervisor: ${error.message}`));
  child.once("close", (code, signal) => {
    if (supervisor === child) supervisor = null;
    if (shuttingDown) return;
    const reason = signal ? `sinal ${signal}` : `codigo ${code ?? "desconhecido"}`;
    console.error(`Supervisor GWRM encerrou com ${reason}. Reiniciando em 2 segundos...`);
    scheduleSupervisorRestart();
  });
}

async function waitForHealth(timeoutMilliseconds = 30000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.service.controlPort}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {}
    await sleep(300);
  }
  throw new Error("Timeout aguardando o supervisor GWRM.");
}

async function waitForProxy(timeoutMilliseconds = 15000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await canConnect("127.0.0.1", config.service.mcpPort)) return;
    if (proxy && proxy.exitCode !== null) throw new Error(`mcp-proxy encerrou com codigo ${proxy.exitCode}.`);
    await sleep(200);
  }
  throw new Error("Timeout aguardando porta MCP do GWRM.");
}

async function fetchStatus() {
  const response = await fetch(`http://127.0.0.1:${config.service.controlPort}/api/v1/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": config.service.apiKey },
    body: JSON.stringify({ name: "gwrm_status", arguments: {} }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Status GWRM retornou HTTP ${response.status}.`);
  return (await response.json()).result;
}

function statusLabel(ok, disabled = false) {
  if (disabled) return "DISABLED";
  return ok ? "OK" : "UNAVAILABLE";
}

async function printReady() {
  const status = await fetchStatus();
  const cu = status?.computer_use || {};
  const lines = [
    "",
    "GWRM READY",
    "",
    `Godot Runtime ...... OK`,
    `GUT Runner ......... OK`,
    `Computer Use ....... ${statusLabel(cu.ready, cu.state === "disabled")}`,
    `Windows Desktop .... ${statusLabel(cu.desktop_ready, cu.state === "disabled")}`,
    `Cua Driver ......... ${statusLabel(cu.ready, cu.state === "disabled")}`,
    `MCP Port ........... ${config.service.mcpPort}`,
    `Control Port ....... ${config.service.controlPort}`,
    "",
  ];
  process.stderr.write(lines.join("\n"));
}

async function resolveProxyScript() {
  const proxyPackagePath = path.join(APP_ROOT, "node_modules", "mcp-proxy", "package.json");
  const proxyPackage = JSON.parse(await readFile(proxyPackagePath, "utf8"));
  const proxyBin = typeof proxyPackage.bin === "string" ? proxyPackage.bin : proxyPackage.bin?.["mcp-proxy"];
  if (!proxyBin) throw new Error("Executavel do mcp-proxy nao encontrado no package.json.");
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
  return spawnChild(process.execPath, [proxyScript, ...proxyArgs], { shell: false });
}

async function stopChild(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGTERM"); } catch {}
  const closed = await Promise.race([
    once(child, "close").then(() => true).catch(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  if (!closed) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([
      once(child, "close").catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  }
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (supervisorRestartTimer) {
    clearTimeout(supervisorRestartTimer);
    supervisorRestartTimer = null;
  }
  await Promise.allSettled([
    stopChild(proxy, 3000),
    stopChild(supervisor, (config.service.shutdownTimeoutSeconds + 5) * 1000),
  ]);
  process.exit(code);
}

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });

try {
  startSupervisor();
  await waitForHealth();
  proxy = await startProxy();
  proxy.once("close", (code) => {
    if (!shuttingDown) {
      console.error(`mcp-proxy encerrou com codigo ${code ?? "desconhecido"}.`);
      void shutdown(code ?? 1);
    }
  });
  proxy.once("error", (error) => {
    console.error(`Falha ao iniciar mcp-proxy: ${error.message}`);
    void shutdown(1);
  });
  await waitForProxy();
  await printReady();
} catch (error) {
  console.error(`Falha ao iniciar GWRM: ${error.message}`);
  await shutdown(1);
}
