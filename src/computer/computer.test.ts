import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAppAllowed, isBlockedApp, redactBlockedAppLines } from "./guard.js";
import { decodePngPixels, downscalePng, encodeRgbaPng } from "./image.js";
import type { OcuBackend, OcuResult, OcuTool } from "./ocu.js";
import { ComputerToolset } from "./toolset.js";
import type { ComputerAuditEntry } from "./state.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { computerLocallyEnabled, createComputerMcpServer } from "./server.js";
import { runComputerCommand } from "./command.js";
import { installOcuRuntime, OcuRuntimeError } from "./runtime.js";
import { addManualEntry, loadManualEntries, LocalMcpHub } from "../runtime/local-mcp.js";
import { builtinLocalMcps } from "./builtin.js";
import { StdioOcuBackend } from "./ocu.js";

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
  const refused = await toolset.call("click", { app: "Safari", x: 1, y: 1 });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.text!, /turned off/);
  enabled = true;
  const names = (await toolset.listTools()).map((tool) => tool.name);
  assert.equal(names.length, 9);
  assert.ok(names.every((name) => name.startsWith("")));
  assert.ok(!names.includes("run_shell"));
  assert.ok(!(await toolset.listTools())[0]!.description!.includes("plugin"));
  assert.equal((await toolset.call("run_shell", {})).isError, true);
});

test("blocked apps never reach the backend; list is redacted; audit holds metadata only", async () => {
  const backend = fakeBackend(checker(100, 100));
  const audit: ComputerAuditEntry[] = [];
  const toolset = new ComputerToolset({ backend, isLocallyEnabled: async () => true, audit: async (entry) => { audit.push(entry); } });
  const blocked = await toolset.call("type_text", { app: "com.apple.Terminal", text: "rm -rf ~" });
  assert.equal(blocked.isError, true);
  assert.equal(backend.calls.length, 0);
  const list = await toolset.call("list_apps", {});
  assert.equal(list.content[0]!.text, "Safari — com.apple.Safari");
  await toolset.call("type_text", { app: "Safari", text: "secret typed text" });
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map((entry) => entry.ok), [false, true, true]);
  assert.equal(audit[0]!.reason, "blocked");
  assert.ok(!JSON.stringify(audit).includes("secret typed text") && !JSON.stringify(audit).includes("rm -rf"));
});

test("model coordinates are mapped back to device pixels using the latest screenshot scale of that app", async () => {
  const backend = fakeBackend(checker(2560, 1600));
  const toolset = new ComputerToolset({ backend, isLocallyEnabled: async () => true, audit: async () => undefined });
  const state = await toolset.call("get_app_state", { app: "Safari" });
  const image = state.content.find((item) => item.type === "image")!;
  assert.deepEqual([decodePngPixels(Buffer.from(image.data!, "base64"))!.width], [1280]);
  await toolset.call("click", { app: "Safari", x: 100, y: 50 });
  await toolset.call("drag", { app: "Safari", from_x: 10, from_y: 20, to_x: 30, to_y: 40 });
  await toolset.call("click", { app: "Notes", x: 100, y: 50 });
  assert.deepEqual(backend.calls[1]!.args, { app: "Safari", x: 200, y: 100 });
  assert.deepEqual(backend.calls[2]!.args, { app: "Safari", from_x: 20, from_y: 40, to_x: 60, to_y: 80 });
  assert.deepEqual(backend.calls[3]!.args, { app: "Notes", x: 100, y: 50 });
});

test("the MCP server lists the reviewed tools and passes image blocks through intact", async () => {
  const toolset = new ComputerToolset({ backend: fakeBackend(checker(2560, 1600)), isLocallyEnabled: async () => true, audit: async () => undefined });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createComputerMcpServer(toolset);
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);
    assert.ok(!tools.some((tool) => tool.name === "run_shell"));
    const blocked = await client.callTool({ name: "click", arguments: { app: "Terminal", x: 1, y: 1 } });
    assert.equal(blocked.isError, true);
    const called = await client.callTool({ name: "get_app_state", arguments: { app: "Safari" } });
    const image = (called.content as { type: string; data?: string; mimeType?: string }[]).find((item) => item.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.equal(decodePngPixels(Buffer.from(image!.data!, "base64"))!.width, 1280);
    assert.ok(Buffer.byteLength(JSON.stringify(called)) < 6 * 1024 * 1024);
  } finally {
    await client.close();
  }
});

