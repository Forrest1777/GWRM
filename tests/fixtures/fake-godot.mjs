import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const prefixedValue = (flag) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1) || null;
const project = value("--path");
const lspPort = Number(value("--lsp-port"));

if (args.includes("res://addons/gut/gut_cmdln.gd") || args.includes("addons/gut/gut_cmdln.gd")) {
  const junitResPath = prefixedValue("-gjunit_xml_file");
  if (project && junitResPath?.startsWith("res://")) {
    const junitHostPath = path.join(project, ...junitResPath.slice("res://".length).split("/"));
    await mkdir(path.dirname(junitHostPath), { recursive: true });
    await writeFile(junitHostPath, `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="GutTests" failures="0" tests="3">
  <testsuite name="res://tests/fake.gd" tests="3" failures="0" skipped="0">
    <testcase name="test_one" assertions="2" status="pass"></testcase>
    <testcase name="test_two" assertions="2" status="pass"></testcase>
    <testcase name="test_three" assertions="1" status="pass"></testcase>
  </testsuite>
</testsuites>`);
  }
  console.log("3/3 tests passed");
  console.log("5 asserts");
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
