import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function write(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
const tools = ["get_project_info", "run_project", "get_debug_output", "stop_project", "get_godot_version", "create_scene"];
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id == null) return;
  if (msg.method === "initialize") write(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  else if (msg.method === "tools/list") write(msg.id, { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) });
  else if (msg.method === "tools/call") write(msg.id, { content: [{ type: "text", text: JSON.stringify({ name: msg.params.name, args: msg.params.arguments }) }] });
  else write(msg.id, {});
});
