import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CredentialStore } from "../credential-store.js";
import { CloudToolError, type CloudToolCaller } from "./cloud-item.js";
import { callRemoteTool, installRemoteMcpSkill, listRemoteTools, mcpClientConfig, parseMcpName, remoteMcpSkill } from "./remote-mcp.js";

const id = "remote_mcp_0123456789abcdef01234567";
const url = `https://api.test/mcp/remote/${id}`;

function memoryStore(): CredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values,
    getPassword: async (service, account) => values.get(`${service}\0${account}`) ?? null,
    setPassword: async (service, account, password) => { values.set(`${service}\0${account}`, password); },
    deletePassword: async (service, account) => values.delete(`${service}\0${account}`) };
}

/** A caller that mints key-1, key-2, … on each mcps.connect. */
function connector(): CloudToolCaller & { minted: number } {
  const call = (async (name: string, input: Record<string, unknown>) => {
    assert.equal(name, "mcps.connect");
    assert.deepEqual(input, { name: "alice/crm" });
    call.minted += 1;
    return { id, name: "CRM", url, apiKey: `key-${call.minted}`, keyId: "key_1", config: {} };
  }) as unknown as CloudToolCaller & { minted: number };
  call.minted = 0;
  return call;
}

/** An MCP server that accepts only `valid`; answers in JSON, or as an event stream for tools/list. */
function server(valid: () => string, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), url);
    const headers = init?.headers as Record<string, string>;
    if (headers.authorization !== `Bearer ${valid()}`) return new Response("unauthorized", { status: 401 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: Record<string, unknown> };
    seen.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "crm", version: "1" } } }, { headers: { "mcp-session-id": "s1" } });
    if (headers["mcp-session-id"] !== "s1") return new Response("no session", { status: 400 });
    if (message.method === "tools/list") {
      const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "crm_find_contacts", description: "Find contacts", inputSchema: { type: "object" } }] } });
      return new Response(`event: message\ndata: ${body}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `called ${String(message.params?.name)} with ${JSON.stringify(message.params?.arguments)}` }], isError: false } });
  }) as typeof fetch;
}

test("names are username/name", () => {
  assert.deepEqual(parseMcpName("Alice/CRM"), { name: "alice/crm", slug: "crm" });
  for (const bad of ["crm", "a/b/c", "alice/crm@2", "/crm"]) assert.throws(() => parseMcpName(bad));
});

test("lists tools from an event-stream reply and keeps the minted key for the next call", async () => {
  const store = memoryStore(), call = connector(), seen: string[] = [];
  const deps = { call, store, fetchImpl: server(() => "key-1", seen) };
  const tools = await listRemoteTools("alice/crm", deps);
  assert.deepEqual(tools.map((tool) => tool.name), ["crm_find_contacts"]);
  const result = await callRemoteTool("alice/crm", "crm_find_contacts", { q: "ann" }, deps) as { content: Array<{ text: string }> };
  assert.equal(result.content[0]!.text, 'called crm_find_contacts with {"q":"ann"}');
  assert.equal(call.minted, 1, "the second command reuses the saved key");
  assert.deepEqual(seen.slice(0, 3), ["initialize", "notifications/initialized", "tools/list"]);
});

test("a refused key is replaced once with a new one", async () => {
  const store = memoryStore(), call = connector();
  await store.setPassword("frely-cli-remote-mcp-v1", "alice/crm", JSON.stringify({ id, url, apiKey: "old" }));
  const result = await callRemoteTool("alice/crm", "crm_find_contacts", {}, { call, store, fetchImpl: server(() => "key-1") }) as { isError: boolean };
  assert.equal(result.isError, false);
  assert.equal(call.minted, 1);
});

test("a key the server keeps refusing is an error, not a loop", async () => {
  const call = connector();
  await assert.rejects(callRemoteTool("alice/crm", "t", {}, { call, store: memoryStore(), fetchImpl: server(() => "never") }), /did not accept/);
  assert.equal(call.minted, 1);
});

test("connect failures from Frely reach the caller", async () => {
  const call: CloudToolCaller = async () => { throw new CloudToolError("remote_mcp_not_found"); };
  await assert.rejects(listRemoteTools("alice/crm", { call, store: memoryStore() }), (error: unknown) => error instanceof CloudToolError && error.code === "remote_mcp_not_found");
});

test("installs a Skill folder that uses the MCP through frely remote", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-mcp-")));
  try {
    const result = await installRemoteMcpSkill({ ref: "alice/crm", call: connector(), store: memoryStore(), fetchImpl: server(() => "key-1"), host: "claude-code", scope: "global", home });
    assert.equal(result.path, join(home, ".claude", "skills", "crm"));
    assert.equal(result.tools, 1);
    const skill = await readFile(join(result.path, "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: crm\ndescription: Use the Frely MCP alice\/crm \(tools: crm_find_contacts\)/u);
    assert.match(skill, /frely remote call alice\/crm <tool>/u);
    assert.ok(!skill.includes("key-1"), "no key in the Skill");
    assert.match(await readFile(join(result.path, "tools.md"), "utf8"), /## crm_find_contacts\n\nFind contacts/u);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("tool text with line breaks cannot add front matter lines", () => {
  const { skill } = remoteMcpSkill("alice/crm", [{ name: "a\n---\nname: evil", description: "x" }]);
  assert.equal(skill.split("\n---\n").length, 2);
  assert.equal(skill.split("\n")[1], "name: crm");
});

test("client config carries the key only in the Authorization header", () => {
  assert.deepEqual(mcpClientConfig({ id, name: "alice/crm", url, apiKey: "k" }), { mcpServers: { crm: { type: "http", url, headers: { Authorization: "Bearer k" } } } });
});
