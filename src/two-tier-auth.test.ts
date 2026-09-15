import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBasicCredentialStore, basicCredentialStore } from "./credential-basic.js";
import { credentialStore } from "./credential-store.js";
import { useMemoryCredentialStore } from "./test-support.js";
import { doctor } from "./diagnostics.js";
import { parseMcpDays, setupMcpAuthorization, revokeMcpAuthorization, mcpMetadataPath, type McpAuthorizationView } from "./mcp-authorization.js";
import { readDeviceBinding } from "./device/state.js";

test("basic private files preserve values without a keyring or an external key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-basic-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createBasicCredentialStore(join(directory, "sessions"));
  const account = "https://test.invalid";
  await store.setPassword("frely-cli-basic-v1", account, "synthetic\n会话");
  assert.equal(await store.getPassword("frely-cli-basic-v1", account), "synthetic\n会话");
  const files = await readdir(join(directory, "sessions"));
  const record = JSON.parse(await readFile(join(directory, "sessions", files[0]!), "utf8"));
  assert.equal(record.value, "synthetic\n会话"); // The documented storage tradeoff is plaintext.
  for (const service of ["frely-cli", "frely-cli-device", "frely-cli-mcp-authorization-v1"]) {
    await assert.rejects(store.setPassword(service, account, "not eligible"), /not eligible/);
  }
  assert.equal(await store.deletePassword("frely-cli-basic-v1", account), true);
  assert.equal(await store.getPassword("frely-cli-basic-v1", account), null);
});

test("MCP days validation accepts the product limits and rejects ambiguous values", () => {
  assert.equal(parseMcpDays(), 90);
  assert.equal(parseMcpDays("180"), 180);
  assert.equal(parseMcpDays(1), 1);
  for (const value of [0, 181, -1, NaN, Infinity, 1.5, "180days", "1e2", "", " 180", "--json"]) assert.throws(() => parseMcpDays(value));
});

test("MCP activation and renewal keep basic credentials and Provider identity separate", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-two-tier-"));
  const restore = useMemoryCredentialStore();
  const originalFetch = globalThis.fetch;
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER, FRELY_CREDENTIAL_STORE: process.env.FRELY_CREDENTIAL_STORE };
  process.env.XDG_CONFIG_HOME = directory; process.env.FRELY_NO_BROWSER = "1";
  process.env.FRELY_CREDENTIAL_STORE = "invalid-but-not-used-by-basic";
  t.after(async () => {
    restore(); globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal((await doctor()).ok, true);
  const relayUrl = "https://test.invalid", userId = "user_test", deviceId = `drd_${"1".repeat(32)}`;
  const mcpResource = `https://mcp.test.invalid/mcp/${deviceId}`;
  await mkdir(join(directory, "frely"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "frely", "config.json"), JSON.stringify({ version: 3, relayUrl, user: { id: userId, email: "user@example.com" } }), { mode: 0o600 });
  const basic = JSON.stringify({ version: 1, type: "basic-oauth", accessToken: "synthetic-basic", expiresAt: Date.now() + 3600000 });
  await basicCredentialStore.setPassword("frely-cli-basic-v1", relayUrl, basic);
  let sequence = 0, approvals = 0;
  let current: McpAuthorizationView | null = null;
  let approved = false;
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/me") return Response.json({ user: { id: userId, email: "user@example.com" } });
    if (path === "/api/user/device-relay/enroll") return Response.json({ deviceId });
    assert.equal(path, "/api/user/device-relay/mcp");
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      if (body.action === "revoke") { current = null; return Response.json({ status: "revoked" }); }
      assert.equal(body.action, "request");
      const key = createPublicKey({ key: Buffer.from(body.publicKeySpki, "base64url"), type: "spki", format: "der" });
      const message = JSON.stringify(["frely.mcp.request.v2", body.deviceId, body.keyThumbprint, body.days, body.workspace, body.issuedAt, body.nonce]);
      assert.equal(verify(null, Buffer.from(message), key, Buffer.from(body.signature, "base64url")), true);
      assert.equal("token" in body, false); assert.equal("mcpTokenHash" in body, false); assert.equal("privateKeyPem" in body, false);
      sequence++; approved = false;
      current = { id: `mca_${sequence.toString(16).padStart(32, "0")}`, deviceId, workspace: body.workspace, keyThumbprint: body.keyThumbprint,
        days: body.days, approvalDeadline: new Date(Date.now() + 900000).toISOString(), approvedAt: null, expiresAt: null, status: "pending" };
      return Response.json({ ...current, mcpResource }, { status: 201 });
    }
    assert.ok(current);
    if (approved && current.status === "pending") {
      const now = Date.now();
      current = { ...current, approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + current.days * 86400000).toISOString(), status: "active" };
    }
    return Response.json(current);
  };
  const approve = async () => {
    assert.ok(current);
    assert.ok(await credentialStore.getPassword("frely-cli-mcp-authorization-v1", `${relayUrl}|${userId}|${current.id}`), "MCP key must be saved before browser approval");
    approvals++; approved = true;
  };
  // Notification models a browser decision; it is not made by a basic API token.
  const first = await setupMcpAuthorization(directory, undefined, false, approve);
  assert.equal(first.grant.days, 90);
  assert.equal(first.mcpUrl, mcpResource);
  assert.equal(await basicCredentialStore.getPassword("frely-cli-basic-v1", relayUrl), basic);
  const firstSecret = JSON.parse((await credentialStore.getPassword("frely-cli-mcp-authorization-v1", `${relayUrl}|${userId}|${first.grant.id}`))!);
  assert.equal("token" in firstSecret, false);
  const metadata = await readFile(mcpMetadataPath(), "utf8");
  assert.equal(metadata.includes("PRIVATE KEY"), false); assert.equal(metadata.includes(first.mcpUrl), true);
  const repeated = await setupMcpAuthorization(directory);
  assert.equal(repeated.mcpUrl, first.mcpUrl); assert.equal(repeated.grant.expiresAt, first.grant.expiresAt);
  assert.equal(approvals, 1); assert.equal(sequence, 1);
  const renewed = await setupMcpAuthorization(directory, 180, true, approve);
  assert.equal(renewed.grant.days, 180); assert.equal(renewed.mcpUrl, first.mcpUrl);
  assert.notEqual(renewed.grant.keyThumbprint, first.grant.keyThumbprint);
  assert.equal(await credentialStore.getPassword("frely-cli-mcp-authorization-v1", `${relayUrl}|${userId}|${first.grant.id}`), null);
  await revokeMcpAuthorization();
  assert.equal((await readDeviceBinding())?.deviceId, deviceId);
  assert.equal(await basicCredentialStore.getPassword("frely-cli-basic-v1", relayUrl), basic);
  assert.equal(approvals, 2);
});
