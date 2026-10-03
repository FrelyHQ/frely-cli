import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAppAllowed, isBlockedApp, redactBlockedAppLines } from "./guard.js";
import { decodePngPixels, downscalePng, encodeRgbaPng } from "./image.js";
import type { OcuBackend, OcuResult, OcuTool } from "./ocu.js";
import { ComputerToolset } from "./toolset.js";
import type { ComputerAuditEntry } from "./state.js";
import { RelayMcpSession } from "../runtime/relay-mcp.js";

test("blocklist covers terminals, password managers, OS prompts, settings and Frely, by name and bundle id", () => {
  for (const app of ["Terminal", "com.apple.Terminal", "iTerm2", "com.googlecode.iterm2", "Windows Terminal", "powershell.exe", "gnome-terminal", "1Password", "com.1password.1password", "Bitwarden", "KeePassXC", "Keychain Access", "SecurityAgent", "consent.exe", "System Settings", "com.apple.systempreferences", "Frely", "com.frely.app", "  TERMINAL  "]) {
    assert.equal(isBlockedApp(app), true, app);
  }
  for (const app of ["Safari", "com.apple.Safari", "Notes", "Google Chrome", "Slack", "Microsoft Word", "firefox"]) assert.equal(isBlockedApp(app), false, app);
});

test("app argument must be a name: pids, empty and oversized values are refused", () => {
  assert.throws(() => assertAppAllowed("1234"), /Process ids/);
  assert.throws(() => assertAppAllowed(""), /non-empty/);
  assert.throws(() => assertAppAllowed(undefined), /non-empty/);
  assert.throws(() => assertAppAllowed("x".repeat(201)), /too long/);
  assert.throws(() => assertAppAllowed("Terminal"), /always blocked/);
  assert.equal(assertAppAllowed("Safari"), "Safari");
});

test("list output never advertises a blocked app", () => {
  const text = ["Safari — com.apple.Safari — running", "Terminal — com.apple.Terminal — running", "1Password — com.1password.1password — 12 uses", "Notes — com.apple.Notes — running"].join("\n");
  assert.equal(redactBlockedAppLines(text), "Safari — com.apple.Safari — running\nNotes — com.apple.Notes — running");
});

function checker(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4;
    const dark = ((x >> 4) + (y >> 4)) % 2 === 0;
    pixels[i] = dark ? 20 : 235; pixels[i + 1] = dark ? 40 : 235; pixels[i + 2] = dark ? 200 : 235; pixels[i + 3] = 255;
  }
  return encodeRgbaPng(width, height, pixels);
}

test("screenshots are downscaled to the long-edge cap with the scale reported; small ones pass through", () => {
  const big = downscalePng(checker(2560, 1600), 1280)!;
  assert.deepEqual([big.width, big.height, big.scale], [1280, 800, 2]);
  const decoded = decodePngPixels(big.data)!;
  assert.deepEqual([decoded.width, decoded.height, decoded.channels], [1280, 800, 4]);
  assert.ok(big.data.length < 2 * 1024 * 1024);
  const small = checker(640, 400);
  const same = downscalePng(small, 1280)!;
  assert.equal(same.scale, 1);
  assert.equal(same.data, small);
  assert.equal(downscalePng(Buffer.from("not a png"), 1280), null);
});

const TOOLS: OcuTool[] = [
  ...["list_apps", "get_app_state", "click", "perform_secondary_action", "scroll", "drag", "type_text", "press_key", "set_value"].map((name) => ({ name, description: `${name} desc. This tool is part of plugin \`Computer Use\`.`, inputSchema: { type: "object" } })),
  { name: "run_shell", description: "must stay hidden", inputSchema: { type: "object" } },
];

