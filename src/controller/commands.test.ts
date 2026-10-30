import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Controller, ToolResult } from "./client.js";
import { runControllerCommand, useControllerOpener, waitForPermission } from "./commands.js";
import { EXIT } from "./session.js";

const text = (value: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...extra });

async function run(args: string[], reply: (name: string, input: Record<string, unknown>) => ToolResult) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const fake: Controller = { instructions: () => "Call list_devices first.", tools: async () => [{ name: "process", description: "Run things" }, { name: "read", annotations: { readOnlyHint: true } }], call: async (name, input) => { calls.push({ name, input }); return reply(name, input); }, close: async () => undefined };
  const restore = useControllerOpener(async () => fake);
  let out = "", err = "";
  try {
    const code = await runControllerCommand(args, { out: (value) => { out += value; }, err: (value) => { err += value; } });
    return { code, out, err, calls };
  } finally { restore(); }
}

test("devices prints a table", async () => {
  const result = await run(["devices"], () => text({ devices: [{ id: "drd_1", name: "box", online: true, mcp: "active", workspaces: ["/home/a"] }, { id: "drd_2", name: "old", online: false, mcp: "none", workspaces: null }] }));
  assert.equal(result.code, EXIT.ok);
  assert.match(result.out, /box\tonline\tactive\t\/home\/a/u);
  assert.match(result.out, /old\toffline\tnone\t-/u);
});

test("run sends the command and ends with 2 when the remote command failed", async () => {
  const ok = await run(["run", "box", "--cwd", "app", "--timeout", "20", "--", "echo", "hi"], () => text("", { structuredContent: { stdout: "hi\n", stderr: "", exitCode: 0 } }));
  assert.deepEqual(ok.calls[0], { name: "process", input: { device: "box", action: "run", command: "echo hi", cwd: "app", timeoutMs: 20000 } });
  assert.equal(ok.out, "hi\n");
  assert.equal(ok.code, EXIT.ok);
  const failed = await run(["run", "box", "--", "false"], () => text("", { structuredContent: { stdout: "", stderr: "boom\n", exitCode: 3 } }));
  assert.equal(failed.out, "boom\n");
  assert.equal(failed.code, EXIT.tool);
  assert.equal((await run(["run", "box", "--background", "--", "sleep", "9"], () => text({}))).calls[0]!.input.action, "start");
  assert.equal((await run(["run", "box"], () => text({}))).code, EXIT.cli);
});

test("a device that needs approval ends with 3 and the wait command", async () => {
  const result = await run(["permission", "request", "box", "--resource", "ssh", "--reason", "deploy", "--command", "ssh host true", "--no-wait"], () => text("Approval required", { structuredContent: { status: "pending", device: "box", approveUrl: "https://frely.test/device?g=QWERTY", shortCode: "QWERTY" } }));
  assert.equal(result.code, EXIT.approval);
  assert.match(result.err, /frely permission wait QWERTY/u);
  assert.deepEqual(result.calls[0]!.input, { device: "box", resource: "ssh", reason: "deploy", command: "ssh host true" });
});

test("an offline device ends with 5", async () => {
  const result = await run(["read", "laptop:notes.txt"], () => text("Frely device is offline. On that computer, run `frely link on`, then try again.", { isError: true }));
  assert.equal(result.code, EXIT.offline);
  assert.match(result.out, /frely link on/u);
});

test("read, ls and grep address the device by device:path and refuse local paths", async () => {
  const read = await run(["read", "box:src/a.ts", "--lines", "5:9"], () => text("", { structuredContent: { content: "line\n" } }));
  assert.deepEqual(read.calls[0], { name: "read", input: { device: "box", action: "read", path: "src/a.ts", startLine: 5, endLine: 9 } });
  assert.equal(read.out, "line\n");
  assert.deepEqual((await run(["ls", "box"], () => text({}))).calls[0]!.input, { device: "box", action: "roots" });
  assert.deepEqual((await run(["ls", "box:src"], () => text({}))).calls[0]!.input, { device: "box", action: "list", path: "src" });
  assert.deepEqual((await run(["grep", "box:src", "todo", "--regex", "--max", "5"], () => text({}))).calls[0]!.input, { device: "box", action: "search", path: "src", query: "todo", regex: true, caseSensitive: false, maxResults: 5 });
  assert.equal((await run(["read", "C:\\Users\\a\\x.txt"], () => text({}))).code, EXIT.cli);
  assert.equal((await run(["read", "notes.txt"], () => text({}))).code, EXIT.cli);
});

test("--out writes the output to a file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-out-"));
  const file = join(dir, "big.txt");
  const result = await run(["read", "box:big.log", "--out", file], () => text("", { structuredContent: { content: "x".repeat(5000) } }));
  assert.equal(result.code, EXIT.ok);
  assert.match(result.out, /Wrote 5000 bytes/u);
  assert.equal((await readFile(file, "utf8")).trim().length, 5000);
});

