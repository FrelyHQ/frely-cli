import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { basicCredentialStore } from "./credential-basic.js";
import { credentialStore } from "./credential-store.js";
import { generateMcpKey, inspectMcpMetadata, McpConfigInvalidError, mcpMetadataPath, setupMcpAuthorization, type McpAuthorizationView } from "./mcp-authorization.js";
import { ensureMcpAuthorization } from "./mcp-command.js";
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
  const mcpResource = "https://mcp.test.invalid/mcp/devices";
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

test("frely mcp sets up an unconfigured device once, then returns the same authorization silently", async (t) => {
  const f = await fixture(t);
  const project = join(f.directory, "project with spaces");
  await mkdir(project);
  const authorization = await ensureMcpAuthorization({ workspace: project, notify: f.notify }, f.install);
  const workspace = await realpath(project);
  assert.equal(authorization.grant.workspace, workspace);
  assert.equal(authorization.grant.days, 90);
  assert.equal(authorization.mcpUrl, f.mcpResource);
  assert.deepEqual(f.state.installations, [workspace]);
  assert.match(f.state.messages.join(""), /Enabling device MCP for .*\nDevice MCP execution authorization: 90 days/);
  assert.match(f.state.messages.join(""), /Approve: https:\/\/test.invalid\/device\?mcp_request=/);
  assert.match(f.state.messages.join(""), /Background service: running/);
  const metadata = await readFile(mcpMetadataPath(), "utf8");
  f.state.messages.length = 0;
  for (const input of [{}, { workspace: project }]) {
    const again = await ensureMcpAuthorization({ ...input, notify: f.notify }, f.install);
    assert.equal(again.grant.id, authorization.grant.id);
    assert.equal(again.grant.keyThumbprint, authorization.grant.keyThumbprint);
    assert.equal(again.grant.expiresAt, authorization.grant.expiresAt);
  }
  assert.equal(f.state.requests, 1);
  assert.deepEqual(f.state.installations, [workspace]);
  assert.deepEqual(f.state.messages, []);
  assert.equal(await readFile(mcpMetadataPath(), "utf8"), metadata);
});

test("frely mcp refuses to switch the primary workspace and points to workspace add", async (t) => {
  const f = await fixture(t);
  const original = await setupMcpAuthorization(f.directory, 30);
  const other = join(f.directory, "other");
  await mkdir(other);
  await assert.rejects(ensureMcpAuthorization({ workspace: other, notify: f.notify }, f.install), /frely mcp workspace add/);
  assert.equal((await inspectMcpMetadata())?.grant.id, original.grant.id);
  assert.equal(f.state.requests, 1);
  assert.deepEqual(f.state.installations, []);
});

test("frely mcp renews an expired grant or an explicit --days for the same workspace", async (t) => {
  for (const scenario of ["expired", "days"] as const) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const original = await setupMcpAuthorization(f.directory, 30);
      if (scenario === "expired") t.mock.timers.enable({ apis: ["Date"], now: Date.parse(original.grant.expiresAt!) + 1 });
      const renewed = await ensureMcpAuthorization({ ...(scenario === "days" ? { days: "180" } : {}), notify: f.notify }, f.install);
      assert.notEqual(renewed.grant.id, original.grant.id);
      assert.equal(renewed.grant.workspace, original.grant.workspace);
      assert.equal(renewed.grant.days, scenario === "days" ? 180 : 90);
      assert.equal(renewed.mcpUrl, original.mcpUrl);
      assert.equal(f.state.requests, 2);
      assert.deepEqual(f.state.installations, [original.grant.workspace]);
      assert.match(f.state.messages.join(""), /Renewing device MCP authorization/);
    });
  }
});

test("frely mcp does not silently replace a missing key", async (t) => {
  const f = await fixture(t);
  const original = await setupMcpAuthorization(f.directory);
  await credentialStore.deletePassword("frely-cli-mcp-authorization-v1", `${f.relayUrl}|${f.userId}|${original.grant.id}`);
  const metadata = await readFile(mcpMetadataPath(), "utf8");
  await assert.rejects(ensureMcpAuthorization({ notify: f.notify }, f.install), /secure credential is unavailable.*--days/);
  assert.equal(f.state.requests, 1);
  assert.deepEqual(f.state.installations, []);
  assert.deepEqual(f.state.messages, []);
  assert.equal(await readFile(mcpMetadataPath(), "utf8"), metadata);
});

