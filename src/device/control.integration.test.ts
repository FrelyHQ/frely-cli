import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import keytar from "keytar";
import { connectionGrant, ensureDevice, revokeDevice } from "./control.js";
import { connectionProofMessage } from "./identity.js";

const ACCOUNT_SERVICE = "frely-cli";
const DEVICE_SERVICE = "frely-cli-device";

test("account session enrolls device, gets a signed connection grant, and revokes", async () => {
  const requests: Array<{ method: string; path: string; cookie?: string; body?: Record<string, unknown> }> = [];
  let origin = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : undefined;
    requests.push({ method: request.method ?? "", path: request.url ?? "", ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}), ...(body ? { body } : {}) });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/auth/me") {
      response.end(JSON.stringify({ user: { id: "user_test", email: "user@example.com" } }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/user/device-relay/enroll") {
      response.end(JSON.stringify({ deviceId: "device_test", mcpUrl: `${origin}/mcp/device_test` }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/user/device-relay/connect") {
      const publicKeySpki = String(body?.publicKeySpki ?? "");
      const message = connectionProofMessage(String(body?.deviceId ?? ""), String(body?.issuedAt ?? ""), String(body?.nonce ?? ""));
      const key = createPublicKey({ key: Buffer.from(publicKeySpki, "base64url"), type: "spki", format: "der" });
      assert.equal(verify(null, Buffer.from(message), key, Buffer.from(String(body?.signature ?? ""), "base64url")), true);
      response.end(JSON.stringify({ websocketUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}/device-relay`, accessToken: "short-lived-grant", expiresAt: "2099-01-01T00:00:00.000Z" }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/user/device-relay/revoke") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
  const configRoot = await mkdtemp(join(tmpdir(), "frely-cli-control-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configRoot;
  const accountKey = origin;
  const deviceKey = `${origin}|user_test`;
  try {
    await mkdir(join(configRoot, "frely"), { recursive: true });
    await writeFile(join(configRoot, "frely", "config.json"), JSON.stringify({ version: 1, relayUrl: origin, user: { id: "user_test", email: "user@example.com" } }), { mode: 0o600 });
    await keytar.setPassword(ACCOUNT_SERVICE, accountKey, "friday_session_token=test-session");

    const device = await ensureDevice();
    assert.equal(device.deviceId, "device_test");
    assert.equal(device.mcpUrl, `${origin}/mcp/device_test`);
    const repeated = await ensureDevice();
    assert.equal(repeated.mcpUrl, device.mcpUrl);
    const grant = await connectionGrant(device);
    assert.equal(grant.accessToken, "short-lived-grant");
    await revokeDevice();

    const protectedCalls = requests.filter((request) => request.path.startsWith("/api/user/device-relay/"));
    assert.equal(protectedCalls.length, 3);
    assert.ok(protectedCalls.every((request) => request.cookie === "friday_session_token=test-session"));
    assert.equal(protectedCalls[0]?.body?.deviceId, undefined);
    assert.equal(protectedCalls[2]?.body?.deviceId, "device_test");
  } finally {
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await keytar.deletePassword(ACCOUNT_SERVICE, accountKey).catch(() => false);
    await keytar.deletePassword(DEVICE_SERVICE, deviceKey).catch(() => false);
    await rm(configRoot, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
