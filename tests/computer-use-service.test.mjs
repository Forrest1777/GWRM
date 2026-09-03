import test from "node:test";
import assert from "node:assert/strict";
import { ComputerUseService } from "../src/computer-use-service.mjs";

function makeConfig() {
  return {
    appRoot: process.cwd(),
    paths: { godotExecutable: "C:\\Godot\\Godot_console.exe" },
    computerUse: {
      enabled: true,
      required: false,
      command: "cua-driver",
      args: ["mcp"],
      protocolVersion: "2024-11-05",
      startupTimeoutSeconds: 5,
      requestTimeoutSeconds: 5,
      permissionMode: "standard",
      waitTimeoutSeconds: 1,
      maxWaitTimeoutSeconds: 2,
      waitPollMilliseconds: 10,
      maxSemanticElements: 100,
      maxSemanticDepth: 10,
      maxImageDimension: 800,
    },
  };
}

function makeLogger() {
  return { info: async () => {}, warn: async () => {}, error: async () => {} };
}

class FakeClient {
  constructor() {
    this.pid = 9090;
    this.isAlive = true;
    this.calls = [];
    this.tools = ["list_windows", "get_window_state", "click", "type_text", "press_key", "hotkey", "scroll"];
  }
  async start() { return this; }
  hasTool(name) { return this.tools.includes(name); }
  async close() { this.isAlive = false; }
  async callTool(name, args) {
    this.calls.push({ name, args });
    if (name === "list_windows") {
      if (args.pid !== undefined && args.pid !== 222) return { structuredContent: { windows: [] }, content: [] };
      return { structuredContent: { windows: [{ window_id: 77, pid: 222, app_name: "Godot", title: "Test Scene", bounds: { x: 1, y: 2, width: 800, height: 600 }, z_index: 2, is_on_screen: true }] }, content: [] };
    }
    if (name === "get_window_state") {
      if (args.include_screenshot === false) {
        return { structuredContent: { snapshot_id: "snap-1", elements: [{ element_index: 3, element_token: "tok-3", role: "button", label: "Start" }] }, content: [] };
      }
      return { structuredContent: { screenshot_width: 800, screenshot_height: 600 }, content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] };
    }
    return { content: [{ type: "text", text: `ok:${name}` }] };
  }
}

function fixture() {
  const fakeClient = new FakeClient();
  const sessions = {
    getStatus(name) {
      if (name !== "t_test") return { registered: false };
      return { registered: true, host_project_path: "C:\\workspace\\.worktrees\\t_test", godot_pid: 111 };
    },
  };
  const processLister = async () => [
    { pid: 111, name: "Godot_console.exe", command_line: "Godot --headless --editor --path C:\\workspace\\.worktrees\\t_test" },
    { pid: 222, name: "Godot_console.exe", command_line: "Godot -d --path C:\\workspace\\.worktrees\\t_test" },
    { pid: 333, name: "node.exe", command_line: "node something C:\\workspace\\.worktrees\\t_test" },
  ];
  const service = new ComputerUseService(makeConfig(), sessions, makeLogger(), {
    processLister,
    clientFactory: () => fakeClient,
    sleep: async () => {},
  });
  return { service, fakeClient };
}

test("Computer Use inicia, limita janelas a Godot grafico da worktree e usa semantic-first", async () => {
  const { service, fakeClient } = fixture();
  await service.init();
  assert.equal(service.getStatus().ready, true);
  assert.equal(service.getStatus().semantic_first, true);

  const listed = await service.listWindows("t_test");
  assert.equal(listed.windows.length, 1);
  assert.equal(listed.windows[0].pid, 222);
  assert.equal(listed.windows[0].window_id, 77);

  const inspected = await service.inspectWindow("t_test", 77, { query: "Start" });
  assert.equal(inspected.screenshot_included, false);
  assert.equal(inspected.state.elements[0].element_token, "tok-3");
  const inspectCall = fakeClient.calls.findLast((call) => call.name === "get_window_state");
  assert.equal(inspectCall.args.include_screenshot, false);
  assert.equal(inspectCall.args.include_accessibility_tree, true);

  await service.shutdown();
});

test("Screenshot e opt-in e acoes usam background por padrao", async () => {
  const { service, fakeClient } = fixture();
  await service.init();

  const captured = await service.captureWindow("t_test", 77, {});
  assert.equal(captured.content[0].type, "image");
  const captureCall = fakeClient.calls.findLast((call) => call.name === "get_window_state");
  assert.equal(captureCall.args.include_accessibility_tree, false);
  assert.equal(captureCall.args.include_screenshot, true);
  assert.equal(captureCall.args.max_dimension, 800);

  await service.click("t_test", 77, { element_token: "tok-3" });
  const click = fakeClient.calls.findLast((call) => call.name === "click");
  assert.equal(click.args.delivery_mode, "background");
  assert.equal(click.args.pid, 222);
  assert.equal(click.args.window_id, 77);
  assert.equal(click.args.element_token, "tok-3");

  await assert.rejects(() => service.click("t_test", 999, { x: 1, y: 1 }), /nao pertence/);
  await service.shutdown();
});

test("wait_for_window e wait_for_element executam polling internamente", async () => {
  const { service } = fixture();
  await service.init();
  const window = await service.waitForWindow("t_test", { titleContains: "Scene", timeoutSeconds: 1 });
  assert.equal(window.matched, true);
  assert.equal(window.window.window_id, 77);

  const element = await service.waitForElement("t_test", 77, "Start", { timeoutSeconds: 1 });
  assert.equal(element.matched, true);
  assert.equal(element.state.elements[0].label, "Start");
  await service.shutdown();
});
