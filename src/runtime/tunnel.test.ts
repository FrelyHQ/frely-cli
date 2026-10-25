import test from "node:test";
import assert from "node:assert/strict";
import { connect, createServer, type Server, type Socket } from "node:net";
import { parseTunnelArguments, parseTunnelTarget, startTunnel } from "./tunnel.js";

const listen = (server: Server): Promise<number> => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = (server: Server): Promise<void> => new Promise((resolve) => { server.close(() => resolve()); });

/** An HTTP CONNECT proxy that records the requests and then echoes everything back. */
async function fakeProxy(status = 200): Promise<{ port: number; requests: string[]; stop: () => Promise<void> }> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      requests.push(head);
      if (status !== 200) { socket.end(`HTTP/1.1 ${status} Nope\r\n\r\n`); return; }
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.on("data", (data) => socket.write(data));
    };
    socket.on("data", onData);
  });
  const port = await listen(server);
  return { port, requests, stop: async () => { for (const socket of sockets) socket.destroy(); await close(server); } };
}

const roundTrip = (port: number, message: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = connect(port, "127.0.0.1", () => socket.write(message));
  let received = "";
  socket.on("data", (chunk) => { received += chunk.toString(); if (received.length >= message.length) socket.end(); });
  socket.once("close", () => resolve(received));
  socket.once("error", reject);
});

test("targets: host:port, [v6]:port; anything else is refused", () => {
  assert.deepEqual(parseTunnelTarget("db.example.com:5432"), { host: "db.example.com", port: 5432 });
  assert.deepEqual(parseTunnelTarget("[::1]:6379"), { host: "::1", port: 6379 });
  for (const bad of ["db.example.com", "db:0", "db:65536", ":5432", "a b:1", "a/b:1", "u@h:1", "db:port"]) assert.throws(() => parseTunnelTarget(bad), /Usage/u, bad);
});

test("--local-port defaults to the remote port and is validated", () => {
  assert.deepEqual(parseTunnelArguments(["db:5432"]), { host: "db", port: 5432, localPort: 5432 });
  assert.deepEqual(parseTunnelArguments(["db:5432", "--local-port", "15432"]), { host: "db", port: 5432, localPort: 15432 });
  assert.deepEqual(parseTunnelArguments(["--local-port=1", "db:5432"]), { host: "db", port: 5432, localPort: 1 });
  assert.throws(() => parseTunnelArguments(["db:5432", "--local-port", "0"]), /--local-port/u);
  assert.throws(() => parseTunnelArguments(["db:5432", "--local-port"]), /--local-port/u);
  assert.throws(() => parseTunnelArguments([]), /Usage/u);
  assert.throws(() => parseTunnelArguments(["a:1", "b:2"]), /Usage/u);
});

test("each connection is forwarded through the proxy with its credentials, several at once", async () => {
  const proxy = await fakeProxy();
  const tunnel = await startTunnel({ proxyUrl: `http://user:pw@127.0.0.1:${proxy.port}`, host: "db.example.com", port: 5432, localPort: 0 });
  try {
    assert.match(tunnel.address, /^127\.0\.0\.1:\d+$/u);
    const port = Number(tunnel.address.split(":")[1]);
    const replies = await Promise.all([roundTrip(port, "hello one"), roundTrip(port, "hello two"), roundTrip(port, "hello three")]);
    assert.deepEqual(replies.sort(), ["hello one", "hello three", "hello two"]);
    assert.equal(proxy.requests.length, 3);
    for (const request of proxy.requests) {
      assert.match(request, /^CONNECT db\.example\.com:5432 HTTP\/1\.1\r\n/u);
      assert.match(request, new RegExp(`Proxy-Authorization: Basic ${Buffer.from("user:pw").toString("base64")}`, "u"));
    }
  } finally {
    await close(tunnel.server);
    await proxy.stop();
  }
});

test("a proxy that refuses the destination closes the client and reports the reason", async () => {
  const proxy = await fakeProxy(403);
  const errors: string[] = [];
  const tunnel = await startTunnel({ proxyUrl: `http://127.0.0.1:${proxy.port}`, host: "10.0.0.5", port: 5432, localPort: 0, onError: (error) => errors.push(error.message) });
  try {
    const reply = await roundTrip(Number(tunnel.address.split(":")[1]), "x");
    assert.equal(reply, "");
    assert.deepEqual(errors, ["The proxy refused the tunnel (HTTP 403)."]);
  } finally {
    await close(tunnel.server);
    await proxy.stop();
  }
});

test("a client that vanishes releases its proxy connection, and a busy port is explained", async () => {
  const proxy = await fakeProxy();
  const tunnel = await startTunnel({ proxyUrl: `http://127.0.0.1:${proxy.port}`, host: "db", port: 1, localPort: 0 });
  try {
    const port = Number(tunnel.address.split(":")[1]);
    const client = connect(port, "127.0.0.1");
    await new Promise((resolve) => client.once("connect", resolve));
    client.write("x");
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(startTunnel({ proxyUrl: `http://127.0.0.1:${proxy.port}`, host: "db", port: 1, localPort: port }), /already in use/u);
  } finally {
    await close(tunnel.server);
    await proxy.stop();
  }
});

test("a failing upstream closes only that client with one error line, and the tunnel keeps serving", async () => {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    connections++;
    const attempt = connections;
    let head = "";
    socket.on("data", function onData(chunk: Buffer) {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      if (attempt === 1) { socket.destroy(); return; }
      if (attempt === 2) { socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
      if (attempt === 3) { socket.write("HTTP/1.1 200 OK\r\n\r\n"); setTimeout(() => socket.destroy(), 20); return; }
      socket.write("HTTP/1.1 200 OK\r\n\r\n");
      socket.on("data", (data) => socket.write(data));
    });
  });
  const proxyPort = await listen(server);
  const errors: string[] = [];
  const tunnel = await startTunnel({ proxyUrl: `http://127.0.0.1:${proxyPort}`, host: "ssh.example.com", port: 22, localPort: 0, onError: (error) => errors.push(error.message) });
  const port = Number(tunnel.address.split(":")[1]);
  // A client that keeps writing while the upstream fails, like ssh waiting for a banner.
  const chatty = (): Promise<void> => new Promise((resolve) => {
    const client = connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    const timer = setInterval(() => client.write("SSH-2.0-test\r\n"), 5);
    client.once("close", () => { clearInterval(timer); resolve(); });
  });
  try {
    await chatty();
    await chatty();
    await chatty();
    assert.equal(errors.length, 2, "the third upstream died after tunnelling and is not an error line");
    assert.deepEqual(errors, ["The proxy closed the connection before answering.", "The proxy refused the tunnel (HTTP 502)."]);
    assert.equal(await roundTrip(port, "still serving"), "still serving");
  } finally {
    await close(tunnel.server);
    for (const socket of sockets) socket.destroy();
    await close(server);
  }
});
