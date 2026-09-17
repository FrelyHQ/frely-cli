import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { basicCredentialStore } from "./credential-basic.js";
import { credentialStore } from "./credential-store.js";
import { inspectMcpMetadata, mcpMetadataPath, setupMcpAuthorization, type McpAuthorizationView } from "./mcp-authorization.js";
import { resolveMcpUrlAuthorization } from "./mcp-command.js";
import { useMemoryCredentialStore } from "./test-support.js";

async function fixture(t: TestContext, denied = false) {
  const directory = await mkdtemp(join(tmpdir(), "frely-mcp-url-"));
  const restore = useMemoryCredentialStore();
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER };
  process.env.XDG_CONFIG_HOME = directory;
  process.env.FRELY_NO_BROWSER = "1";
  const originalFetch = globalThis.fetch;
  t.after(async () => {
    restore();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  const relayUrl = "https://test.invalid", userId = "user_test", deviceId = `drd_${"1".repeat(32)}`;
  const mcpResource = `https://mcp.test.invalid/mcp/${deviceId}`;
  await mkdir(join(directory, "frely"), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "frely", "config.json"), JSON.stringify({
    version: 3, relayUrl, user: { id: userId, email: "user@example.com" },
  }), { mode: 0o600 });
  await basicCredentialStore.setPassword("frely-cli-basic-v1", relayUrl, JSON.stringify({
    version: 1, type: "basic-oauth", accessToken: "synthetic-basic", expiresAt: Date.now() + 3600000,
  }));
  let current: McpAuthorizationView | null = null;
  const state = { requests: 0, installations: [] as string[], messages: [] as string[] };
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/me") return Response.json({ user: { id: userId, email: "user@example.com" } });
    if (path === "/api/user/device-relay/enroll") return Response.json({ deviceId });
    assert.equal(path, "/api/user/device-relay/mcp");
    if (options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      assert.equal(body.action, "request");
      state.requests++;
      current = {
        id: `mca_${state.requests.toString(16).padStart(32, "0")}`, deviceId, workspace: body.workspace,
        keyThumbprint: body.keyThumbprint, days: body.days,
        approvalDeadline: new Date(Date.now() + 900000).toISOString(), approvedAt: null, expiresAt: null, status: "pending",
      };
      return Response.json({ ...current, mcpResource }, { status: 201 });
    }
    assert.ok(current);
    if (current.status === "pending") {
      // Simulate the server's browser decision, never an approval by the basic token.
      const now = Date.now();
      current = denied ? { ...current, status: "revoked" } : {
        ...current, status: "active", approvedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + current.days * 86400000).toISOString(),
      };
    }
    return Response.json(current);
  };
  const notify = (message: string) => { state.messages.push(message); };
  const install = async (workspace: string) => {
    const metadata = await inspectMcpMetadata();
    assert.equal(metadata?.grant.status, "active", "service installation must wait for approval");
    assert.equal(metadata?.grant.workspace, workspace);
    state.installations.push(workspace);
    return { installed: true, active: true, platform: process.platform, workspace };
  };
  return { directory, relayUrl, userId, mcpResource, state, notify, install };
}

test("MCP URL bootstraps the home directory once with the normal approval and service lifecycle", async (t) => {
  const f = await fixture(t);
  const authorization = await resolveMcpUrlAuthorization(f.notify, f.install);
  const home = await realpath(homedir());
  assert.equal(authorization.grant.workspace, home);
  assert.equal(authorization.grant.days, 90);
  assert.equal(authorization.mcpUrl, f.mcpResource);
  assert.deepEqual(f.state.installations, [home]);
  assert.match(f.state.messages.join(""), /home directory:.*\nDevice MCP execution authorization: 90 days/);
  assert.match(f.state.messages.join(""), /Approve: https:\/\/test.invalid\/device\?mcp_request=/);
  assert.match(f.state.messages.join(""), /Background service: running/);
  const metadata = await readFile(mcpMetadataPath(), "utf8");
  f.state.messages.length = 0;
  const again = await resolveMcpUrlAuthorization(f.notify, f.install);
  assert.equal(again.grant.id, authorization.grant.id);
  assert.equal(again.grant.keyThumbprint, authorization.grant.keyThumbprint);
  assert.equal(again.grant.expiresAt, authorization.grant.expiresAt);
  assert.equal(f.state.requests, 1);
  assert.deepEqual(f.state.installations, [home]);
  assert.deepEqual(f.state.messages, []);
  assert.equal(await readFile(mcpMetadataPath(), "utf8"), metadata);
});

