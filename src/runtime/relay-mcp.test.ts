import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
