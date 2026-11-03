import assert from "node:assert/strict";
import test from "node:test";
import { holdsForWait, mcpFetch, outcomeOf, type LoginMcpSession } from "./client.js";
import { ControllerError, EXIT } from "./client.js";

const session = (mcpToken = "fmcp_at_one"): LoginMcpSession => ({ mcpUrl: "https://mcp.test/mcp", mcpToken });

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

test("every request carries the login's MCP side token as a bearer token", async () => {
  const signed = mcpFetch(session());
  const { seen } = await withFetch(() => new Response("{}"), async () => { await signed.fetch("https://mcp.test/mcp", { method: "POST" }); });
  assert.equal(seen[0]!.headers.get("authorization"), "Bearer fmcp_at_one");
  assert.ok(signed.session().mcpToken);
});

test("a refused token is renewed once and the request sent again; a second refusal is exit code 4", async () => {
  const refreshed = session("fmcp_at_two");
  let refreshes = 0;
  const signed = mcpFetch(session(), { refresh: async () => { refreshes++; return refreshed; } });
  const ok = await withFetch(({ headers }) => new Response("{}", { status: headers.get("authorization") === "Bearer fmcp_at_two" ? 200 : 401 }), () => signed.fetch("https://mcp.test/mcp", { method: "POST" }));
  assert.equal(ok.value.status, 200);
  assert.equal(refreshes, 1);
  const refused = mcpFetch(session(), { refresh: async (current) => current });
  await withFetch(() => new Response("no", { status: 401 }), async () => {
    await assert.rejects(refused.fetch("https://mcp.test/mcp", { method: "POST" }), (error: unknown) => error instanceof ControllerError && error.exitCode === EXIT.auth);
  });
});

const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

test("tool results map to the exit codes", () => {
  assert.equal(outcomeOf(text("fine")).exitCode, EXIT.ok);
  const pending = outcomeOf({ ...text("Approval required"), structuredContent: { status: "pending", device: "box", approveUrl: "https://frely.test/device?g=ABCDEF", shortCode: "ABCDEF" } });
  assert.equal(pending.exitCode, EXIT.approval);
  assert.match(pending.note!, /frely permission wait ABCDEF/u);
  assert.match(pending.note!, /g=ABCDEF/u);
  assert.equal(outcomeOf({ ...text({ error: { code: "permission_required", url: "https://frely.test/p" } }), isError: true }).exitCode, EXIT.approval);
  assert.equal(outcomeOf({ ...text("Frely device is offline. On that computer, run `frely link on`, then try again."), isError: true }).exitCode, EXIT.offline);
  assert.equal(outcomeOf({ ...text({ error: { code: "credit_limit" } }), isError: true }).exitCode, EXIT.limit);
  assert.equal(outcomeOf({ ...text("No device matches"), isError: true }).exitCode, EXIT.tool);
});

test("only a permission_status with wait=true gets the long timeout", () => {
  const call = (name: string, args: object) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  assert.equal(holdsForWait(call("permission_status", { code: "ABCDEFGH", wait: true })), true);
  assert.equal(holdsForWait(call("permission_status", { code: "ABCDEFGH" })), false);
  assert.equal(holdsForWait(call("list_devices", { wait: true })), false);
  assert.equal(holdsForWait(undefined), false);
});

test("the transport's own abort signal still cancels a request, so closing the connection does not leave the process waiting for the timeout", async () => {
  const signed = mcpFetch(session());
  const closing = new AbortController();
  let sent: AbortSignal | null | undefined;
  await withFetch(() => new Response("{}"), async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => { sent = init?.signal; return new Response("{}"); }) as typeof fetch;
    try { await signed.fetch("https://mcp.test/mcp", { method: "GET", signal: closing.signal }); } finally { globalThis.fetch = original; }
  });
  assert.equal(sent?.aborted, false);
  closing.abort();
  assert.equal(sent?.aborted, true);
});
