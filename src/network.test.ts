import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, realpath, readFile, mkdir, writeFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CredentialStore } from "./credential-store.js";
import { runNetwork, NetworkError, publicNetworkError, type NetworkDeps } from "./network.js";
import { NetworkFiles } from "./network-files.js";

const origin = "https://network.frely.cloud";
const token = `fn_${"t".repeat(43)}`;
const deviceCode = "d".repeat(43);
const userCode = "ABCD-1234-ABCD-1234-ABCD-1234";
const requestId = "fa7ac2d9-0ad5-4a76-9ce2-ad8be7ec2fa8";
const sessionId = "cc6b74d4-2e25-4ca0-867b-f17381f91df5";
const address = `0x${"ab".repeat(20)}`;
const skill = "---\nname: frely-network\ndescription: Network service discovery and risk checks.\n---\n# Frely Network\n";
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
const errorCode = (code: string) => (error: unknown) => error instanceof NetworkError && error.code === code;
const setupArgs = (host = "chatgpt") => ["network", "setup", "--host", host, "--json"];
const useArgs = (value: unknown = { address, chainId: "1" }) => ["network", "use", "--capability", "web3.address-risk", "--input-json", JSON.stringify(value), "--json"];

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), "frely-network-client-")); homes.push(home);
  const records = new Map<string, string>();
  const store: CredentialStore = {
    async getPassword(service, key) { return records.get(`${service}:${key}`) ?? null; },
    async setPassword(service, key, value) { records.set(`${service}:${key}`, value); },
    async deletePassword(service, key) { return records.delete(`${service}:${key}`); },
  };
  let now = Date.now();
  const state = { approved: false, revoked: false, uses: 0, starts: 0, exchanges: 0 };
  const calls: { url: string; method: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const view = () => ({ status: "ready", sessionId, walletAddress: address, chainId: 11155111,
    expiresAt: new Date(now + 3_600_000).toISOString(), paymentMode: "platform_demo", remainingCalls: 10 - state.uses });
  const grant = (base = origin) => ({ deviceCode, userCode, verificationUri: `${base}/connect/#code=${userCode}`,
    expiresAt: new Date(now + 600_000).toISOString(), intervalSeconds: 5, paymentMode: "platform_demo" });
  const fetcher: typeof fetch = async (url, init = {}) => {
    assert.equal(init.redirect, "error");
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = new Headers(init.headers);
    calls.push({ url: String(url), method: init.method ?? "GET", body, headers });
    if (parsed.pathname === "/SKILL.md") { assert.equal(headers.has("authorization"), false); return new Response(skill); }
    if (parsed.pathname.endsWith("/device/start")) { state.starts++; assert.equal(headers.has("authorization"), false); return Response.json(grant(parsed.origin), { status: 201 }); }
    if (parsed.pathname.endsWith("/device/token")) {
      state.exchanges++; assert.equal(body.deviceCode, deviceCode);
      return state.approved ? Response.json({ ...view(), accessToken: token }) : Response.json({ status: "awaiting_wallet", intervalSeconds: 5 }, { status: 202 });
    }
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    if (parsed.pathname.endsWith("/session")) {
      if (init.method === "DELETE") { state.revoked = true; return Response.json({ status: "revoked" }); }
      return state.revoked ? Response.json({ code: "SESSION_REQUIRED" }, { status: 401 }) : Response.json(view());
    }
    if (parsed.pathname.endsWith("/capabilities/find")) return Response.json({ capabilities: [{ id: "fixture-agent" }], paymentMode: "platform_demo" });
    if (parsed.pathname.endsWith("/capabilities/use")) {
      state.uses++; assert.equal(headers.get("idempotency-key"), body.requestId);
      return Response.json({ requestId: body.requestId, status: "succeeded", paymentMode: "platform_demo", remainingCalls: 10 - state.uses,
        result: { status: "NO_KNOWN_RISK", riskLevel: "NONE", scamProbability: null, source: { provider: "GoPlus" } }, evidence: { discoverySource: "test_fixture" } });
    }
    throw new Error("Unexpected route");
  };
  const deps: NetworkDeps = { home, store, fetch: fetcher, now: () => now, uuid: () => requestId };
  return { home, records, store, state, calls, grant, view, deps, fetcher, advance(ms: number) { now += ms; } };
}

