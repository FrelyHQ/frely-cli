import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authConfigPath, finishDeviceLogin, installTokenError, readConfig, redeemInstallToken, requireLogin } from "./auth.js";
import { mcpStartLogin, takeInstallToken, type McpStartLoginDeps } from "./mcp-command.js";
import { assertSystemdUserManager, ensureLinger } from "./service.js";
import { useMemoryCredentialStore } from "./test-support.js";

const TOKEN = "fit_synthetic_install_token";
const noBrowser: McpStartLoginDeps["loginDevice"] = async () => { throw new Error("browser login must not run"); };

function useSyntheticRelay(t: test.TestContext, redeem: (body: Record<string, unknown>) => Response) {
  const oldFetch = globalThis.fetch;
  const previous = process.env.FRELY_RELAY_URL;
  const restore = useMemoryCredentialStore();
  process.env.FRELY_RELAY_URL = "https://test.invalid";
  t.after(() => {
    restore(); globalThis.fetch = oldFetch;
    if (previous === undefined) delete process.env.FRELY_RELAY_URL; else process.env.FRELY_RELAY_URL = previous;
  });
  const calls: string[] = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/api/auth/device/code") return Response.json({ device_code: "synthetic-code", user_code: "SYNTH-CODE", verification_uri: "https://test.invalid/device", verification_uri_complete: "https://test.invalid/device?user_code=SYNTH-CODE", expires_in: 300, interval: 1 });
    if (path === "/api/auth/device/install/redeem") return redeem(JSON.parse(String(options?.body)) as Record<string, unknown>);
    if (path === "/api/auth/oauth2/token") return Response.json({ access_token: "synthetic-basic", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600 });
    if (path === "/api/auth/me") return Response.json({ user: { id: "user_test", email: "user@example.com" } });
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  };
  return calls;
}

test("the install token is read once and removed from the environment", () => {
  const env: NodeJS.ProcessEnv = { FRELY_INSTALL_TOKEN: ` ${TOKEN}\n`, OTHER: "1" };
  assert.equal(takeInstallToken(env), TOKEN);
  assert.equal("FRELY_INSTALL_TOKEN" in env, false);
  assert.equal(env.OTHER, "1");
  assert.equal(takeInstallToken({ FRELY_INSTALL_TOKEN: "" }), undefined);
  assert.equal(takeInstallToken({}), undefined);
});

test("an install token signs in without a browser and preapproves device MCP", async (t) => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "frely-install-token-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let redeemed: Record<string, unknown> = {};
  const calls = useSyntheticRelay(t, (body) => {
    redeemed = body;
    return Response.json({ state: "signed_in", user: { id: "user_test", email: "user@example.com" }, mcpPreapproval: "synthetic-preapproval" });
  });
  const messages: string[] = [];
  const result = await mcpStartLogin(
    { installToken: TOKEN, workspace, days: "30", notify: (message) => { messages.push(message); } },
    { requireLogin, loginDevice: noBrowser, redeemInstallToken, finishDeviceLogin, readConfig },
  );
  assert.equal(redeemed.token, TOKEN);
  assert.equal(redeemed.userCode, "SYNTH-CODE");
  const mcp = redeemed.mcp as { keyThumbprint: string; workspace: string; days: number };
  assert.deepEqual({ workspace: mcp.workspace, days: mcp.days }, { workspace, days: 30 });
  assert.equal(typeof mcp.keyThumbprint, "string");
  assert.deepEqual(calls, ["/api/auth/device/code", "/api/auth/device/install/redeem", "/api/auth/oauth2/token", "/api/auth/me"]);
  assert.equal(result.workspace, workspace);
  assert.equal(result.days, "30");
  assert.equal(result.preset?.preapproval, "synthetic-preapproval");
  assert.match(result.preset?.privateKeyPem ?? "", /PRIVATE KEY/);
  assert.equal((await readConfig()).user.email, "user@example.com");
  assert.equal((await readFile(authConfigPath(), "utf8")).includes(TOKEN), false);
  assert.equal(messages.join("").includes(TOKEN), false);
  assert.match(messages.join(""), /Signed in to Frely as user@example\.com/);
});

test("an install token replaces an existing login", async (t) => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "frely-install-token-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const calls = useSyntheticRelay(t, () => Response.json({ state: "signed_in", user: { id: "user_test", email: "user@example.com" }, mcpPreapproval: "synthetic-preapproval" }));
  const messages: string[] = [];
  const result = await mcpStartLogin({ installToken: TOKEN, workspace, notify: (message) => { messages.push(message); } }, {
    requireLogin: async () => ({ config: { relayUrl: "https://test.invalid" }, user: { id: "user_a", email: "a@example.com" }, credential: { scheme: "bearer", value: "synthetic" } }),
    loginDevice: noBrowser, redeemInstallToken, finishDeviceLogin,
    readConfig: async () => ({ relayUrl: "https://test.invalid", user: { id: "user_a", email: "a@example.com" } }) as Awaited<ReturnType<typeof readConfig>>,
  });
  assert.ok(calls.includes("/api/auth/device/install/redeem"));
  assert.equal(result.preset?.preapproval, "synthetic-preapproval");
  assert.equal((await readConfig()).user.email, "user@example.com");
  assert.match(messages.join(""), /replaces the earlier sign-in of a@example\.com/);
});

test("without an install token an existing login is kept", async () => {
  const result = await mcpStartLogin({ notify: () => {} }, {
    requireLogin: async () => ({ config: { relayUrl: "https://test.invalid" }, user: { id: "user_a", email: "a@example.com" }, credential: { scheme: "bearer", value: "synthetic" } }),
    loginDevice: noBrowser,
    redeemInstallToken: async () => { throw new Error("must not redeem"); },
    finishDeviceLogin: async () => { throw new Error("must not poll"); },
    readConfig,
  });
  assert.deepEqual(result, {});
});

test("an invalid install token names the next step", async (t) => {
  useSyntheticRelay(t, () => Response.json({ error: { code: "install_token_invalid", message: "Install token is not valid" } }, { status: 400 }));
  await assert.rejects(redeemInstallToken(undefined, TOKEN), (error: Error) => {
    assert.match(error.message, /^Install token is not valid\. The install command is invalid, expired or already used\. Ask Claude \(or the Frely console\) for a new install command/);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
  assert.match(installTokenError({ error: { code: "rate_limited", message: "Too many attempts." } }, 429), /^Too many attempts\. Wait a few minutes/);
  assert.match(installTokenError(null, 400), /HTTP 400.*new install command/);
});

test("an unreachable Relay names the host", async (t) => {
  useSyntheticRelay(t, () => Response.json({}));
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(redeemInstallToken(undefined, TOKEN), /Could not reach test\.invalid\./);
});

test("Linux service setup enables lingering and explains a missing systemd user manager", async () => {
  const calls: string[][] = [];
  const linger = (value: string) => async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === "enable-linger") throw new Error("not allowed");
    return { stdout: `Linger=${value}\n` };
  };
  assert.equal(await ensureLinger(linger("yes"), "alice"), null);
  assert.deepEqual(calls, [["loginctl", "enable-linger", "alice"], ["loginctl", "show-user", "alice", "-p", "Linger"]]);
  assert.match(await ensureLinger(linger("no"), "alice") ?? "", /sudo loginctl enable-linger alice/);
  await assertSystemdUserManager(async () => ({ stdout: "" }));
  await assert.rejects(assertSystemdUserManager(async () => { throw new Error("Failed to connect to bus"); }), /frely mcp serve/);
});