test("MCP URL preserves an explicitly configured workspace", async (t) => {
  const f = await fixture(t);
  const project = join(f.directory, "project with spaces");
  await mkdir(project);
  const original = await setupMcpAuthorization(project, 30);
  const authorization = await resolveMcpUrlAuthorization(f.notify, f.install);
  assert.equal(authorization.grant.workspace, await realpath(project));
  assert.equal(authorization.grant.id, original.grant.id);
  assert.equal(authorization.grant.expiresAt, original.grant.expiresAt);
  assert.equal(f.state.requests, 1);
  assert.deepEqual(f.state.installations, []);
  assert.deepEqual(f.state.messages, []);
});

test("MCP URL does not replace expired grants, missing keys or invalid configuration with home setup", async (t) => {
  for (const scenario of ["expired", "missing-key", "invalid-config"] as const) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const original = await setupMcpAuthorization(f.directory);
      let expected: RegExp;
      if (scenario === "expired") {
        t.mock.timers.enable({ apis: ["Date"], now: Date.parse(original.grant.expiresAt!) + 1 });
        expected = /MCP_AUTHORIZATION_EXPIRED/;
      } else if (scenario === "missing-key") {
        await credentialStore.deletePassword("frely-cli-mcp-authorization-v1", `${f.relayUrl}|${f.userId}|${original.grant.id}`);
        expected = /secure credential is unavailable/;
      } else {
        await writeFile(mcpMetadataPath(), "{}\n", { mode: 0o600 });
        expected = /MCP configuration is invalid/;
      }
      const metadata = await readFile(mcpMetadataPath(), "utf8");
      await assert.rejects(resolveMcpUrlAuthorization(f.notify, f.install), expected);
      assert.equal(f.state.requests, 1);
      assert.deepEqual(f.state.installations, []);
      assert.deepEqual(f.state.messages, []);
      assert.equal(await readFile(mcpMetadataPath(), "utf8"), metadata);
    });
  }
});

test("MCP URL fails without installing a service when browser approval is denied", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(resolveMcpUrlAuthorization(f.notify, f.install), /approval was denied or expired/);
  assert.deepEqual(f.state.installations, []);
  assert.equal(await inspectMcpMetadata(), null);
  assert.doesNotMatch(f.state.messages.join(""), /Background service/);
});

test("MCP URL propagates service installation failure instead of returning a successful connection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolveMcpUrlAuthorization(f.notify, async () => {
    throw new Error("synthetic service failure");
  }), /synthetic service failure/);
  assert.equal((await inspectMcpMetadata())?.grant.workspace, await realpath(homedir()));
  assert.doesNotMatch(f.state.messages.join(""), /Background service/);
});

test("MCP URL keeps bootstrap prompts off stdout, including JSON mode and the legacy alias", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-mcp-url-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  for (const args of [["mcp", "url"], ["mcp", "url", "--json"], ["mcp", "chatgpt", "--json"]]) {
    await assert.rejects(promisify(execFile)(process.execPath, [entry, ...args], {
      env: { ...process.env, XDG_CONFIG_HOME: directory, FRELY_NO_BROWSER: "1" },
    }), (error: unknown) => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Setting up your home directory:/);
      assert.match(result.stderr, /frely login/);
      return true;
    });
  }
});
