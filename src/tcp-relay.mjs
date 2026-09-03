import net from "node:net";

export async function startTcpRelay({ bindHost, bindPort, targetHost, targetPort, logger, worktree }) {
  const sockets = new Set();
  const server = net.createServer((incoming) => {
    const outgoing = net.createConnection({ host: targetHost, port: targetPort });
    sockets.add(incoming);
    sockets.add(outgoing);
    incoming.pipe(outgoing);
    outgoing.pipe(incoming);
    const close = () => {
      sockets.delete(incoming);
      sockets.delete(outgoing);
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on("close", close);
    outgoing.on("close", close);
    incoming.on("error", close);
    outgoing.on("error", close);
  });
  server.on("error", (error) => logger.error("LSP relay error.", { worktree, error: error.message }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: bindHost, port: bindPort, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    server,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
