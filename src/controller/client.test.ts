import assert from "node:assert/strict";
import test from "node:test";
import { dpopFetch, outcomeOf } from "./client.js";
import { generateDpopKey } from "./dpop.js";
import { ControllerError, EXIT, type ControllerSession } from "./session.js";

const session = (expiresAt = Date.now() + 600_000): ControllerSession => ({ version: 1, relayUrl: "https://frely.test", mcpUrl: "https://mcp.test/mcp", deviceId: `drd_${"a".repeat(32)}`, privateKeyPem: generateDpopKey().privateKeyPem, accessToken: "fmcp_at_one", refreshToken: "r1", expiresAt });

async function withFetch<T>(handler: (request: { url: string; headers: Headers }) => Response, work: () => Promise<T>): Promise<{ value: T; seen: Array<{ url: string; headers: Headers }> }> {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(input), headers: new Headers(init?.headers) };
    seen.push(entry);
    return handler(entry);
  }) as typeof fetch;
  try { return { value: await work(), seen }; } finally { globalThis.fetch = original; }
}

test("every request carries the DPoP token and a fresh proof for that request", async () => {
  const signed = dpopFetch(session());
  const { seen } = await withFetch(() => new Response("{}"), async () => { await signed.fetch("https://mcp.test/mcp", { method: "POST" }); await signed.fetch("https://mcp.test/mcp", { method: "POST" }); });
  assert.equal(seen[0]!.headers.get("authorization"), "DPoP fmcp_at_one");
  assert.ok(seen[0]!.headers.get("dpop"));
  assert.notEqual(seen[0]!.headers.get("dpop"), seen[1]!.headers.get("dpop"));
});

test("a refused token is renewed once and the request sent again; a second refusal is exit code 4", async () => {
  const refreshed = { ...session(), accessToken: "fmcp_at_two" };
  let refreshes = 0;
  const signed = dpopFetch(session(), { refresh: async () => { refreshes++; return refreshed; } });
  const ok = await withFetch(({ headers }) => new Response("{}", { status: headers.get("authorization") === "DPoP fmcp_at_two" ? 200 : 401 }), () => signed.fetch("https://mcp.test/mcp", { method: "POST" }));
  assert.equal(ok.value.status, 200);
  assert.equal(refreshes, 1);
  const refused = dpopFetch(session(), { refresh: async (current) => current });
  await withFetch(() => new Response("no", { status: 401 }), async () => {
    await assert.rejects(refused.fetch("https://mcp.test/mcp", { method: "POST" }), (error: unknown) => error instanceof ControllerError && error.exitCode === EXIT.auth);
  });
});

test("an access token about to run out is renewed before the request", async () => {
  let refreshes = 0;
  const signed = dpopFetch(session(Date.now() + 5_000), { refresh: async (current) => { refreshes++; return { ...current, accessToken: "fmcp_at_new", expiresAt: Date.now() + 600_000 }; } });
  const { seen } = await withFetch(() => new Response("{}"), () => signed.fetch("https://mcp.test/mcp", { method: "POST" }));
  assert.equal(refreshes, 1);
  assert.equal(seen[0]!.headers.get("authorization"), "DPoP fmcp_at_new");
});

const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

test("tool results map to the exit codes", () => {
  assert.equal(outcomeOf(text("fine")).exitCode, EXIT.ok);
  const pending = outcomeOf({ ...text("Approval required"), structuredContent: { status: "pending", device: "box", approveUrl: "https://frely.test/device?g=ABCDEF", shortCode: "ABCDEF" } });
  assert.equal(pending.exitCode, EXIT.approval);
  assert.match(pending.note!, /frely permission wait ABCDEF/u);
  assert.match(pending.note!, /g=ABCDEF/u);
  assert.equal(outcomeOf({ ...text({ error: { code: "permission_required", url: "https://frely.test/p" } }), isError: true }).exitCode, EXIT.approval);
  assert.equal(outcomeOf({ ...text("Frely device is offline. On that computer, run `frely mcp start`, then try again."), isError: true }).exitCode, EXIT.offline);
  assert.equal(outcomeOf({ ...text({ error: { code: "credit_limit" } }), isError: true }).exitCode, EXIT.limit);
  assert.equal(outcomeOf({ ...text("No device matches"), isError: true }).exitCode, EXIT.tool);
});
