import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RELAY_ORIGIN, DISCOVERY_PATH, fetchDiscovery, HOSTED_INSTANCE, isInstanceUrl, parseDiscovery, resolveInstanceEndpoints, trustAnchor } from "./instance.js";

const PRIVATE = "https://frely.corp.example";
const full = { gatewayBaseUrl: "https://gw.corp.example/", mcpBaseUrl: "https://mcp.corp.example/mcp", approvalOrigin: "https://approve.corp.example", setupBaseUrl: "https://dl.corp.example", passkeyRpId: "corp.example" };

test("the hosted relay resolves to its fixed addresses, with or without a discovery document", () => {
  const expected = { relayOrigin: "https://frely.cloud", gatewayUrl: "https://api.frely.cloud", mcpUrl: "https://mcp.frely.cloud/mcp", approvalOrigin: "https://approve.frely.cloud", setupUrl: "https://frely.cloud", rpId: "frely.cloud" };
  assert.deepEqual(resolveInstanceEndpoints(DEFAULT_RELAY_ORIGIN), expected);
  assert.deepEqual(HOSTED_INSTANCE, expected);
  // The approval origin and relying party are what a device trusts whatever a relay publishes, so a document cannot move them.
  assert.deepEqual(resolveInstanceEndpoints(DEFAULT_RELAY_ORIGIN, { ...full }), expected);
  assert.deepEqual(trustAnchor(HOSTED_INSTANCE), { rpId: "frely.cloud", approvalOrigins: ["https://approve.frely.cloud"] });
});

test("another relay without a document falls back to its own address", () => {
  assert.deepEqual(resolveInstanceEndpoints(PRIVATE), { relayOrigin: PRIVATE, gatewayUrl: PRIVATE, mcpUrl: `${PRIVATE}/mcp/devices`, approvalOrigin: PRIVATE, setupUrl: PRIVATE, rpId: "frely.corp.example" });
  assert.deepEqual(resolveInstanceEndpoints(PRIVATE, {}), resolveInstanceEndpoints(PRIVATE));
  assert.equal(resolveInstanceEndpoints("http://127.0.0.1:3000").mcpUrl, "http://127.0.0.1:3000/mcp/devices");
});

test("a discovery document overrides what another relay would otherwise derive, field by field", () => {
  assert.deepEqual(resolveInstanceEndpoints(PRIVATE, full), { relayOrigin: PRIVATE, gatewayUrl: "https://gw.corp.example", mcpUrl: "https://mcp.corp.example/mcp", approvalOrigin: "https://approve.corp.example", setupUrl: "https://dl.corp.example", rpId: "corp.example" });
  const partial = resolveInstanceEndpoints(PRIVATE, { gatewayBaseUrl: "https://gw.corp.example" });
  assert.equal(partial.gatewayUrl, "https://gw.corp.example");
  assert.equal(partial.approvalOrigin, PRIVATE);
  assert.equal(resolveInstanceEndpoints(PRIVATE, { approvalOrigin: "https://approve.corp.example" }).rpId, "approve.corp.example");
});

test("one instance's document is never applied to another instance", () => {
  const a = resolveInstanceEndpoints("https://a.example", { gatewayBaseUrl: "https://gw.a.example" });
  const b = resolveInstanceEndpoints("https://b.example");
  assert.equal(a.gatewayUrl, "https://gw.a.example");
  assert.equal(b.gatewayUrl, "https://b.example");
  assert.equal(isInstanceUrl("https://gw.a.example", [b]), false);
  assert.equal(isInstanceUrl("https://gw.a.example", [a]), true);
});

test("discovery fields are validated: https only (http on loopback), no credentials, query or fragment; unknown fields are dropped", () => {
  assert.deepEqual(parseDiscovery(full), { ...full, gatewayBaseUrl: "https://gw.corp.example", mcpBaseUrl: "https://mcp.corp.example/mcp" });
  assert.deepEqual(parseDiscovery({ ...full, extra: "x", gatewayBaseUrl: "http://gw.corp.example", mcpBaseUrl: "https://u:p@mcp.corp.example/mcp", setupBaseUrl: "https://dl.corp.example/?x=1" }), { approvalOrigin: full.approvalOrigin, passkeyRpId: "corp.example" });
  assert.deepEqual(parseDiscovery({ gatewayBaseUrl: "http://localhost:8080", approvalOrigin: "http://127.0.0.1:9000" }), { gatewayBaseUrl: "http://localhost:8080", approvalOrigin: "http://127.0.0.1:9000" });
  assert.deepEqual(parseDiscovery({ gatewayBaseUrl: 5, mcpBaseUrl: "javascript:alert(1)", approvalOrigin: "https://approve.corp.example/path" }), {});
  for (const bad of [null, "x", [], 3]) assert.deepEqual(parseDiscovery(bad), {});
});