test("ChatGPT setup is non-blocking and returns no credentials or native-Skill claim", async () => {
  const f = await fixture(); const result = await runNetwork(setupArgs(), f.deps);
  assert.equal(result.status, "awaiting_wallet"); assert.equal(result.instructionMode, "conversation"); assert.equal(result.installed, false);
  assert.equal(result.verificationUri, `${origin}/connect/#code=${userCode}`);
  assert.equal(JSON.stringify(result).includes(deviceCode), false);
  assert.equal(f.state.starts, 1); assert.equal(f.state.exchanges, 0);
  const local = await readFile(join(f.home, ".config/frely/network/config.json"), "utf8");
  assert.equal(local.includes(deviceCode), false); assert.equal(local.includes(token), false);
});
test("setup resumes the pending grant, then saves and validates a durable ready session", async () => {
  const f = await fixture(); await runNetwork(setupArgs(), f.deps);
  const pending = await runNetwork(setupArgs(), f.deps); assert.equal(pending.status, "awaiting_wallet"); assert.equal(f.state.starts, 1);
  f.state.approved = true;
  const first = await runNetwork(["network", "status", "--json"], f.deps); assert.equal(first.status, "ready");
  const second = await runNetwork(["network", "status", "--json"], f.deps); assert.equal(second.status, "ready");
  assert.equal(second.walletAddress, address); assert.equal(second.chainId, 11155111);
  assert.equal(JSON.stringify(second).includes(token), false);
  const setup = await runNetwork(setupArgs(), f.deps); assert.equal(setup.status, "ready"); assert.equal(f.state.starts, 1);
});
test("a request after browser approval exchanges the grant and uses an explicit target chain", async () => {
  const f = await fixture(); await runNetwork(setupArgs(), f.deps); f.state.approved = true;
  const result = await runNetwork(useArgs(), f.deps);
  assert.equal(result.requestId, requestId); assert.equal(f.state.uses, 1);
  const call = f.calls.find((entry) => entry.url.endsWith("/capabilities/use"))!;
  assert.deepEqual(call.body.input, { address, chainId: "1" }); assert.equal(call.body.model, undefined);
  assert.equal((result.result as Record<string, unknown>).scamProbability, null);
  assert.equal((result.evidence as Record<string, unknown>).discoverySource, "test_fixture");
});
test("default requestId and task are optional; provided UUID is preserved", async () => {
  const f = await fixture(); await runNetwork(setupArgs(), f.deps); f.state.approved = true;
  const id = "6529a7be-c547-4634-8fba-cfcce9e51491";
  const value = await runNetwork([...useArgs(), "--request-id", id], f.deps);
  assert.equal(value.requestId, id);
});
test("a configured Network origin is retained across commands and credentials are origin scoped", async () => {
  const f = await fixture(); const custom = "https://network.example";
  await runNetwork([...setupArgs(), "--network", custom], f.deps); f.state.approved = true;
  const state = await runNetwork(["network", "status", "--json"], f.deps);
  assert.equal(state.origin, custom); assert(f.calls.every((call) => new URL(call.url).origin === custom));
  assert(f.records.has(`frely-network:${custom}`)); assert(!f.records.has(`frely-network:${origin}`));
});
test("Claude Code and OpenCode install only the managed Skill, preserving other configuration", async () => {
  for (const host of ["claude-code", "opencode", "generic"]) {
    const f = await fixture(); const other = join(f.home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(other), { recursive: true }); await writeFile(other, "unchanged");
    const result = await runNetwork(setupArgs(host), f.deps); assert.equal(result.instructionMode, "skill");
    const path = join(f.home, host === "claude-code" ? ".claude/skills" : host === "opencode" ? ".config/opencode/skills" : ".agents/skills", "frely-network", "SKILL.md");
    assert.equal(await readFile(path, "utf8"), skill);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    await runNetwork(setupArgs(host), f.deps); assert.equal(await readFile(other, "utf8"), "unchanged");
  }
});
test("unmanaged and user-modified Skill files are not overwritten", async () => {
  const f = await fixture(); const path = join(f.home, ".claude/skills/frely-network/SKILL.md");
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, "user authored");
  await assert.rejects(runNetwork(setupArgs("claude-code"), f.deps), errorCode("UNMANAGED_SKILL_EXISTS"));
  assert.equal(await readFile(path, "utf8"), "user authored"); assert.equal(f.state.starts, 0);
  await rm(path); await runNetwork(setupArgs("claude-code"), f.deps); await writeFile(path, "user changes");
  await assert.rejects(runNetwork(setupArgs("claude-code"), f.deps), errorCode("UNMANAGED_SKILL_EXISTS"));
});
test("dangling file links and ancestor symlinks cannot redirect installation", async () => {
  const f = await fixture(); const path = join(f.home, ".claude/skills/frely-network/SKILL.md");
  await mkdir(dirname(path), { recursive: true }); await symlink(join(f.home, "absent-target"), path);
  await assert.rejects(runNetwork(setupArgs("claude-code"), f.deps), errorCode("UNSAFE_LOCAL_PATH"));
  await rm(join(f.home, ".claude"), { recursive: true }); await symlink(join(f.home, ".agents"), join(f.home, ".claude"));
  await assert.rejects(runNetwork(setupArgs("claude-code"), f.deps), errorCode("UNSAFE_LOCAL_PATH"));
});
test("another local operation cannot consume or overwrite a grant", async () => {
  const f = await fixture(); const files = new NetworkFiles(f.home); const release = await files.lock();
  try { await assert.rejects(runNetwork(setupArgs(), f.deps), errorCode("NETWORK_CLIENT_BUSY")); }
  finally { await release(); }
  assert.equal(f.calls.length, 0);
});
test("invalid arguments, targets and protocols fail before credential access or requests", async () => {
  const f = await fixture();
  for (const args of [["network", "status", "--unknown"], ["network", "setup", "--host"], ["network", "status", "--json", "--json"],
    useArgs({ address }), useArgs({ address, chainId: 56 }), useArgs({ address: "0x123", chainId: 1 }),
    ["network", "use", "--capability", "web3.url-risk", "--input-json", '{"url":"file:///etc/passwd"}'],
    ["network", "use", "--capability", "web3.url-risk", "--input-json", '{"url":"https://user:secret@example.com"}']]) {
    await assert.rejects(runNetwork(args, f.deps));
  }
  assert.equal(f.calls.length, 0);
});
test("origin validation forbids credentials, fragments, paths and non-loopback HTTP", async () => {
  const f = await fixture();
  for (const value of ["https://user:password@example.com", "https://example.com/#fragment", "https://example.com/path", "http://example.com", "not a URL"]) {
    await assert.rejects(runNetwork([...setupArgs(), "--network", value], f.deps), errorCode("NETWORK_ORIGIN_INVALID"));
  }
  assert.equal(f.calls.length, 0);
});
test("a hostile authorization link, invalid Skill and redirects do not produce readiness", async () => {
  const f = await fixture();
  const wrongLink: typeof fetch = async (url, init) => String(url).endsWith("/device/start") ?
    Response.json({ ...f.grant(), verificationUri: "https://attacker.example/connect" }, { status: 201 }) : f.fetcher(url, init);
  await assert.rejects(runNetwork(setupArgs(), { ...f.deps, fetch: wrongLink }), errorCode("NETWORK_RESPONSE_INVALID"));
  assert.equal(f.records.size, 0);
  await assert.rejects(runNetwork(setupArgs(), { ...f.deps, fetch: async () => new Response("# Not a Skill") }), errorCode("SKILL_INVALID"));
  await assert.rejects(runNetwork(setupArgs(), { ...f.deps, fetch: async () => new Response(null, { status: 302, headers: { location: "https://attacker.example" } }) }), errorCode("NETWORK_REDIRECT_REJECTED"));
});
test("oversized responses and stalled requests have bounded failure", async () => {
  const f = await fixture();
  await assert.rejects(runNetwork(setupArgs(), { ...f.deps, fetch: async () => new Response("x".repeat(600_000)) }), errorCode("NETWORK_RESPONSE_TOO_LARGE"));
  await assert.rejects(runNetwork(setupArgs(), { ...f.deps, timeoutMs: 5, fetch: async () => new Promise<Response>(() => undefined) }), errorCode("NETWORK_TIMEOUT"));
});
test("expired and revoked sessions require setup and do not fall back to anonymous calls", async () => {
  const f = await fixture(); await runNetwork(setupArgs(), f.deps); f.state.approved = true;
  await runNetwork(["network", "status"], f.deps); f.state.revoked = true;
  assert.equal((await runNetwork(["network", "status"], f.deps)).status, "setup_required");
  await assert.rejects(runNetwork(useArgs(), f.deps), errorCode("NETWORK_SETUP_REQUIRED")); assert.equal(f.state.uses, 0);
  f.state.revoked = false; f.state.approved = false; await runNetwork(setupArgs(), f.deps); f.advance(700_000);
  assert.equal((await runNetwork(["network", "status"], f.deps)).status, "setup_required");
});
test("unknown dispatch outcome retains request ID and never repeats a request", async () => {
  const f = await fixture(); await runNetwork(setupArgs(), f.deps); f.state.approved = true;
  let attempts = 0;
  const fail: typeof fetch = async (url, init) => { if (String(url).endsWith("/capabilities/use")) { attempts++; throw new Error(`upstream ${token}`); } return f.fetcher(url, init); };
  try { await runNetwork(useArgs(), { ...f.deps, fetch: fail }); assert.fail("must fail"); }
  catch (error) { const result = publicNetworkError(error); assert.equal(result.requestId, requestId); assert.equal(result.code, "NETWORK_REQUEST_FAILED"); assert(!JSON.stringify(result).includes(token)); }
  assert.equal(attempts, 1);
});
test("malformed service output and secret reflection do not reach the host", async () => {
  const f = await fixture(); await runNetwork(setupArgs(), f.deps); f.state.approved = true;
  for (const body of ["not json", JSON.stringify({ diagnostic: token })]) {
    const bad: typeof fetch = async (url, init) => String(url).endsWith("/capabilities/use") ? new Response(body) : f.fetcher(url, init);
    await assert.rejects(runNetwork(useArgs(), { ...f.deps, fetch: bad }), errorCode("NETWORK_RESPONSE_INVALID"));
  }
});
test("logout affects only Network state; unconfirmed remote revocation is an error", async () => {
  const f = await fixture(); f.records.set("frely:existing-account", "do-not-touch"); await runNetwork(setupArgs(), f.deps); f.state.approved = true;
  await runNetwork(["network", "status"], f.deps);
  const result = await runNetwork(["network", "logout", "--json"], f.deps); assert.equal(result.remoteRevocation, true);
  assert.equal(f.records.get("frely:existing-account"), "do-not-touch"); assert.equal(f.records.size, 1);
  f.state.revoked = false; await runNetwork(setupArgs(), f.deps); await runNetwork(["network", "status"], f.deps);
  const fail: typeof fetch = async (url, init) => init?.method === "DELETE" ? Promise.reject(new Error("offline")) : f.fetcher(url, init);
  await assert.rejects(runNetwork(["network", "logout"], { ...f.deps, fetch: fail }), errorCode("REVOCATION_UNCONFIRMED"));
  assert.equal(f.records.size, 1);
});
test("secure-store failure cannot become successful initialization", async () => {
  const f = await fixture(); const store: CredentialStore = { ...f.store, async setPassword() { throw new Error("keychain locked"); } };
  await assert.rejects(runNetwork(setupArgs(), { ...f.deps, store }), errorCode("CREDENTIAL_STORE_FAILED"));
});
