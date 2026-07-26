import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const project = value("--path");
const lspPort = Number(value("--lsp-port"));

if (args.includes("addons/gut/gut_cmdln.gd")) {
  console.log("Scripts: 2");
  console.log("Tests: 3");
  console.log("Passing Tests: 3");
  console.log("Failing Tests: 0");
  console.log("Asserts: 5");
  console.log("Errors: 0");
  process.exit(0);
}

if (!project || !lspPort) process.exit(2);
await mkdir(path.join(project, ".godot"), { recursive: true });
await writeFile(path.join(project, ".godot", "global_script_class_cache.cfg"), "list=[]\n");
const server = net.createServer((socket) => socket.on("data", (data) => socket.write(data)));
server.listen(lspPort, "127.0.0.1");
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