test("a relying party id must be the approval host or a parent domain of it", () => {
  assert.equal(parseDiscovery({ approvalOrigin: "https://approve.corp.example", passkeyRpId: "evil.example" }).passkeyRpId, undefined);
  assert.equal(parseDiscovery({ approvalOrigin: "https://approve.corp.example", passkeyRpId: "ample" }).passkeyRpId, undefined);
  assert.equal(parseDiscovery({ approvalOrigin: "https://approve.corp.example", passkeyRpId: "approve.corp.example" }).passkeyRpId, "approve.corp.example");
  assert.equal(parseDiscovery({ passkeyRpId: "corp.example" }).passkeyRpId, undefined);
});

test("the trust anchor of a private instance is its own approval origin and relying party", () => {
  assert.deepEqual(trustAnchor(resolveInstanceEndpoints(PRIVATE, full)), { rpId: "corp.example", approvalOrigins: ["https://approve.corp.example"] });
});

test("fetchDiscovery reads the document from the relay's well-known path and falls back on any failure", async () => {
  const seen: Array<{ url: string; redirect?: RequestRedirect }> = [];
  const serve = (respond: () => Response | Promise<Response>): typeof fetch => async (url, init) => { seen.push({ url: String(url), ...(init?.redirect ? { redirect: init.redirect } : {}) }); return respond(); };
  assert.deepEqual(await fetchDiscovery(PRIVATE, serve(() => Response.json(full))), parseDiscovery(full));
  assert.deepEqual(seen[0], { url: `${PRIVATE}${DISCOVERY_PATH}`, redirect: "error" });
  assert.equal(await fetchDiscovery(PRIVATE, serve(() => new Response("nope", { status: 404 }))), undefined);
  assert.equal(await fetchDiscovery(PRIVATE, serve(() => new Response("<html>", { status: 200 }))), undefined);
  assert.equal(await fetchDiscovery(PRIVATE, serve(() => Response.json({ unrelated: true }))), undefined);
  assert.equal(await fetchDiscovery(PRIVATE, serve(() => Response.json({ gatewayBaseUrl: "https://gw.corp.example", pad: "x".repeat(20_000) }))), undefined);
  assert.equal(await fetchDiscovery(PRIVATE, async () => { throw new TypeError("offline"); }), undefined);
  const hang = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => undefined, 5_000); // AbortSignal.timeout does not keep the event loop alive by itself
    init?.signal?.addEventListener("abort", () => { clearTimeout(keepAlive); reject(new Error("aborted")); });
  })) as typeof fetch;
  assert.equal(await fetchDiscovery(PRIVATE, hang, 20), undefined);
});

test("instance URLs are the relay's host family, the hosts its endpoints name, and loopback; never credentials or plain http elsewhere", () => {
  const instance = resolveInstanceEndpoints(PRIVATE, full);
  for (const ok of ["https://frely.corp.example/api", "https://api.frely.corp.example", "https://gw.corp.example", "https://dl.corp.example/install.sh", "http://127.0.0.1:8080", "http://localhost:1"]) assert.equal(isInstanceUrl(ok, [instance]), true, ok);
  for (const bad of ["https://corp.example", "https://frely.corp.example.evil.example", "https://u:p@frely.corp.example", "http://frely.corp.example", "https://api.frely.cloud", "https://evil.example", "nope"]) assert.equal(isInstanceUrl(bad, [instance]), false, bad);
  assert.equal(isInstanceUrl("https://api.frely.cloud", [instance, HOSTED_INSTANCE]), true);
  assert.equal(isInstanceUrl("https://frely.cloud.evil.example", [HOSTED_INSTANCE]), false);
});
