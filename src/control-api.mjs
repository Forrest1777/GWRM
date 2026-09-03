import crypto from "node:crypto";
import http from "node:http";

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req, maxBytes = 1048576) {
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString("utf8");
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Request body exceeds the configured size limit.");
  }
  return text ? JSON.parse(text) : {};
}

export function startControlApi(config, sessionManager, toolHandler, logger) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        send(res, 200, { ready: true, service: config.service.name, version: "1.1.0" });
        return;
      }
      if (!safeEqual(req.headers["x-api-key"], config.service.apiKey)) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (req.method === "POST" && url.pathname === "/api/v1/tools/call") {
        const body = await readJson(req);
        const result = await toolHandler(body.name, body.arguments || {});
        send(res, 200, { result });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/worktrees") {
        send(res, 200, { worktrees: sessionManager.listStatuses() });
        return;
      }
      const match = url.pathname.match(/^\/api\/v1\/worktrees\/([^/]+)(?:\/(activate|deactivate|ensure))?$/);
      if (!match) { send(res, 404, { error: "not_found" }); return; }
      const name = decodeURIComponent(match[1]);
      const action = match[2];
      if (req.method === "GET" && !action) {
        send(res, 200, sessionManager.getStatus(name));
        return;
      }
      if (req.method !== "POST") { send(res, 405, { error: "method_not_allowed" }); return; }
      if (action === "activate") send(res, 200, await sessionManager.activateWorktree(name, "control_api"));
      else if (action === "deactivate") send(res, 200, await sessionManager.deactivateWorktree(name, "control_api"));
      else if (action === "ensure") send(res, 200, await sessionManager.ensureWorktree(name, "lsp_bridge"));
      else send(res, 400, { error: "missing_action" });
    } catch (error) {
      await logger.error("Control API request failed.", { error: error.message, url: req.url });
      send(res, 500, { error: error.message });
    }
  });
  server.listen(config.service.controlPort, config.service.bindHost, () => {
    logger.info("Control API started.", { host: config.service.bindHost, port: config.service.controlPort });
  });
  return server;
}
