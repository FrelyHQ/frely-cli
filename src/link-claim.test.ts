import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { basicCredentialStore } from "./credential-basic.js";
import { watchLinkClaim } from "./link-claim.js";
import { claimLinkAuthorization, inspectMcpMetadata, registerLinkKey, requireMcpAuthorization } from "./mcp-authorization.js";
import { useMemoryCredentialStore } from "./test-support.js";

test("the watch registers once, polls until the web enabled remote control, then reports it", async () => {
  const calls: string[] = [];
  let claims = 0;
  const controller = new AbortController();
  let claimed = false;
  await watchLinkClaim({
    signal: controller.signal, log: () => undefined, intervalMs: 1, onClaimed: () => { claimed = true; },
    deps: { locked: async () => false, register: async () => { calls.push("register"); }, claim: async () => { calls.push("claim"); return ++claims === 3; } },
  });
  assert.equal(claimed, true);
  assert.deepEqual(calls, ["register", "claim", "claim", "claim"]);
});

test("a locked computer neither registers nor claims, and a failed round does not stop the watch", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  let locked = true, failed = false;
  const logs: string[] = [];
  setTimeout(() => { locked = false; }, 5);
  await watchLinkClaim({
    signal: controller.signal, log: (message) => logs.push(message), intervalMs: 2, onClaimed: () => undefined,
    deps: {
      locked: async () => locked,
      register: async () => { calls.push("register"); },
      claim: async () => { calls.push("claim"); if (!failed) { failed = true; throw new Error("offline"); } return true; },
    },
  });
  assert.deepEqual(calls, ["register", "claim", "claim"]);
  assert.ok(logs.some((line) => /offline/.test(line)));
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "frely-link-claim-"));
  const restore = useMemoryCredentialStore();
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.XDG_CONFIG_HOME = directory;
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    restore();
    globalThis.fetch = originalFetch;
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
    await rm(directory, { recursive: true, force: true });
  });
  const relayUrl = "https://test.invalid", userId = "user_test", deviceId = `drd_${"2".repeat(32)}`;
  await mkdir(join(directory, "frely"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "frely", "config.json"), JSON.stringify({ version: 3, relayUrl, user: { id: userId, email: "user@example.com" } }), { mode: 0o600 });
  await basicCredentialStore.setPassword("frely-cli-basic-v1", relayUrl, JSON.stringify({ version: 1, type: "basic-oauth", accessToken: "synthetic-basic", expiresAt: Date.now() + 3600000 }));
  const state = { registered: null as null | { keyThumbprint: string; workspace: string; publicKeySpki: string }, enabled: false, stamp: undefined as number | undefined };
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/me") return Response.json({ user: { id: userId, email: "user@example.com" } });
    if (path === "/api/user/device-relay/enroll") return Response.json({ deviceId });
    assert.equal(path, "/api/user/device-relay/mcp");
    const stamp = state.stamp ??= Date.now();
    const view = () => { const now = stamp; return {
      id: `mca_${"a".repeat(32)}`, deviceId, workspace: state.registered!.workspace, keyThumbprint: state.registered!.keyThumbprint, days: 90,
      approvalDeadline: new Date(now + 900000).toISOString(), approvedAt: new Date(now).toISOString(), expiresAt: new Date(now + 90 * 86400000).toISOString(), status: "active" }; };
    // The lease is read back by id before it is used.
    if (options?.method === "GET") return Response.json({ ...view(), mcpResource: "https://mcp.test.invalid/mcp" });
    const body = JSON.parse(String(options?.body));
    if (body.action === "link-register") {
      state.registered = { keyThumbprint: body.keyThumbprint, workspace: body.workspace, publicKeySpki: body.publicKeySpki };
      return Response.json({ status: "registered" });
    }
    assert.equal(body.action, "link-claim");
    if (!state.enabled || !state.registered) return Response.json({ status: "none" });
    return Response.json({ status: "enabled", mcpResource: "https://mcp.test.invalid/mcp", authorization: view() });
  };
  return { state, deviceId };
}

test("registering sends a public key, the home workspace and a signature that proves possession", async (t) => {
  const f = await fixture(t);
  await registerLinkKey();
  assert.ok(f.state.registered);
  assert.equal(f.state.registered.workspace, await realpath(homedir()));
  // Registering again reuses the stored key.
  const first = f.state.registered.keyThumbprint;
  await registerLinkKey();
  assert.equal(f.state.registered.keyThumbprint, first);
});

test("claiming saves the lease the web approved for the registered key as the device MCP authorization", async (t) => {
  const f = await fixture(t);
  assert.equal(await claimLinkAuthorization(), false, "nothing registered yet");
  await registerLinkKey();
  assert.equal(await claimLinkAuthorization(), false, "the web has not enabled it");
  f.state.enabled = true;
  assert.equal(await claimLinkAuthorization(), true);
  const metadata = await inspectMcpMetadata();
  assert.equal(metadata?.grant.status, "active");
  assert.equal(metadata?.grant.keyThumbprint, f.state.registered!.keyThumbprint);
  // The saved lease is usable like one made by `frely link on`: the private key matches it.
  const authorization = await requireMcpAuthorization();
  assert.equal(authorization.grant.id, `mca_${"a".repeat(32)}`);
  // Already active: nothing to do.
  assert.equal(await claimLinkAuthorization(), false);
});

test("a lease for another key is refused", async (t) => {
  const f = await fixture(t);
  await registerLinkKey();
  f.state.enabled = true;
  f.state.registered = { ...f.state.registered!, keyThumbprint: "x".repeat(43) };
  await assert.rejects(claimLinkAuthorization(), /does not match this computer's key/);
});
