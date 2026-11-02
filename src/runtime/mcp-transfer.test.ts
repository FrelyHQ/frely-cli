import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp.js";
import { Workspace } from "./workspace.js";

async function withClient(run: (client: Client, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-transfer-"));
  const server = await createMcpServer(root);
  const client = new Client({ name: "frely-cli-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { await run(client, root); } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
}

const text = (result: unknown) => (result as { content: Array<{ text: string }> }).content[0]!.text;
const gate = { "frely/transfer": true };

test("transfer tools are hidden and refuse calls without the relay's mark", () => withClient(async (client, root) => {
  await writeFile(join(root, "a.bin"), "hello");
  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(!listed.some((name) => name.startsWith("transfer_")));
  const denied = await client.callTool({ name: "transfer_prepare", arguments: { path: "a.bin" } });
  assert.equal(denied.isError, true);
  const ok = await client.callTool({ name: "transfer_prepare", arguments: { path: "a.bin" }, _meta: gate });
  assert.deepEqual(JSON.parse(text(ok)), { name: "a.bin", bytes: 5, sha256: createHash("sha256").update("hello").digest("hex") });
}));

test("transfer_upload and transfer_download refuse http, private and loopback targets", () => withClient(async (client, root) => {
  await writeFile(join(root, "a.bin"), "hello");
  const sha256 = createHash("sha256").update("hello").digest("hex");
  for (const url of ["http://example.com/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://example.com:8443/x", "https://user:pw@example.com/x"]) {
    for (const name of ["transfer_upload", "transfer_download"]) {
      const result = await client.callTool({ name, arguments: { path: name === "transfer_upload" ? "a.bin" : "b.bin", url, bytes: 5, sha256 }, _meta: gate });
      assert.equal(result.isError, true, `${name} ${url}`);
      assert.match(text(result), /turned off/u);
    }
  }
  const header = await client.callTool({ name: "transfer_upload", arguments: { path: "a.bin", url: "https://example.com/x", headers: { authorization: "x" }, bytes: 5, sha256 }, _meta: gate });
  assert.equal(header.isError, true);
}));

test("transfer_prepare refuses empty, oversize-looking and non-regular files", () => withClient(async (client, root) => {
  await writeFile(join(root, "empty"), "");
  const empty = await client.callTool({ name: "transfer_prepare", arguments: { path: "empty" }, _meta: gate });
  assert.equal(empty.isError, true);
  const dir = await client.callTool({ name: "transfer_prepare", arguments: { path: "." }, _meta: gate });
  assert.equal(dir.isError, true);
}));

test("writeStream checks size and sha256 before the file appears, and honours overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-stream-"));
  try {
    const workspace = await Workspace.open(root);
    const body = Buffer.from("payload");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const stream = async function* (data: Buffer) { yield data.subarray(0, 3); yield data.subarray(3); };
    await assert.rejects(workspace.writeStream("out/x.bin", stream(Buffer.from("payloae")), false, { bytes: 7, sha256 }), /SHA-256/u);
    await assert.rejects(workspace.writeStream("out/x.bin", stream(body), false, { bytes: 6, sha256 }), /larger/u);
    await assert.rejects(readFile(join(root, "out/x.bin")));
    await workspace.writeStream("out/x.bin", stream(body), false, { bytes: 7, sha256 });
    assert.equal((await readFile(join(root, "out/x.bin"))).toString(), "payload");
    await assert.rejects(workspace.writeStream("out/x.bin", stream(body), false, { bytes: 7, sha256 }), /overwrite/u);
    await workspace.writeStream("out/x.bin", stream(body), true, { bytes: 7, sha256 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
