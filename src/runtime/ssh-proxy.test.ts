import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer, connect, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parseProxyUrl, sshProxyConnect } from "./ssh-proxy.js";
import { sshProxyPrefix } from "./sandbox.js";

const run = promisify(execFile);
const CLI_ENTRY = fileURLToPath(new URL("../index.js", import.meta.url));

/** A TCP server that echoes what it receives, optionally sending a banner first (like an ssh server does). */
async function startTarget(banner?: string) {
  const server = createTcpServer((socket) => { if (banner) socket.write(banner); socket.pipe(socket); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** An HTTP CONNECT proxy that requires Basic credentials and answers 407 otherwise. `coalesce` sends the first target bytes with the 200 reply. */
async function startProxy(user: string, password: string, coalesce = false) {
  const requests: string[] = [];
  const server: Server = createServer();
  server.on("connect", (request, client, head) => {
    requests.push(String(request.url));
    const expected = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    if (request.headers["proxy-authorization"] !== expected) { client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n"); return; }
    const [host, port] = String(request.url).split(":");
    const upstream = connect({ host: host!, port: Number(port) }, () => {
      if (coalesce) upstream.once("data", (first) => { client.write(Buffer.concat([Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n"), first])); client.pipe(upstream); upstream.pipe(client); });
      else { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); }
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, requests, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function relay(proxyUrl: string, targetPort: number, send: string): Promise<string> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = sshProxyConnect({ proxyUrl, host: "127.0.0.1", port: targetPort, input, output });
  setTimeout(() => input.end(send), 20);
  await done;
  return Buffer.concat(chunks).toString();
}

test("proxy URLs give the host, port and decoded Basic credentials", () => {
  assert.deepEqual(parseProxyUrl("http://localhost:8080"), { host: "localhost", port: 8080 });
  assert.deepEqual(parseProxyUrl(`http://${encodeURIComponent("a b")}:${encodeURIComponent("p@ss:w/rd")}@localhost:65230`), {
    host: "localhost", port: 65230, authorization: `Basic ${Buffer.from("a b:p@ss:w/rd").toString("base64")}`,
  });
  assert.throws(() => parseProxyUrl("socks5h://localhost:1080"), /http:\/\//);
  assert.throws(() => parseProxyUrl("not a url"), /valid proxy URL/);
});

test("an authenticated CONNECT tunnel relays both directions and never leaks the proxy reply", async () => {
  const target = await startTarget();
  const proxy = await startProxy("srt.cmd", "s3cret");
  try {
    assert.equal(await relay(`http://srt.cmd:s3cret@127.0.0.1:${proxy.port}`, target.port, "ping"), "ping");
    assert.deepEqual(proxy.requests, [`127.0.0.1:${target.port}`]);
  } finally { await proxy.close(); await target.close(); }
});

test("bytes the proxy sends right behind its 200 reply (an ssh banner) are delivered", async () => {
  const target = await startTarget("SSH-2.0-test\r\n");
  const proxy = await startProxy("u", "p", true);
  try {
    assert.equal(await relay(`http://u:p@127.0.0.1:${proxy.port}`, target.port, ""), "SSH-2.0-test\r\n");
  } finally { await proxy.close(); await target.close(); }
});

test("credentials with reserved characters are decoded before they are sent", async () => {
  const target = await startTarget();
  const proxy = await startProxy("a b", "p@ss:w/rd");
  try {
    const url = `http://${encodeURIComponent("a b")}:${encodeURIComponent("p@ss:w/rd")}@127.0.0.1:${proxy.port}`;
    assert.equal(await relay(url, target.port, "x"), "x");
  } finally { await proxy.close(); await target.close(); }
});

test("a refused tunnel fails with the proxy status and never prints the credentials or any output", async () => {
  const target = await startTarget();
  const proxy = await startProxy("u", "right-password");
  try {
    await assert.rejects(() => relay(`http://u:wrong-password@127.0.0.1:${proxy.port}`, target.port, "x"), (error: Error) => {
      assert.match(error.message, /HTTP 407/);
      assert.ok(!error.message.includes("wrong-password"));
      return true;
    });
  } finally { await proxy.close(); await target.close(); }
});

test("an unreachable proxy fails with a clear message", async () => {
  const closed = createTcpServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  await assert.rejects(() => relay(`http://u:p@127.0.0.1:${port}`, 22, ""), /Cannot reach the proxy/);
});

test("on macOS the sandbox prefix turns GIT_SSH_COMMAND into a ProxyCommand that tunnels through the authenticated proxy", { skip: process.platform === "win32" }, async () => {
  const target = await startTarget();
  const proxy = await startProxy("srt.cmd", "s3cret");
  try {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HTTP_PROXY: `http://srt.cmd:s3cret@127.0.0.1:${proxy.port}`, GIT_SSH_COMMAND: "ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='nc -X 5 -x localhost:1 %h %p'" };
    // What git does with GIT_SSH_COMMAND: run it through sh with the host appended. A stub ssh on PATH prints the ProxyCommand option it was given.
    const bin = await mkdtemp(join(tmpdir(), "frely-ssh-stub-"));
    await writeFile(join(bin, "ssh"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) shift; case "$1" in ProxyCommand=*) printf %s "${1#ProxyCommand=}";; esac;; esac; shift; done\n', { mode: 0o755 });
    env.PATH = `${bin}:${env.PATH}`;
    const prefix = sshProxyPrefix("darwin", [process.execPath, CLI_ENTRY, "ssh-proxy"]);
    const printed = await run("/bin/sh", ["-c", `${prefix}sh -c "$GIT_SSH_COMMAND github.com"`], { env });
    assert.ok(printed.stdout.includes("ssh-proxy %h %p"), printed.stdout);
    assert.ok(!printed.stdout.includes("s3cret"), "credentials must not appear on the command line");
    // What ssh does with it: run the ProxyCommand with the host and port filled in, and talk through it.
    const command = printed.stdout.replace("%h", "127.0.0.1").replace("%p", String(target.port));
    const child = spawn("/bin/sh", ["-c", command], { env });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stdin.end("hello");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    assert.equal(out, "hello");
    assert.deepEqual(proxy.requests, [`127.0.0.1:${target.port}`]);
  } finally { await proxy.close(); await target.close(); }
});

test("the prefix leaves srt's own setting alone on other platforms, without proxy credentials, and without GIT_SSH_COMMAND", { skip: process.platform === "win32" }, async () => {
  const srtCommand = "ssh -o ControlMaster=no -o ControlPath=none -o ProxyCommand='nc -X 5 -x localhost:1 %h %p'";
  const show = async (platform: string, env: Record<string, string>) => (await run("/bin/sh", ["-c", `${sshProxyPrefix(platform, ["frely", "ssh-proxy"])}printf %s "$GIT_SSH_COMMAND"`], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } })).stdout;
  assert.equal(await show("linux", { HTTP_PROXY: "http://u:p@localhost:1", GIT_SSH_COMMAND: srtCommand }), srtCommand);
  assert.equal(await show("darwin", { HTTP_PROXY: "http://localhost:1", GIT_SSH_COMMAND: srtCommand }), srtCommand);
  assert.equal(await show("darwin", { HTTP_PROXY: "http://u:p@localhost:1" }), "");
});
