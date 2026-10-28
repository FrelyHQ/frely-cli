import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The real sandbox, the real model proxy and a real program inside. Off by default (the test preload turns the sandbox off and CI hosts
 * differ in what they can sandbox); run with FRELY_SANDBOX_E2E=1 on a Linux or macOS machine that has the sandbox dependencies.
 */
test("the confined program reaches the model through the proxy, never holds the key and reaches nothing else", { skip: process.env.FRELY_SANDBOX_E2E !== "1" }, async () => {
  delete process.env.FRELY_SANDBOX;
  const { restrictSandboxNetwork, shutdownSandbox, sandboxUnavailableReason } = await import("../../runtime/sandbox.js");
  assert.equal(sandboxUnavailableReason(), undefined);
  const { startModelProxy, MODEL_HOST } = await import("./model-proxy.js");
  const { agentEnv, spawnConfined } = await import("./confine.js");
  const seen: Array<{ url?: string | undefined; auth?: string | undefined; xkey?: string | string[] | undefined }> = [];
  const upstream = createServer((req, res) => { seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers["x-api-key"] }); res.setHeader("content-type", "application/json"); res.end('{"data":[]}'); });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const port = (upstream.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "frely-e2e-"));
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  const socket = join(dir, "m.sock");
  restrictSandboxNetwork({ allowedDomains: [MODEL_HOST], mitmProxy: { socketPath: socket, domains: [MODEL_HOST] } });
  const proxy = await startModelProxy({ socketPath: socket, upstream: `http://127.0.0.1:${port}`, authorization: async () => "Bearer REAL-KEY" });
  process.env.SECRET_FROM_SHELL = "must-not-leak";
  try {
    const env = { ...agentEnv(workspace, { model: true }), ...(process.env.FRELY_SANDBOX_E2E_PATH ? { PATH: `${process.env.FRELY_SANDBOX_E2E_PATH}:${process.env.PATH}` } : {}) };
    const script = [
      'echo "key=$OPENAI_API_KEY secret=$SECRET_FROM_SHELL"',
      'curl -s -m 15 "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY" -H "x-api-key: client"',
      'echo',
      'echo "elsewhere=$(curl -s -m 8 -o /dev/null -w \'%{http_code}\' http://example.com/)"',
      `echo "loopback=$(curl -s -m 5 --noproxy '' -o /dev/null -w '%{http_code}' http://127.0.0.1:${port}/)"`,
    ].join("; ");
    const { child, violations } = await spawnConfined(script, workspace, env);
    let output = "";
    child.stdout?.on("data", (data: Buffer) => { output += data.toString("utf8"); });
    await new Promise((done) => child.once("close", done));
    assert.match(output, /key=frely-local-placeholder secret=\n/u);
    assert.match(output, /\{"data":\[\]\}/u);
    assert.match(output, /elsewhere=403/u);
    assert.match(output, /loopback=(000|403)/u);
    assert.deepEqual(seen, [{ url: "/v1/models", auth: "Bearer REAL-KEY", xkey: undefined }]);
    assert.ok(violations().some((line) => line.includes("example.com")));
  } finally {
    delete process.env.SECRET_FROM_SHELL;
    await proxy.close();
    upstream.close();
    await shutdownSandbox();
  }
});
