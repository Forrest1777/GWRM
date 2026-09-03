import readline from "node:readline";

const tools = ["list_windows", "get_window_state", "click", "type_text", "press_key", "hotkey", "scroll"];
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }

rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined || request.id === null) return;
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-cua", version: "1" } } });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) } });
    return;
  }
  if (request.method === "tools/call") {
    const name = request.params?.name;
    if (name === "list_windows") {
      send({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { windows: [] }, content: [{ type: "text", text: "[]" }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: `ok:${name}` }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "not found" } });
});
