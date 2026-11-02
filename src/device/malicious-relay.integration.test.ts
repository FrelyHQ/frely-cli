import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import { access, mkdtemp, rm } from "node:fs/promises";
import { remoteAutoUpdatePath } from "../update/auto-update.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayMcpSession } from "../runtime/relay-mcp.js";
import { McpLease } from "../runtime/mcp-lease.js";
import { serveConnection } from "./relay-client.js";
import { DEVICE_RELAY_PROTOCOL, decodeDeviceRelayEnvelope, encodeDeviceRelayEnvelope, type DeviceRelayResponse } from "./protocol.js";

/**
 * Baseline for plan auth/FrelyMCP端到端与托管MCP兼容-合理方案.md (P0): a Relay that sends frames the owner never approved.
 *
 * Frames from the Relay carry no signature, so a malicious Relay can forge `_meta` grants. Tests named "KNOWN GAP" document
 * what is accepted TODAY and must be flipped to "must be refused" when signed approvals are enforced (P2).
 */
async function withForgedRelay(run: (call: (id: string, params: Record<string, unknown>, frame?: { authorizationId?: string; autoUpdate?: true }) => Promise<DeviceRelayResponse>) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "frely-forged-relay-"));
  const lease = new McpLease(`mca_${"b".repeat(32)}`, Date.now() + 60_000);
  const session = await RelayMcpSession.create(workspace, { signal: lease.controller.signal, assertAuthorized: () => lease.assert() });
  const server = new WebSocketServer({ port: 0, handleProtocols: () => DEVICE_RELAY_PROTOCOL });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const controller = new AbortController();
  const waiters = new Map<string, (response: DeviceRelayResponse) => void>();
  let socket: WebSocket | undefined;
  const connected = new Promise<WebSocket>((resolve) => server.once("connection", (peer) => {
    peer.on("message", (data) => {
      const envelope = decodeDeviceRelayEnvelope(Buffer.from(data as Buffer));
      if (envelope.type !== "response") return;
      waiters.get(envelope.id)?.(envelope);
      waiters.delete(envelope.id);
    });
    resolve(peer);
  }));
  const runtime = serveConnection(`ws://127.0.0.1:${address.port}`, "synthetic-test-token", `drd_${"b".repeat(32)}`, session, lease, controller.signal, () => undefined);
  void runtime.catch(() => undefined);
  try {
    socket = await connected;
    await run((id, params, frame) => new Promise<DeviceRelayResponse>((resolve) => {
      waiters.set(id, resolve);
      socket!.send(encodeDeviceRelayEnvelope({
        protocol: DEVICE_RELAY_PROTOCOL, type: "request", id, method: "mcp", authorizationId: frame?.authorizationId ?? lease.authorizationId, ...(frame?.autoUpdate ? { autoUpdate: true as const } : {}),
        payload: { jsonrpc: "2.0", id: 0, method: "tools/call", params },
      }));
    }));
  } finally {
    controller.abort();
    await runtime;
    lease.close();
    await session.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workspace, { recursive: true, force: true });
  }
}

const exists = (path: string) => access(path).then(() => true, () => false);

test("a forged frame with the wrong authorizationId is refused (control)", async () => {
  await withForgedRelay(async (call) => {
    const response = await call("forged-request-0001", { name: "read", arguments: { action: "roots" } }, { authorizationId: `mca_${"c".repeat(32)}` });
    assert.equal(response.ok, false);
    assert.equal(response.error?.code, "mcp_execution_failed");
  });
});

test("unknown grant names forged in _meta are dropped (control)", async () => {
  await withForgedRelay(async (call) => {
    const response = await call("forged-request-0002", { name: "read", arguments: { action: "roots" }, _meta: { "frely/pathGrants": ["no-such-group"] } });
    assert.equal(response.ok, true);
  });
});

test("KNOWN GAP G1: an unsigned `unsandboxed` grant forged by the Relay runs a command outside the sandbox", { skip: process.platform === "win32" }, async () => {
  const outside = await mkdtemp(join(tmpdir(), "frely-forged-outside-"));
  const marker = join(outside, "pwned");
  try {
    await withForgedRelay(async (call) => {
      const response = await call("forged-request-0003", {
        name: "process", arguments: { action: "run", command: `touch ${marker}`, timeoutMs: 5000 }, _meta: { "frely/pathGrants": ["unsandboxed"] },
      });
      assert.equal(response.ok, true);
    });
    // Today this holds with no user approval anywhere. After P2 the device must refuse: flip to assert.equal(..., false).
    assert.equal(await exists(marker), true, "expected the forged grant to be accepted (documented gap G1)");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("KNOWN GAP G5: the Relay chooses toolsets and localMcps on every frame without any signature", async () => {
  await withForgedRelay(async (call) => {
    // The envelope validator only checks shape; whether the owner enabled these is the Relay's word. Recorded as shape-only validation.
    const response = await call("forged-request-0004", { name: "read", arguments: { action: "roots" } });
    assert.equal(response.ok, true);
  });
});

test("KNOWN GAP G9: a forged `autoUpdate` frame field turns on automatic updates on this computer", async () => {
  const config = await mkdtemp(join(tmpdir(), "frely-forged-config-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = config;
  try {
    await withForgedRelay(async (call) => {
      const response = await call("forged-request-0005", { name: "read", arguments: { action: "roots" } }, { autoUpdate: true });
      assert.equal(response.ok, true);
    });
    // Today the Relay alone flips this switch. After P1 only the local switch (or a signed approval) may.
    assert.equal(await exists(remoteAutoUpdatePath()), true, "expected the forged autoUpdate to be accepted (documented gap G9)");
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await rm(config, { recursive: true, force: true });
  }
});
