import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function withClient(run: (client: Client, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-binary-"));
  const server = await createMcpServer(root);
  const client = new Client({ name: "frely-cli-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client, root); } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}

test("read encoding=base64 returns bytes with their sha256", () => withClient(async (client, root) => {
  const data = Buffer.from([0, 255, 1, 2, 128, 0]);
  await writeFile(join(root, "blob.bin"), data);
  const result = await client.callTool({ name: "read", arguments: { action: "read", path: "blob.bin", encoding: "base64" } });
  const body = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  assert.equal(body.content, data.toString("base64"));
  assert.equal(body.sha256, createHash("sha256").update(data).digest("hex"));
  assert.equal(body.mimeType, "application/octet-stream");
}));

test("read encoding=image returns an image block and refuses other types", () => withClient(async (client, root) => {
  await writeFile(join(root, "a.png"), PNG);
  await writeFile(join(root, "a.txt"), "text");
  const result = await client.callTool({ name: "read", arguments: { action: "read", path: "a.png", encoding: "image" } });
  const [image, meta] = result.content as Array<Record<string, string>>;
  assert.deepEqual([image!.type, image!.mimeType, image!.data], ["image", "image/png", PNG.toString("base64")]);
  assert.equal(JSON.parse(meta!.text!).bytes, PNG.byteLength);
  const refused = await client.callTool({ name: "read", arguments: { action: "read", path: "a.txt", encoding: "image" } });
  assert.equal(refused.isError, true);
}));

test("edit_file contentBase64 writes binary data atomically and validates the input", () => withClient(async (client, root) => {
  const written = await client.callTool({ name: "edit_file", arguments: { path: "out/a.png", contentBase64: PNG.toString("base64") } });
  assert.equal(written.isError, undefined);
  assert.deepEqual(await readFile(join(root, "out", "a.png")), PNG);
  for (const bad of [{ contentBase64: "not base64!" }, { contentBase64: "AAAA", content: "x" }]) {
    const result = await client.callTool({ name: "edit_file", arguments: { path: "bad.bin", ...bad } });
    assert.equal(result.isError, true);
  }
}));
