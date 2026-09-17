import assert from "node:assert/strict";
import test from "node:test";
import { doctor, formatDoctor } from "./diagnostics.js";
import type { McpMetadata } from "./mcp-authorization.js";
import type { DeviceBinding } from "./device/state.js";
import { HEARTBEAT_MAX_AGE_MS, type ConnectionStatus } from "./device/connection-status.js";

function fixture() {
  const binding: DeviceBinding = { version: 2, relayUrl: "https://test.invalid", userId: "user_test",
    deviceId: "drd_" + "a".repeat(32), publicKeySpki: "synthetic", keyThumbprint: "synthetic", updatedAt: new Date().toISOString() };
  const metadata: McpMetadata = { version: 1, relayUrl: binding.relayUrl, userId: binding.userId,
    mcpResource: "https://mcp.test.invalid/mcp/" + binding.deviceId,
    grant: { id: "mca_" + "b".repeat(32), deviceId: binding.deviceId, keyThumbprint: "synthetic",
      workspace: "/test/workspace", days: 1, approvalDeadline: new Date().toISOString(),
      approvedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), status: "active" } };
  const connection: ConnectionStatus = { version: 1, pid: process.pid, relayUrl: binding.relayUrl, userId: binding.userId,
    deviceId: binding.deviceId, workspace: metadata.grant.workspace, authorizationId: metadata.grant.id,
    state: "connected", mcpEnabled: true, updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  const calls = { session: 0, mcp: 0, storage: 0 };
  const dependencies: NonNullable<Parameters<typeof doctor>[1]> = {
    inspectUpgrade: async () => ({ currentVersion: "0.6.2", latestVersion: "0.6.2", state: "current" as const, message: "Up to date.", installation: { method: "npm" as const, entry: "/test/npm/frely", platform: process.platform } }),
    inspectAuth: async () => ({ configured: true, credentialStored: true, relayUrl: binding.relayUrl,
      user: { id: binding.userId, email: "user@example.com" }, configPath: "/test/config.json" }),
    inspectMcpMetadata: async () => metadata, readDeviceBinding: async () => binding,
    readConnectionStatus: async () => connection,
    serviceStatus: async () => ({ installed: true, active: true, platform: process.platform }),
    probeCredentialStore: async () => { calls.storage++; },
    whoami: async () => { calls.session++; return { id: binding.userId, email: "user@example.com" }; },
    requireMcpAuthorization: async () => { calls.mcp++; return { ...metadata, mcpUrl: metadata.mcpResource, sign: () => "unused" }; },
  };
  return { binding, metadata, connection, calls, dependencies };
}

test("doctor summary is concise and performs no account, keyring or write probes", async () => {
  const f = fixture(), report = await doctor({}, f.dependencies);
  assert.equal(report.ok, true);
  assert.deepEqual(f.calls, { session: 0, mcp: 0, storage: 0 });
  assert.equal(report.details, undefined);
  assert.match(report.summary.connection, /recent heartbeat/);
  const output = formatDoctor(report);
  assert.equal(output.trim().split("\n").length, 8);
  assert.doesNotMatch(output, /\/test\/config|\/test\/workspace|mca_/);
  assert.match(output, /frely doctor -v/);
});

test("doctor verbose validates configured capabilities and reports failures without secrets", async () => {
  const f = fixture();
  f.dependencies.requireMcpAuthorization = async () => { f.calls.mcp++; throw new Error("token=synthetic-secret"); };
  const report = await doctor({ verbose: true }, f.dependencies);
  assert.equal(report.ok, false);
  assert.deepEqual(f.calls, { session: 1, mcp: 1, storage: 1 });
  assert.equal(report.details?.configPath, "/test/config.json");
  assert.equal(report.details?.connection.live, true);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-secret/);
  assert.match(formatDoctor(report), /mcp_authorization/);
});

test("doctor never treats a running service or stale/future heartbeat as a live connection", async () => {
  for (const heartbeatAt of [undefined, new Date(Date.now() - HEARTBEAT_MAX_AGE_MS - 1000).toISOString(),
    new Date(Date.now() + 60_000).toISOString()]) {
    const f = fixture(); f.connection.heartbeatAt = heartbeatAt;
    const report = await doctor({ verbose: true }, f.dependencies);
    assert.equal(report.ok, false);
    assert.equal(report.details?.service?.active, true);
    assert.equal(report.details?.connection.live, false);
    assert.equal(report.details?.connection.state, "unknown");
  }
});

test("doctor distinguishes transport health from MCP authorization and workspace readiness", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.connection.mcpEnabled = false; },
    (f: ReturnType<typeof fixture>) => { f.connection.workspace = "/other"; },
    (f: ReturnType<typeof fixture>) => { f.connection.authorizationId = "mca_" + "c".repeat(32); },
    (f: ReturnType<typeof fixture>) => { f.metadata.grant.expiresAt = new Date(Date.now() - 1).toISOString(); },
  ]) {
    const f = fixture(); change(f);
    const report = await doctor({ verbose: true }, f.dependencies);
    assert.equal(report.ok, false);
    assert.equal(report.details?.connection.live, true);
    assert.equal(report.details?.connection.mcpReady, false);
  }
  const f = fixture(); f.binding.userId = "other";
  assert.equal((await doctor({}, f.dependencies)).ok, false);
});

test("doctor distinguishes disconnected and stopped, and accepts a healthy foreground relay", async () => {
  const f = fixture();
  f.dependencies.serviceStatus = async () => ({ installed: false, active: false, platform: process.platform });
  assert.equal((await doctor({}, f.dependencies)).ok, true);
  for (const state of ["disconnected", "stopped"] as const) {
    f.connection.state = state;
    const report = await doctor({ verbose: true }, f.dependencies);
    assert.equal(report.ok, false);
    assert.equal(report.details?.connection.state, state);
  }
});

test("unconfigured MCP is optional; legacy strict MCP diagnostics remain strict", async () => {
  const f = fixture();
  f.dependencies.inspectAuth = async () => ({ configured: false, credentialStored: false, configPath: "/test/config.json" });
  f.dependencies.inspectMcpMetadata = async () => null;
  f.dependencies.readDeviceBinding = async () => null;
  const report = await doctor({}, f.dependencies);
  assert.equal(report.ok, true);
  assert.match(report.summary.mcp, /Not enabled/);
  assert.equal((await doctor({ mcp: true }, f.dependencies)).ok, false);
});

test("invalid MCP metadata is a failure, not silently treated as optional", async () => {
  const f = fixture();
  f.dependencies.inspectMcpMetadata = async () => { throw new Error("invalid config with synthetic-secret"); };
  const report = await doctor({}, f.dependencies);
  assert.equal(report.ok, false);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-secret/);
});


test("doctor exposes version checks as informational when an update is available or the registry is offline", async () => {
  for (const state of ["available", "unavailable"] as const) {
    const f = fixture();
    f.dependencies.inspectUpgrade = async () => ({ currentVersion: "0.6.2", state,
      message: state === "available" ? "0.6.2 → 0.7.0. Run frely upgrade." : "Version lookup unavailable.",
      installation: { method: "npm", entry: "/test/npm/frely", platform: process.platform } });
    const result = await doctor({}, f.dependencies);
    assert.equal(result.ok, true);
    assert.equal(result.update.state, state);
    assert.equal(result.checks.find((check) => check.name === "upgrade")?.status, "info");
    assert.equal(result.summary.installation, "npm: /test/npm/frely");
  }
});
