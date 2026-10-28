import assert from "node:assert/strict";
import { request, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MODEL_HOST, startModelProxy } from "./model-proxy.js";

const skip = process.platform === "win32";

interface Seen { url: string; method: string | undefined; headers: Record<string, string>; body: string }

/** What the sandbox's own proxy sends to the socket: a request whose target is the absolute URL. */
function viaSocket(socketPath: string, target: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((done, fail) => {
    let result: { status: number; headers: IncomingHttpHeaders; body: string } | undefined;
    const req = request({ socketPath, path: target, method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => { result = { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }; });
    });
    req.on("error", fail);
    // Settle once the connection is fully closed, so a large upload has finished writing before the proxy is shut down.
    req.on("close", () => { if (result) done(result); else fail(new Error("closed without an answer")); });
    req.end(init.body);
  });
}

async function withProxy(work: (socketPath: string, seen: Seen[]) => Promise<void>, answer: (url: string) => Response = () => new Response('{"ok":true}', { headers: { "content-type": "application/json", "set-cookie": "a=b", "x-secret": "no" } })) {
  const seen: Seen[] = [];
  const socketPath = join(mkdtempSync(join(tmpdir(), "frely-mp-")), "m.sock");
  const proxy = await startModelProxy({
    socketPath, upstream: "https://api.example.test",
    authorization: async () => "Bearer REAL-KEY",
    fetchFn: (async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
      seen.push({ url: String(url), method: init?.method, headers, body: init?.body ? Buffer.from(init.body as Uint8Array).toString("utf8") : "" });
      return answer(String(url));
    }) as typeof fetch,
  });
  try { await work(socketPath, seen); } finally { await proxy.close(); }
}

test("a model call gets the real key and loses whatever credential the program sent", { skip }, async () => {
  await withProxy(async (socket, seen) => {
    const result = await viaSocket(socket, `http://${MODEL_HOST}/v1/chat/completions?x=1`, {
      method: "POST", body: '{"model":"m"}',
      headers: { "content-type": "application/json", authorization: "Bearer frely-local-placeholder", "x-api-key": "stolen", cookie: "c=1", "x-forwarded-for": "1.2.3.4", "anthropic-version": "2023-06-01" },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "https://api.example.test/v1/chat/completions?x=1");
    assert.equal(seen[0]!.method, "POST");
    assert.equal(seen[0]!.body, '{"model":"m"}');
    assert.deepEqual(seen[0]!.headers, { authorization: "Bearer REAL-KEY", "content-type": "application/json", "anthropic-version": "2023-06-01" });
    // Nothing from the upstream answer that is not on the short list reaches the program.
    assert.equal(result.headers["set-cookie"], undefined);
    assert.equal(result.headers["x-secret"], undefined);
    assert.equal(result.headers["content-type"], "application/json");
  });
});

test("only the model endpoints and the Frely host are served", { skip }, async () => {
  await withProxy(async (socket, seen) => {
    assert.equal((await viaSocket(socket, `http://${MODEL_HOST}/v1/models`)).status, 200);
    for (const [method, path] of [["GET", "/v1/chat/completions"], ["POST", "/v1/models"], ["GET", "/api/key/budget"], ["POST", "/v1/keys"], ["GET", "/v1/models/../keys"], ["DELETE", "/v1/responses"]] as const) {
      assert.equal((await viaSocket(socket, `http://${MODEL_HOST}${path}`, { method })).status, 404, `${method} ${path}`);
    }
    assert.equal((await viaSocket(socket, "http://other.example.test/v1/models")).status, 404);
    assert.equal((await viaSocket(socket, "/v1/models")).status, 404);
    assert.equal(seen.length, 1);
  });
});

test("a request over 16 MiB is refused before it is sent", { skip }, async () => {
  await withProxy(async (socket, seen) => {
    const result = await viaSocket(socket, `http://${MODEL_HOST}/v1/responses`, { method: "POST", body: "x".repeat(16 * 1024 * 1024 + 1) });
    assert.equal(result.status, 413);
    assert.equal(seen.length, 0);
  });
});

test("an unreachable gateway and a missing key are reported without a key in the text", { skip }, async () => {
  const socketPath = join(mkdtempSync(join(tmpdir(), "frely-mp-")), "m.sock");
  const proxy = await startModelProxy({ socketPath, upstream: "https://api.example.test", authorization: async () => { throw new Error("No key."); }, fetchFn: (async () => { throw new Error("down"); }) as typeof fetch });
  try {
    const noKey = await viaSocket(socketPath, `http://${MODEL_HOST}/v1/models`);
    assert.equal(noKey.status, 401);
    assert.match(noKey.body, /No key\./u);
  } finally { await proxy.close(); }
  const downPath = join(mkdtempSync(join(tmpdir(), "frely-mp-")), "m.sock");
  const down = await startModelProxy({ socketPath: downPath, upstream: "https://api.example.test", authorization: async () => "Bearer REAL-KEY", fetchFn: (async () => { throw new Error("connect REAL-KEY failed"); }) as typeof fetch });
  try {
    const result = await viaSocket(downPath, `http://${MODEL_HOST}/v1/models`);
    assert.equal(result.status, 502);
    assert.ok(!result.body.includes("REAL-KEY"));
  } finally { await down.close(); }
});