function fakeBackend(png: Buffer): OcuBackend & { calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    listTools: async () => TOOLS,
    callTool: async (name, args): Promise<OcuResult> => {
      calls.push({ name, args });
      if (name === "list_apps") return { content: [{ type: "text", text: "Safari — com.apple.Safari\nTerminal — com.apple.Terminal" }] };
      if (name === "get_app_state") return { content: [{ type: "text", text: "tree" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => undefined,
  };
}

test("toolset exposes only the reviewed tools, prefixed, and only while locally enabled", async () => {
  let enabled = false;
  const toolset = new ComputerToolset({ backend: fakeBackend(checker(100, 100)), isLocallyEnabled: async () => enabled, audit: async () => undefined });
  assert.deepEqual(await toolset.listTools(), []);
  const refused = await toolset.call("computer_click", { app: "Safari", x: 1, y: 1 });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text!, /turned off/);
  enabled = true;
  const names = (await toolset.listTools()).map((tool) => tool.name);
  assert.equal(names.length, 9);
  assert.ok(names.every((name) => name.startsWith("computer_")));
  assert.ok(!names.includes("computer_run_shell"));
  assert.ok(!(await toolset.listTools())[0]!.description!.includes("plugin"));
  assert.equal((await toolset.call("computer_run_shell", {})).isError, true);
});

test("blocked apps never reach the backend; list is redacted; audit holds metadata only", async () => {
  const backend = fakeBackend(checker(100, 100));
  const audit: ComputerAuditEntry[] = [];
  const toolset = new ComputerToolset({ backend, isLocallyEnabled: async () => true, audit: async (entry) => { audit.push(entry); } });
  const blocked = await toolset.call("computer_type_text", { app: "com.apple.Terminal", text: "rm -rf ~" });
  assert.equal(blocked.isError, true);
  assert.equal(backend.calls.length, 0);
  const list = await toolset.call("computer_list_apps", {});
  assert.equal(list.content[0]!.text, "Safari — com.apple.Safari");
  await toolset.call("computer_type_text", { app: "Safari", text: "secret typed text" });
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map((entry) => entry.ok), [false, true, true]);
  assert.equal(audit[0]!.reason, "blocked");
  assert.ok(!JSON.stringify(audit).includes("secret typed text") && !JSON.stringify(audit).includes("rm -rf"));
});

test("model coordinates are mapped back to device pixels using the latest screenshot scale of that app", async () => {
  const backend = fakeBackend(checker(2560, 1600));
  const toolset = new ComputerToolset({ backend, isLocallyEnabled: async () => true, audit: async () => undefined });
  const state = await toolset.call("computer_get_app_state", { app: "Safari" });
  const image = state.content.find((item) => item.type === "image")!;
  assert.deepEqual([decodePngPixels(Buffer.from(image.data!, "base64"))!.width], [1280]);
  await toolset.call("computer_click", { app: "Safari", x: 100, y: 50 });
  await toolset.call("computer_drag", { app: "Safari", from_x: 10, from_y: 20, to_x: 30, to_y: 40 });
  await toolset.call("computer_click", { app: "Notes", x: 100, y: 50 });
  assert.deepEqual(backend.calls[1]!.args, { app: "Safari", x: 200, y: 100 });
  assert.deepEqual(backend.calls[2]!.args, { app: "Safari", from_x: 20, from_y: 40, to_x: 60, to_y: 80 });
  assert.deepEqual(backend.calls[3]!.args, { app: "Notes", x: 100, y: 50 });
});

test("through the relay MCP session: hidden without the toolset, image blocks pass through with it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-computer-"));
  await writeFile(join(workspace, "a.txt"), "x");
  const toolset = new ComputerToolset({ backend: fakeBackend(checker(2560, 1600)), isLocallyEnabled: async () => true, audit: async () => undefined });
  const session = await RelayMcpSession.create(workspace, { computer: toolset });
  try {
    await session.execute({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await session.execute({ jsonrpc: "2.0", method: "notifications/initialized" });
    const without = await session.execute({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "r2", ["workspace"]) as { result: { tools: { name: string }[] } };
    assert.ok(!without.result.tools.some((tool) => tool.name.startsWith("computer_")));
    const denied = await session.execute({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "computer_list_apps", arguments: {} } }, "r3", ["workspace"]) as { result: { isError?: boolean } };
    assert.equal(denied.result.isError, true);
    const withTools = await session.execute({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, "r4", ["workspace", "computer"]) as { result: { tools: { name: string }[] } };
    assert.equal(withTools.result.tools.filter((tool) => tool.name.startsWith("computer_")).length, 9);
    const called = await session.execute({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "computer_get_app_state", arguments: { app: "Safari" } } }, "r5", ["workspace", "computer"]) as { result: { content: { type: string; data?: string }[] } };
    const image = called.result.content.find((item) => item.type === "image");
    assert.ok(image?.data);
    assert.ok(Buffer.byteLength(JSON.stringify(called)) < 6 * 1024 * 1024);
  } finally {
    await session.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
