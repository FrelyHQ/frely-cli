import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basicCredentialStore as credentialStore } from "../credential-basic.js";
import { directConnectionGrant, ensureDevice, storedDevice } from "./control.js";
import { useMemoryCredentialStore } from "../test-support.js";

test("directConnectionGrant signs for Device Relay without a login and falls back on 404/405", async () => {
  const seen: Array<{ path: string; authorization?: string; body: Record<string, unknown> }> = [];
  let mode: "ok" | "old" | "down" = "ok";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/auth/me") { response.end(JSON.stringify({ user: { id: "user_test", email: "user@example.com" } })); return; }
    if (request.url === "/api/user/device-relay/enroll") { response.end(JSON.stringify({ deviceId: `drd_${"a".repeat(32)}` })); return; }
    if (request.url === "/device-relay/connect") {
      seen.push({ path: request.url, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), body });
      if (mode === "old") { response.writeHead(404); response.end("{}"); return; }
      if (mode === "down") { response.writeHead(502); response.end(JSON.stringify({ error: { message: "bad gateway" } })); return; }
      response.end(JSON.stringify({ websocketUrl: "ws://127.0.0.1:1/device-relay/ws", accessToken: "direct-grant", expiresAt: "2099-01-01T00:00:00.000Z" }));
      return;
    }
    response.writeHead(404); response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const configRoot = await mkdtemp(join(tmpdir(), "frely-cli-direct-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const restoreCredentialStore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = configRoot;
  try {
    await mkdir(join(configRoot, "frely"), { recursive: true });
    await writeFile(join(configRoot, "frely", "config.json"), JSON.stringify({ version: 3, relayUrl: origin, user: { id: "user_test", email: "user@example.com" } }), { mode: 0o600 });
    await credentialStore.setPassword("frely-cli-basic-v1", origin, JSON.stringify({ version: 1, type: "basic-oauth", accessToken: "synthetic-basic-session", expiresAt: Date.now() + 3600000 }));
    assert.equal(await storedDevice(), null);
    const device = await ensureDevice();
    assert.deepEqual(await storedDevice(), device);

    // Drop the login: the direct path must still work.
    await credentialStore.deletePassword("frely-cli-basic-v1", origin);
    const mcp = { authorizationId: `mca_${"b".repeat(32)}`, mcpResource: `${origin}/mcp`, sign: (message: string) => `signed:${message.split("\n")[0]}` };

    const grant = await directConnectionGrant(device, mcp);
    assert.equal(grant?.transports[0]?.accessToken, "direct-grant");
    const sent = seen[0]!;
    assert.equal(sent.authorization, undefined);
    assert.equal(sent.body.deviceId, device.deviceId);
    assert.equal(sent.body.mcpAuthorizationId, mcp.authorizationId);
    assert.equal(sent.body.mcpSignature, "signed:frely.mcp.connect.v1");
    assert.equal(typeof sent.body.signature, "string");

    mode = "old";
    assert.equal(await directConnectionGrant(device, mcp), null);
    mode = "down";
    await assert.rejects(() => directConnectionGrant(device, mcp), /bad gateway|502/);
  } finally {
    restoreCredentialStore();
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await rm(configRoot, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
