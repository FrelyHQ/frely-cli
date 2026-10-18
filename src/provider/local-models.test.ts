import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../runtime/mcp.js";
import { createLocalModelsHub, localCallName, type LocalModelsHub } from "./local-models.js";
import { isSupportedLocalModelName, saveLocalProvider } from "./state.js";

test("local model names allow inner slashes but no whitespace, edge or doubled slashes", () => {
  for (const name of ["llama3.2", "Ho-Jin-93/Qwen3.8-27B-MLTF-q8c", "a/b/c", "x".repeat(256)]) assert.equal(isSupportedLocalModelName(name), true, name);
  for (const name of ["", "/a", "a/", "a//b", "a b", "a\tb", "x".repeat(257)]) assert.equal(isSupportedLocalModelName(name), false, name);
});

test("a shared model's call name is its last segment, like the platform's self-use names", () => {
  assert.equal(localCallName("Ho-Jin-93/Qwen3.8-27B-MLTF-q8c"), "Qwen3.8-27B-MLTF-q8c");
  assert.equal(localCallName("llama3.2"), "llama3.2");
  assert.equal(localCallName("org/"), null);
  assert.equal(localCallName("-x"), null);
});

async function withModelServer<T>(models: string[], body: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [...models.map((id) => ({ id })), { id: "bad name" }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return await body(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the hub lists a given loopback server and the already shared Providers", async () => {
  const previous = process.env.XDG_CONFIG_HOME;
  const root = await mkdtemp(join(tmpdir(), "frely-cli-local-models-"));
  process.env.XDG_CONFIG_HOME = root;
  try {
    await withModelServer(["qwen3", "Ho-Jin-93/Qwen3.8"], async (baseUrl) => {
      const hub = createLocalModelsHub();
      const signal = new AbortController().signal;
      assert.deepEqual(await hub.list(baseUrl, signal), { servers: [{ url: baseUrl, models: ["Ho-Jin-93/Qwen3.8", "qwen3"] }], shared: [] });
      await assert.rejects(() => hub.list("http://192.168.1.2:1234/v1", signal), /loopback/u);
      const providerId = `prv_${"d".repeat(24)}`;
      await saveLocalProvider({ providerId, name: "Local: qwen3", driver: "openai-compatible", baseUrl, providerBaseUrl: "https://app.frely.cloud/local-provider/v1", models: ["qwen3"], createdAt: new Date().toISOString(), slot: "personal" });
      // Without a url the defaults are probed (nothing listens there in tests) and the shared Provider's own URL too.
      const found = await hub.list(undefined, signal) as { servers: Array<{ url: string; models: string[] }>; shared: Array<{ providerId: string; url: string }> };
      assert.deepEqual(found.servers.find((server) => server.url === baseUrl)?.models, ["Ho-Jin-93/Qwen3.8", "qwen3"]);
      assert.deepEqual(found.shared.map((provider) => [provider.providerId, provider.url]), [[providerId, baseUrl]]);
    });
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the hub refuses unsupported model names before it contacts Frely", async () => {
  await assert.rejects(() => createLocalModelsHub().share({ url: "http://127.0.0.1:1234/v1", models: ["org//bad"] }, new AbortController().signal), /not supported/u);
});

test("local_models is listed only when the daemon injects a hub, and its actions reach the hub", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-local-models-mcp-"));
  const calls: unknown[] = [];
  const hub: LocalModelsHub = {
    async list(url) { calls.push(["list", url]); return { servers: [], shared: [] }; },
    async share(input) { calls.push(["share", input]); return { providerId: "prv_x", slot: "personal", models: input.models ?? [], notice: "n" }; },
  };
  const connect = async (withHub: boolean) => {
    const server = await createMcpServer(root, withHub ? { localModels: hub } : {});
    const client = new Client({ name: "t", version: "1" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  };
  const plain = await connect(false);
  const hidden = (await plain.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(!hidden.includes("local_models"));
  const refused = await plain.client.callTool({ name: "local_models", arguments: { action: "list" } });
  assert.equal(refused.isError, true);
  await plain.client.close(); await plain.server.close();

  const withHub = await connect(true);
  try {
    const tool = (await withHub.client.listTools()).tools.find((candidate) => candidate.name === "local_models");
    assert.ok(tool);
    assert.match(tool.description ?? "", /Provider slot/u);
    assert.match(tool.description ?? "", /models_list/u);
    assert.deepEqual([tool.annotations?.readOnlyHint, tool.annotations?.openWorldHint], [false, true]);
    await withHub.client.callTool({ name: "local_models", arguments: { action: "list", url: "http://127.0.0.1:1234/v1" } });
    const shared = await withHub.client.callTool({ name: "local_models", arguments: { action: "share", url: "http://127.0.0.1:1234/v1", models: [" a/b ", ""], name: "Mine" } });
    assert.deepEqual(JSON.parse((shared.content as Array<{ text: string }>)[0]!.text), { providerId: "prv_x", slot: "personal", models: ["a/b"], notice: "n" });
    assert.deepEqual(calls, [["list", "http://127.0.0.1:1234/v1"], ["share", { url: "http://127.0.0.1:1234/v1", models: ["a/b"], name: "Mine" }]]);
    const noUrl = await withHub.client.callTool({ name: "local_models", arguments: { action: "share" } });
    assert.equal(noUrl.isError, true);
    const badAction = await withHub.client.callTool({ name: "local_models", arguments: { action: "drop" } });
    assert.equal(badAction.isError, true);
  } finally {
    await withHub.client.close(); await withHub.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