test("computer use is built in: offered without registration, `disable` is a local veto and `enable` lifts it", async () => {
  const home = await mkdtemp(join(tmpdir(), "frely-computer-cmd-"));
  const previous = process.env.XDG_CONFIG_HOME;
  const previousBin = process.env.FRELY_COMPUTER_BIN;
  process.env.XDG_CONFIG_HOME = home;
  process.env.FRELY_COMPUTER_BIN = join(home, "ocu-stub");
  await writeFile(process.env.FRELY_COMPUTER_BIN, "stub");
  try {
    // Nothing is registered, yet the device offers `computer`.
    assert.deepEqual(await loadManualEntries(), []);
    const offered = await builtinLocalMcps("/cli/index.js");
    assert.equal(offered[0]?.name, "computer");
    assert.equal(offered[0]?.transport, "stdio");
    assert.deepEqual(offered[0] && offered[0].transport === "stdio" ? offered[0].args.slice(-2) : [], ["computer", "mcp"]);
    assert.equal(await computerLocallyEnabled(), true);
    assert.match(await runComputerCommand(["status"]), /allowed here/);
    // The veto removes it from the device's offer and from the toolset at once.
    assert.match(await runComputerCommand(["disable"]), /blocked on this device/);
    assert.deepEqual(await builtinLocalMcps("/cli/index.js"), []);
    assert.equal(await computerLocallyEnabled(), false);
    assert.equal(JSON.parse(await runComputerCommand(["status", "--json"])).enabled, false);
    assert.match(await runComputerCommand(["disable"]), /already blocked/);
    // Enable lifts the veto and drops an entry an older `frely computer enable` registered by hand.
    await addManualEntry({ name: "computer", transport: "stdio", command: "old", args: [] });
    assert.match(await runComputerCommand(["enable"]), /stays off until you turn it on/);
    assert.equal((await builtinLocalMcps("/cli/index.js")).length, 1);
    assert.equal((await loadManualEntries()).some((item) => item.name === "computer"), false);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    if (previousBin === undefined) delete process.env.FRELY_COMPUTER_BIN; else process.env.FRELY_COMPUTER_BIN = previousBin;
    await rm(home, { recursive: true, force: true });
  }
});

test("the hub lists the built-in computer entry first, a manual entry of that name wins, and the veto hides it", async () => {
  const builtin = async () => [{ name: "computer", source: "manual" as const, transport: "stdio" as const, command: "frely", args: ["computer", "mcp"] }];
  const manual = [{ name: "notes", source: "manual" as const, transport: "http" as const, url: "http://127.0.0.1:9/mcp" }];
  const scanned = async (loadBuiltin: () => Promise<never[] | Awaited<ReturnType<typeof builtin>>>, loadManual = async () => manual) => {
    const hub = new LocalMcpHub({ loadManual, loadBuiltin, discovery: { listPorts: async () => [], probe: async () => null } });
    await hub.refresh();
    return hub.capabilities();
  };
  assert.deepEqual(await scanned(builtin), [{ name: "computer", transport: "stdio" }, { name: "notes", transport: "http" }]);
  assert.deepEqual(await scanned(async () => []), [{ name: "notes", transport: "http" }]);
  assert.deepEqual(await scanned(builtin, async () => [{ name: "computer", source: "manual" as const, transport: "http" as const, url: "http://127.0.0.1:9/mcp" }]), [{ name: "computer", transport: "http" }]);
});