test("edit sends a local file as text, or as base64 when it is binary, and a patch as edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-edit-"));
  await writeFile(join(dir, "a.txt"), "hello");
  await writeFile(join(dir, "b.bin"), Buffer.from([0xff, 0xfe, 0x00]));
  await writeFile(join(dir, "p.json"), JSON.stringify([{ startLine: 1, endLine: 1, replacement: "z" }]));
  assert.deepEqual((await run(["edit", "box:a.txt", "--from", join(dir, "a.txt"), "--overwrite"], () => text({}))).calls[0]!.input, { device: "box", path: "a.txt", content: "hello", overwrite: true });
  assert.deepEqual((await run(["edit", "box:b.bin", "--from", join(dir, "b.bin")], () => text({}))).calls[0]!.input, { device: "box", path: "b.bin", contentBase64: "//4A", overwrite: false });
  assert.deepEqual((await run(["edit", "box:a.txt", "--patch", join(dir, "p.json")], () => text({}))).calls[0]!.input, { device: "box", path: "a.txt", edits: [{ startLine: 1, endLine: 1, replacement: "z" }] });
  assert.equal((await run(["edit", "box:a.txt"], () => text({}))).code, EXIT.cli);
  assert.equal((await run(["edit", "box:a.txt", "--from", join(dir, "missing")], () => text({}))).code, EXIT.cli);
});

test("call takes a JSON object after --json, and a bare --json asks for the full result", async () => {
  const withInput = await run(["call", "web_fetch", "--json", "{\"url\":\"https://example.test\"}"], () => text("ok"));
  assert.deepEqual(withInput.calls[0], { name: "web_fetch", input: { url: "https://example.test" } });
  const full = await run(["call", "store", "--json"], () => text("ok"));
  assert.deepEqual(full.calls[0]!.input, {});
  assert.match(full.out, /"content"/u);
  assert.equal((await run(["call", "x", "--json", "{nope"], () => text("ok"))).code, EXIT.cli);
});

test("tools prints the server's own instructions first", async () => {
  const result = await run(["tools"], () => text({}));
  assert.ok(result.out.startsWith("Call list_devices first."));
  assert.match(result.out, /read \[read\]/u);
});

test("waiting for a permission: approved is 0, denied 2, expired or out of time 3", async () => {
  const statuses = (...list: string[]) => { let i = 0; return { call: async () => text("", { structuredContent: { status: list[Math.min(i++, list.length - 1)], mode: "once" } }) }; };
  const io = () => { const output = { out: "", err: "" }; return { output, io: { out: (value: string) => { output.out += value; }, err: (value: string) => { output.err += value; } } }; };
  const fast = { intervalMs: 1, sleep: async () => undefined };
  const approved = io();
  assert.equal(await waitForPermission(statuses("pending", "pending", "approved"), { code: "ABCDEFGH" }, 60_000, approved.io, fast), EXIT.ok);
  assert.match(approved.output.out, /Approved \(once\)/u);
  assert.equal(await waitForPermission(statuses("denied"), { code: "ABCDEFGH" }, 60_000, io().io, fast), EXIT.tool);
  assert.equal(await waitForPermission(statuses("expired"), { code: "ABCDEFGH" }, 60_000, io().io, fast), EXIT.approval);
  const used = io();
  assert.equal(await waitForPermission(statuses("used"), { code: "CDEFGHJK" }, 60_000, used.io, fast), EXIT.tool);
  assert.match(used.output.err, /already used/u);
  let now = 0;
  assert.equal(await waitForPermission(statuses("pending"), { code: "ABCDEFGH" }, 10, io().io, { intervalMs: 5, now: () => (now += 6), sleep: async () => undefined }), EXIT.approval);
});

test("permission wait asks the server to hold the call and takes only an approval code", async () => {
  const byCode = await run(["permission", "wait", "abcd-efgh"], () => text("", { structuredContent: { status: "approved" } }));
  assert.deepEqual(byCode.calls[0]!.input, { code: "ABCDEFGH", wait: true });
  assert.equal(byCode.code, EXIT.ok);
  assert.equal((await run(["permission", "wait", "cloud_confirm_0123"], () => text({}))).code, EXIT.cli);
});

test("permission wait --then runs the original command once approved", async () => {
  const result = await run(["permission", "wait", "abcdefgh", "--then", "exit 7"], () => text("", { structuredContent: { status: "approved", mode: "once" } }));
  assert.equal(result.calls[0]!.input.code, "ABCDEFGH");
  assert.equal(result.code, 7);
  assert.equal((await run(["permission", "wait", "not valid!"], () => text({}))).code, EXIT.cli);
});
