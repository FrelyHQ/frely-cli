import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverLocalModels, executeLocalProviderRequest } from "./local.js";
import { normalizeLoopbackOpenAiBaseUrl, saveLocalProvider } from "./state.js";

test("local Provider URL accepts loopback only", () => {
  assert.equal(normalizeLoopbackOpenAiBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizeLoopbackOpenAiBaseUrl("http://localhost:11434/v1/"), "http://localhost:11434/v1");
  assert.equal(normalizeLoopbackOpenAiBaseUrl("http://[::1]:11434/v1"), "http://[::1]:11434/v1");
  assert.throws(() => normalizeLoopbackOpenAiBaseUrl("http://192.168.1.10:11434/v1"), /loopback/u);
  assert.throws(() => normalizeLoopbackOpenAiBaseUrl("https://127.0.0.1:11434/v1"), /HTTP on loopback/u);
  assert.throws(() => normalizeLoopbackOpenAiBaseUrl("http://127.0.0.1:11434/api"), /OpenAI-compatible/u);
});

test("local Provider discovery and relay use the configured loopback OpenAI endpoint", async () => {
  const previous = process.env.XDG_CONFIG_HOME;
  const root = await mkdtemp(join(tmpdir(), "frely-cli-provider-"));
  process.env.XDG_CONFIG_HOME = root;
  const seen: Array<{ method: string; url: string; authorization?: string }> = [];
  const server = createServer(async (request, response) => {
    seen.push({ method: request.method ?? "", url: request.url ?? "", ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "llama3.2" }, { id: "qwen3" }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed = JSON.parse(body) as { model?: string };
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ id: "chat_test", model: parsed.model, choices: [] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    assert.deepEqual(await discoverLocalModels(baseUrl), ["llama3.2", "qwen3"]);
    const providerId = `prv_${"c".repeat(24)}`;
    await saveLocalProvider({ providerId, name: "test", driver: "ollama", baseUrl, providerBaseUrl: "https://app.frely.cloud/local-provider/v1", models: ["llama3.2", "qwen3"], createdAt: new Date().toISOString() });
    const result = await executeLocalProviderRequest({
      providerId,
      request: { method: "POST", path: "/v1/chat/completions", body: { model: "llama3.2", messages: [{ role: "user", content: "ping" }] } },
    });
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "application/json");
    assert.deepEqual(JSON.parse(result.body), { id: "chat_test", model: "llama3.2", choices: [] });
    assert.equal(seen.some((request) => request.authorization !== undefined), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
