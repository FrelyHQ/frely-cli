import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayMcpSession } from "./relay-mcp.js";

test("relay MCP session handles initialize and concurrent requests", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-relay-mcp-"));
  const session = await RelayMcpSession.create(workspace);
  try {
    const initialized = await session.execute({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(initialized.result?.serverInfo?.name, "frely-cli");
    await session.execute({ jsonrpc: "2.0", method: "notifications/initialized" });
    const [tools, info] = await Promise.all([
      session.execute({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      session.execute({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "workspace_info", arguments: {} } }),
    ]);
    assert.ok(tools && typeof tools === "object");
    assert.ok(info && typeof info === "object");
  } finally {
    await session.close();
  }
});

test("concurrent clients may reuse numeric or string IDs without mixing results", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-relay-shared-id-"));
  await writeFile(join(workspace, "a.txt"), "first-client");
  await writeFile(join(workspace, "b.txt"), "second-client");
  try {
    for (const clientId of [0, 7, "7", "shared-id"]) {
      let entered = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const session = await RelayMcpSession.create(workspace, {
        assertAuthorized: async () => { if (++entered === 2) release(); await barrier; },
      });
      try {
        const call = (file: string, relayId: string) => session.execute({ jsonrpc: "2.0", id: clientId, method: "tools/call", params: { name: "read_file", arguments: { path: file } } }, relayId);
        const [a, b] = await Promise.all([call("a.txt", "relay-request-aaa"), call("b.txt", "relay-request-bbb")]) as Array<{ id: string | number; result: { content: unknown[] } }>;
        assert.equal(a!.id, clientId);
        assert.equal(b!.id, clientId);
        assert.deepEqual(a!.result.content, [{ type: "text", text: "first-client" }]);
        assert.deepEqual(b!.result.content, [{ type: "text", text: "second-client" }]);
      } finally { release(); await session.close(); }
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("Relay cancellation isolates clients, skips queued mutations and permits safe ID reuse", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-relay-cancel-"));
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const session = await RelayMcpSession.create(workspace, { assertAuthorized: async () => { entered(); await barrier; } });
  const call = (id: string | number, path: string, relayId: string) => session.execute({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "write_file", arguments: { path, content: path } } }, relayId);
  try {
    const first = call(7, "cancelled.txt", "relay-request-aaa");
    const rejected = assert.rejects(first, /cancelled by Relay/);
    await started;
    const second = call(7, "second.txt", "relay-request-bbb");
    await assert.rejects(call(8, "duplicate.txt", "relay-request-bbb"), /Duplicate Device Relay request id/);
    session.cancel("relay-request-aaa");
    await rejected;
    const replacement = call("replacement", "replacement.txt", "relay-request-aaa");
    release();
    const [b, c] = await Promise.all([second, replacement]) as Array<{ id: string | number; result: { isError?: boolean } }>;
    assert.equal(b!.id, 7); assert.equal(b!.result.isError, undefined);
    assert.equal(c!.id, "replacement"); assert.equal(c!.result.isError, undefined);
    assert.equal(await readFile(join(workspace, "second.txt"), "utf8"), "second.txt");
    assert.equal(await readFile(join(workspace, "replacement.txt"), "utf8"), "replacement.txt");
    await assert.rejects(access(join(workspace, "cancelled.txt")));
    await assert.rejects(access(join(workspace, "duplicate.txt")));
  } finally { release(); await session.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("request diagnostics correlate tool failures without storing arguments, output or client IDs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-relay-diagnostics-"));
  const logs: string[] = [];
  const session = await RelayMcpSession.create(workspace, { log: (line) => logs.push(line) });
  try {
    const result = await session.execute({ jsonrpc: "2.0", id: "private-client-id", method: "tools/call", params: { name: "read_file", arguments: { path: "private-input-token" } } }, "relay-request-aaa") as { result: { isError: boolean } };
    assert.equal(result.result.isError, true);
    const events = logs.map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.event), ["mcp.request_started", "mcp.tool_failed", "mcp.request_completed"]);
    assert.ok(events.every((event) => event.requestId === "relay-request-aaa" && Number.isFinite(Date.parse(event.timestamp))));
    assert.equal(events[1].tool, "read_file");
    assert.equal(events[1].error.code, "ENOENT");
    assert.ok(events[1].error.stack.length > 0);
    assert.equal(events[2].outcome, "tool_error");
    assert.doesNotMatch(logs.join("\n"), /private-client-id|private-input-token/);
  } finally { await session.close(); await rm(workspace, { recursive: true, force: true }); }
});

test("relay MCP session reports malformed initialize as Invalid Request", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "frely-relay-mcp-invalid-"));
  const session = await RelayMcpSession.create(workspace);
  try {
    const response = await session.execute({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) as {
      error?: { code?: number; message?: string };
    };
    assert.deepEqual(response.error, { code: -32600, message: "Invalid Request" });
  } finally {
    await session.close();
  }
});
