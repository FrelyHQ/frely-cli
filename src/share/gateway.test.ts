import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import test from "node:test";
import { admissible, hostOnly, startGateway, upstreamHeaders } from "./gateway.js";

const HOST = "s0a0a0a0a0a0a0a.share.example.test";

async function target(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } };
}

function get(port: number, options: { host?: string; path?: string; method?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: options.path ?? "/", method: options.method ?? "GET", headers: { host: options.host ?? HOST, ...(options.headers ?? {}) } }, (response) => {
      let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.once("error", reject); request.end();
  });
}

test("a request for the share's own host reaches the service with internal headers removed and forwarding facts set", async () => {
  const seen: IncomingHttpHeaders[] = [];
  const service = await target((request, response) => { seen.push(request.headers); response.setHeader("location", "https://elsewhere.example/"); response.writeHead(302); response.end("moved"); });
  const gateway = await startGateway({ host: HOST, targetPort: service.port });
  try {
    const reply = await get(gateway.port, { path: "/a?b=1", headers: { "x-frely-internal": "1", "x-frp-reqid": "2", "x-forwarded-host": "spoof.example", cookie: "a=b" } });
    assert.equal(reply.status, 302);
    assert.equal(reply.headers.location, "https://elsewhere.example/", "redirects are passed on, never followed");
    assert.equal(seen[0]!["x-frely-internal"], undefined);
    assert.equal(seen[0]!["x-frp-reqid"], undefined);
    assert.equal(seen[0]!["x-forwarded-host"], HOST);
    assert.equal(seen[0]!["x-forwarded-proto"], "https");
    assert.equal(seen[0]!.cookie, "a=b");
    assert.equal(seen[0]!.host, HOST, "the host name is kept by default");
  } finally { await gateway.close(); service.close(); }
});

test("--rewrite-host sends localhost to the service", async () => {
  let host = "";
  const service = await target((request, response) => { host = request.headers.host ?? ""; response.end("ok"); });
  const gateway = await startGateway({ host: HOST, targetPort: service.port, rewriteHost: true });
  try { await get(gateway.port); assert.equal(host, `localhost:${service.port}`); } finally { await gateway.close(); service.close(); }
});

test("another host, CONNECT and absolute-form targets are not served", async () => {
  let reached = 0;
  const service = await target((_request, response) => { reached += 1; response.end("ok"); });
  const gateway = await startGateway({ host: HOST, targetPort: service.port });
  try {
    assert.equal((await get(gateway.port, { host: "other.example.test" })).status, 404);
    assert.equal((await get(gateway.port, { host: "127.0.0.1" })).status, 404);
    assert.equal((await get(gateway.port, { path: "http://169.254.169.254/latest" })).status, 404);
    assert.equal((await get(gateway.port, { path: "//evil.example/x" })).status, 404);
    const connectReply = await new Promise<string>((resolve) => {
      const socket = connect(gateway.port, "127.0.0.1", () => socket.write(`CONNECT example.com:443 HTTP/1.1\r\nhost: ${HOST}\r\n\r\n`));
      let data = ""; socket.on("data", (chunk) => { data += chunk; }); socket.on("close", () => resolve(data));
    });
    assert.match(connectReply, /405/u);
    assert.equal(reached, 0);
  } finally { await gateway.close(); service.close(); }
});

test("a service that is down answers 502", async () => {
  const closed = await target((_request, response) => response.end());
  const port = closed.port; closed.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gateway = await startGateway({ host: HOST, targetPort: port });
  try { assert.equal((await get(gateway.port)).status, 502); } finally { await gateway.close(); }
});

test("a WebSocket-style upgrade is passed through as bytes in both directions", async () => {
  const received: string[] = [];
  const echo = createTcpServer((socket) => {
    let head = ""; socket.on("data", (chunk) => {
      head += chunk.toString();
      if (head.includes("\r\n\r\n") && !received.length) { received.push(head); socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n"); }
      else if (received.length) socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const gateway = await startGateway({ host: HOST, targetPort: (echo.address() as { port: number }).port });
  try {
    const reply = await new Promise<string>((resolve) => {
      const socket = connect(gateway.port, "127.0.0.1", () => socket.write(`GET /ws HTTP/1.1\r\nhost: ${HOST}\r\nconnection: Upgrade\r\nupgrade: websocket\r\nx-frely-internal: 1\r\n\r\n`));
      let data = ""; socket.on("data", (chunk) => { data += chunk; if (data.includes("\r\n\r\n") && !data.includes("pong")) socket.write("ping"); if (data.includes("ping")) { socket.destroy(); resolve(data); } });
    });
    assert.match(reply, /101 Switching Protocols/u);
    assert.match(reply, /ping/u);
    assert.match(received[0]!, /^GET \/ws HTTP\/1\.1/u);
    assert.doesNotMatch(received[0]!, /x-frely-internal/iu);
    assert.match(received[0]!, /upgrade: websocket/iu);
  } finally { await gateway.close(); echo.close(); }
});

test("the helpers decide host, target and header filtering", () => {
  assert.equal(hostOnly("Example.COM:8443"), "example.com");
  assert.equal(admissible({ headers: { host: HOST }, url: "/ok", method: "GET" }, HOST), null);
  assert.equal(admissible({ headers: { host: HOST }, url: "*", method: "OPTIONS" }, HOST), "bad target");
  const headers = upstreamHeaders({ host: HOST, connection: "keep-alive", "proxy-authorization": "x", "x-frely-a": "1", accept: "*/*" }, { host: HOST, targetPort: 1 });
  assert.deepEqual(Object.keys(headers).sort(), ["accept", "host", "x-forwarded-host", "x-forwarded-proto"]);
});
