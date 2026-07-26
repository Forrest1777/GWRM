import net from "node:net";

export async function canConnect(host, port, timeoutMs = 500) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function isPortAvailable(host, port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function allocatePort(host, start, end, reserved = new Set()) {
  for (let port = start; port <= end; port += 1) {
    if (reserved.has(port)) continue;
    if (await isPortAvailable(host, port)) return port;
  }
  throw new Error(`Nenhuma porta disponivel entre ${start} e ${end}.`);
}

export async function waitForPort(host, port, timeoutMs, child = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Processo encerrou antes da porta ${port} ficar pronta.`);
    if (await canConnect(host, port, 500)) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timeout aguardando ${host}:${port}.`);
}