test("the runtime installs on first use, once for concurrent calls, and a failed install is reported", async () => {
  const home = await mkdtemp(join(tmpdir(), "frely-computer-first-"));
  const binary = join(home, "bin", "open-computer-use");
  try {
    let installs = 0;
    const install = async () => { installs += 1; await new Promise((resolve) => setTimeout(resolve, 20)); await mkdir(join(home, "bin"), { recursive: true }); await writeFile(binary, "stub"); };
    const backend = new StdioOcuBackend(binary, install);
    // The stub is not a real MCP server, so connecting fails after the install; the install itself is what is under test.
    await Promise.allSettled([backend.listTools(), backend.listTools()]);
    assert.equal(installs, 1);
    await access(binary);
    const failing = new StdioOcuBackend(join(home, "missing", "open-computer-use"), async () => { throw new Error("offline"); });
    await assert.rejects(failing.listTools(), /Could not install the computer-use runtime: offline/);
    await assert.rejects(new StdioOcuBackend(join(home, "none")).listTools(), /not installed/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

async function runtimeFixture(platform: NodeJS.Platform, arch: string) {
  const root = await mkdtemp(join(tmpdir(), "frely-computer-rt-"));
  const pkg = join(root, "package", "dist");
  const cpu = arch === "arm64" ? "arm64" : "amd64";
  if (platform === "darwin") { await mkdir(join(pkg, "Open Computer Use.app", "Contents", "MacOS"), { recursive: true }); await writeFile(join(pkg, "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"), "mac"); }
  else if (platform === "win32") { await mkdir(join(pkg, "windows", cpu), { recursive: true }); await writeFile(join(pkg, "windows", cpu, "open-computer-use.exe"), "win"); }
  else { await mkdir(join(pkg, "linux", cpu), { recursive: true }); await writeFile(join(pkg, "linux", cpu, "open-computer-use"), "linux"); }
  await mkdir(join(pkg, "other"), { recursive: true }); await writeFile(join(pkg, "other", "x"), "x");
  execFileSync("tar", ["-czf", join(root, "pkg.tgz"), "-C", root, "package"]);
  const bytes = await readFile(join(root, "pkg.tgz"));
  return { root, bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

test("runtime install verifies the pinned checksum and installs only this platform's binary", async () => {
  for (const [platform, arch, relative, content] of [["linux", "x64", "open-computer-use", "linux"], ["win32", "arm64", "open-computer-use.exe", "win"], ["darwin", "arm64", join("Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"), "mac"]] as const) {
    const fixture = await runtimeFixture(platform, arch);
    const home = await mkdtemp(join(tmpdir(), "frely-computer-bin-"));
    try {
      const binaryPath = join(home, "bin", "0.0.0", relative);
      const fetchImpl = (async () => new Response(fixture.bytes)) as typeof fetch;
      const installed = await installOcuRuntime({ fetchImpl, url: "http://fixture/pkg.tgz", integrity: fixture.integrity, platform, arch, binaryPath });
      assert.equal(installed, binaryPath);
      assert.equal(await readFile(binaryPath, "utf8"), content);
      await assert.rejects(access(join(home, "bin", "0.0.0", "other")));
      if (platform === "linux" && process.platform !== "win32") assert.notEqual((await stat(binaryPath)).mode & 0o111, 0);
      await installOcuRuntime({ fetchImpl, url: "http://fixture/pkg.tgz", integrity: fixture.integrity, platform, arch, binaryPath });
    } finally { await rm(home, { recursive: true, force: true }); await rm(fixture.root, { recursive: true, force: true }); }
  }
});

test("runtime install refuses a wrong checksum, a failed download and unsupported platforms", async () => {
  const fixture = await runtimeFixture("linux", "x64");
  const home = await mkdtemp(join(tmpdir(), "frely-computer-bin-"));
  const binaryPath = join(home, "bin", "0.0.0", "open-computer-use");
  try {
    const good = (async () => new Response(fixture.bytes)) as typeof fetch;
    await assert.rejects(installOcuRuntime({ fetchImpl: good, url: "http://fixture/pkg.tgz", integrity: "sha512-AAAA", platform: "linux", arch: "x64", binaryPath }), (error: unknown) => error instanceof OcuRuntimeError && error.code === "integrity_mismatch");
    await assert.rejects(access(binaryPath));
    await assert.rejects(installOcuRuntime({ fetchImpl: (async () => new Response("no", { status: 503 })) as typeof fetch, url: "http://fixture/pkg.tgz", integrity: fixture.integrity, platform: "linux", arch: "x64", binaryPath }), (error: unknown) => error instanceof OcuRuntimeError && error.code === "download_failed");
    await assert.rejects(installOcuRuntime({ fetchImpl: good, url: "http://fixture/pkg.tgz", integrity: fixture.integrity, platform: "freebsd", arch: "x64", binaryPath }), (error: unknown) => error instanceof OcuRuntimeError && error.code === "unsupported_platform");
    await assert.rejects(installOcuRuntime({ url: "http://example.invalid/pkg.tgz", platform: "linux", arch: "x64", binaryPath }), (error: unknown) => error instanceof OcuRuntimeError && error.code === "download_failed");
  } finally { await rm(home, { recursive: true, force: true }); await rm(fixture.root, { recursive: true, force: true }); }
});

test("a missing-permission error is rewritten and starts doctor once per interval", async () => {
  const backend: OcuBackend = {
    listTools: async () => [],
    callTool: async () => ({ isError: true, content: [{ type: "text", text: "Accessibility permission is required. Run `open-computer-use doctor`." }] }),
    close: async () => undefined,
  };
  let doctorRuns = 0;
  const toolset = new ComputerToolset({ backend, isLocallyEnabled: async () => true, audit: async () => undefined, runDoctor: async () => { doctorRuns += 1; } });
  const first = await toolset.call("click", { app: "Safari", x: 1, y: 1 });
  await toolset.call("click", { app: "Safari", x: 1, y: 1 });
  assert.equal(first.isError, true);
  assert.match(first.content[0]!.text!, /frely computer doctor/);
  assert.doesNotMatch(first.content[0]!.text!, /open-computer-use doctor/);
  assert.equal(doctorRuns, 1);
});