test("frely mcp moves invalid or legacy configuration aside and sets up again", async (t) => {
  for (const scenario of ["malformed", "legacy-url"] as const) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const original = await setupMcpAuthorization(f.directory);
      const stored = JSON.parse(await readFile(mcpMetadataPath(), "utf8"));
      const content = scenario === "malformed" ? "{not json\n"
        : JSON.stringify({ ...stored, mcpResource: `https://mcp.test.invalid/mcp/${original.grant.deviceId}` }) + "\n";
      await writeFile(mcpMetadataPath(), content, { mode: 0o600 });
      await assert.rejects(inspectMcpMetadata(), (error: unknown) => error instanceof McpConfigInvalidError
        && error.reason === (scenario === "malformed" ? "malformed" : "legacy_url"));
      const workspace = await realpath(f.directory);
      const repaired = await ensureMcpAuthorization({ workspace, notify: f.notify }, f.install);
      assert.notEqual(repaired.grant.id, original.grant.id);
      assert.equal(repaired.mcpUrl, f.mcpResource);
      assert.equal(f.state.requests, 2);
      assert.deepEqual(f.state.installations, [workspace]);
      assert.match(f.state.messages.join(""), /Moved it to .*authorization\.json\.invalid-.*\nEnabling device MCP/);
      const backups = (await readdir(dirname(mcpMetadataPath()))).filter((name) => name.startsWith("authorization.json.invalid-"));
      assert.equal(backups.length, 1);
      assert.equal(await readFile(join(dirname(mcpMetadataPath()), backups[0]!), "utf8"), content);
    });
  }
});

test("frely mcp leaves unreadable configuration untouched", { skip: process.platform === "win32" }, async (t) => {
  const f = await fixture(t);
  await setupMcpAuthorization(f.directory);
  await chmod(mcpMetadataPath(), 0o644);
  await assert.rejects(ensureMcpAuthorization({ notify: f.notify }, f.install), /permissions are unsafe/);
  assert.equal(f.state.requests, 1);
  assert.ok(await inspectMcpMetadata().then(() => false, () => true));
  assert.deepEqual((await readdir(dirname(mcpMetadataPath()))).filter((name) => name.includes(".invalid-")), []);
});

test("frely mcp fails without installing a service when browser approval is denied", async (t) => {
  const f = await fixture(t, true);
  await assert.rejects(ensureMcpAuthorization({ workspace: f.directory, notify: f.notify }, f.install), /approval was denied or expired/);
  assert.deepEqual(f.state.installations, []);
  assert.equal(await inspectMcpMetadata(), null);
  assert.doesNotMatch(f.state.messages.join(""), /Background service/);
});

test("frely mcp propagates service installation failure instead of returning a successful connection", async (t) => {
  const f = await fixture(t);
  await assert.rejects(ensureMcpAuthorization({ workspace: f.directory, notify: f.notify }, async () => {
    throw new Error("synthetic service failure");
  }), /synthetic service failure/);
  assert.equal((await inspectMcpMetadata())?.grant.workspace, await realpath(f.directory));
  assert.doesNotMatch(f.state.messages.join(""), /Background service/);
});

test("frely mcp keeps setup prompts off stdout, including JSON mode", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-mcp-url-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  for (const args of [["mcp", "url"], ["mcp", "url", "--json"]]) {
    await assert.rejects(promisify(execFile)(process.execPath, [entry, ...args], {
      cwd: directory,
      env: { ...process.env, XDG_CONFIG_HOME: directory, FRELY_NO_BROWSER: "1" },
    }), (error: unknown) => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Enabling device MCP for/);
      assert.match(result.stderr, /frely login/);
      return true;
    });
  }
});

test("frely mcp enables a preapproved device with its pregenerated key and no browser approval", async (t) => {
  const f = await fixture(t);
  const inner = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, options) => {
    if (new URL(String(url)).pathname === "/api/user/device-relay/mcp" && options?.method === "POST") {
      const body = JSON.parse(String(options.body));
      bodies.push(body);
      const now = Date.now();
      return Response.json({
        id: `mca_${"a".repeat(32)}`, deviceId: `drd_${"1".repeat(32)}`, workspace: body.workspace, keyThumbprint: body.keyThumbprint, days: body.days,
        approvalDeadline: new Date(now + 900000).toISOString(), approvedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + body.days * 86400000).toISOString(), status: "active", mcpResource: f.mcpResource,
      }, { status: 201 });
    }
    return inner(url, options);
  };
  const key = generateMcpKey();
  const project = join(f.directory, "project");
  await mkdir(project);
  const authorization = await ensureMcpAuthorization({ workspace: project, days: "30", notify: f.notify, preset: { privateKeyPem: key.privateKeyPem, preapproval: "signed-token" } }, f.install);
  assert.equal(authorization.grant.status, "active");
  assert.equal(authorization.grant.keyThumbprint, key.keyThumbprint);
  assert.equal(authorization.grant.days, 30);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.preapproval, "signed-token");
  assert.doesNotMatch(f.state.messages.join(""), /Approve:/);
  assert.deepEqual(f.state.installations, [await realpath(project)]);
});
