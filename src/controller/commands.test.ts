import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Controller, ToolResult } from "./client.js";
import { runControllerCommand, useControllerOpener, waitForPermission } from "./commands.js";
import { EXIT } from "./client.js";

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

import { mkdir, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Workspace } from "../runtime/workspace.js";
import { createHash } from "node:crypto";
import { useTransferIo } from "./commands.js";
import { prepareLocalUpload } from "../local-transfer.js";

const PRESIGNED = "https://storage.example/obj?X-Amz-Signature=SECRET";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const view = { id: "tr_1", name: "pic.png", bytes: 5, expiresAt: "2026-12-01T00:00:00Z", visibility: "self", url: "https://frely.cloud/f/abc123" };

test("put uploads a local file, completes it and prints the short link without the presigned address", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-put-"));
  await writeFile(join(dir, "pic.png"), "hello");
  const uploads: Array<{ url: string; headers?: Record<string, string> }> = [];
  const restore = useTransferIo({ prepare: async (path) => ({ ...(await prepareLocalUpload(path)), send: async (target) => { uploads.push(target); } }) });
  try {
    const reply = (name: string, input: Record<string, unknown>) => input.action === "upload_link" ? text({ id: "tr_1", upload: { url: PRESIGNED, method: "PUT", headers: { "content-type": "image/png" } } }) : text(view);
    const result = await run(["put", join(dir, "pic.png")], reply);
    assert.equal(result.code, EXIT.ok);
    assert.equal(result.out.split("\n")[0], "https://frely.cloud/f/abc123");
    assert.ok(!result.out.includes("SECRET") && !result.err.includes("SECRET"));
    assert.deepEqual(result.calls.map((call) => call.input.action), ["upload_link", "complete"]);
    assert.deepEqual(result.calls[0]!.input, { action: "upload_link", name: "pic.png", bytes: 5, sha256: sha("hello") });
    assert.equal(uploads[0]!.url, PRESIGNED);
    const json = await run(["put", join(dir, "pic.png"), "--json"], reply);
    assert.deepEqual(JSON.parse(json.out), { url: view.url, id: "tr_1", name: "pic.png", bytes: 5, expiresAt: view.expiresAt, visibility: "self" });
    assert.ok(!json.out.includes("SECRET"));
  } finally { restore(); }
});

test("put of device:path asks the relay to pull the file, and a missing local file is a usage error", async () => {
  const sent = await run(["put", "box:out/a.png"], () => text(view));
  assert.deepEqual(sent.calls[0]!.input, { action: "send", device: "box", path: "out/a.png" });
  assert.match(sent.out, /^https:\/\/frely\.cloud\/f\/abc123/u);
  const missing = await run(["put", "/nonexistent/file.bin"], () => text(view));
  assert.equal(missing.code, EXIT.cli);
  assert.equal(missing.calls.length, 0);
  assert.equal((await run(["put"], () => text({}))).code, EXIT.cli);
});

test("get downloads with the checked size and sha256, and refuses to overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-get-"));
  const seen: Array<{ url: string; expected: { bytes: number; sha256: string }; overwrite: boolean }> = [];
  const restore = useTransferIo({ download: async (path, target, expected, overwrite) => {
    seen.push({ url: target.url, expected, overwrite });
    await mkdir(dirname(path), { recursive: true });
    const workspace = await Workspace.open(dirname(path));
    await workspace.writeStream(basename(path), (async function* () { yield Buffer.from("hello"); })(), overwrite, expected);
  } });
  try {
    const reply = () => text({ ...view, sha256: sha("hello"), download: { url: PRESIGNED } });
    const destination = join(dir, "sub", "out.png");
    const first = await run(["get", "tr_1", destination], reply);
    assert.equal(first.code, EXIT.ok);
    assert.equal(await readFile(destination, "utf8"), "hello");
    assert.ok(!first.out.includes("SECRET"));
    assert.deepEqual(seen[0], { url: PRESIGNED, expected: { bytes: 5, sha256: sha("hello") }, overwrite: false });
    const again = await run(["get", "tr_1", destination], reply);
    assert.equal(again.code, EXIT.cli);
    assert.match(again.err, /--overwrite/u);
    assert.equal(seen.length, 1);
    assert.equal((await run(["get", "tr_1", destination, "--overwrite"], reply)).code, EXIT.ok);
    assert.equal(seen[1]!.overwrite, true);
    await mkdir(join(dir, "x"), { recursive: true });
    assert.ok((await stat(join(dir, "x"))).isDirectory());
  } finally { restore(); }
});

test("get to a device uses transfer receive", async () => {
  const result = await run(["get", "tr_1", "box:in/a.png", "--overwrite"], () => text({ ok: true }));
  assert.deepEqual(result.calls[0]!.input, { action: "receive", id: "tr_1", device: "box", path: "in/a.png", overwrite: true });
  assert.equal(result.code, EXIT.ok);
});

test("files lists, deletes and validates the share scope", async () => {
  const listed = await run(["files"], () => text({ transfers: [view] }));
  assert.match(listed.out, /ID\tNAME\tSIZE\tVISIBILITY\tEXPIRES\tURL/u);
  assert.match(listed.out, /tr_1\tpic\.png\t5 B\tself\t2026-12-01T00:00:00Z\thttps:\/\/frely\.cloud\/f\/abc123/u);
  assert.deepEqual((await run(["files", "rm", "tr_1"], () => text({}))).calls[0]!.input, { action: "delete", id: "tr_1" });
  assert.deepEqual((await run(["files", "share", "tr_1", "--scope", "team"], () => text({}))).calls[0]!.input, { action: "share", id: "tr_1", scope: "team" });
  for (const bad of [["files", "share", "tr_1"], ["files", "share", "tr_1", "--scope", "public"], ["files", "rm"], ["files", "bogus"]]) {
    const result = await run(bad, () => text({}));
    assert.equal(result.code, EXIT.cli, bad.join(" "));
    assert.equal(result.calls.length, 0);
  }
});
