import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { isBlockedAddress, webFetch } from "./web-fetch.js";

async function server(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; http: Server }> {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { port: (http.address() as { port: number }).port, http };
}

test("private, local and special-purpose addresses are blocked, public ones are not", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a00:1", "2001:db8::1", "not-an-ip"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "::ffff:808:808"]) assert.equal(isBlockedAddress(address), false, address);
});

test("a name that resolves to a private address, a bad port and a non-http scheme are refused before any connection", async () => {
  await assert.rejects(webFetch({ url: "http://internal.example/" }, { resolve: async () => ["10.0.0.5"] }), /private or local network/);
  await assert.rejects(webFetch({ url: "http://rebind.example/" }, { resolve: async () => ["93.184.216.34", "127.0.0.1"] }), /private or local network/);
  await assert.rejects(webFetch({ url: "http://127.0.0.1/" }), /private or local network/);
  await assert.rejects(webFetch({ url: "http://[::1]/" }), /private or local network/);
  await assert.rejects(webFetch({ url: "http://example.com:22/" }, { resolve: async () => ["93.184.216.34"] }), /ports 80 and 443/);
  await assert.rejects(webFetch({ url: "file:///etc/passwd" }), /Only http and https/);
  await assert.rejects(webFetch({ url: "http://user:pw@example.com/" }, { resolve: async () => ["93.184.216.34"] }), /credentials/);
});

test("fetches text, caps the body, and describes non-text responses", async () => {
  const { port, http } = await server((request, response) => {
    if (request.url === "/big") { response.writeHead(200, { "content-type": "text/plain" }); response.end("x".repeat(5000)); return; }
    if (request.url === "/bin") { response.writeHead(200, { "content-type": "image/png" }); response.end(Buffer.alloc(10)); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ method: request.method, host: request.headers.host, ua: request.headers["user-agent"] }));
  });
  try {
    const options = { trustedTestHosts: ["127.0.0.1", "localhost"] };
    const ok = await webFetch({ url: `http://localhost:${port}/` }, { ...options, resolve: async () => ["127.0.0.1"] });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { method: "GET", host: `localhost:${port}`, ua: "Mozilla/5.0 (compatible; FrelyAgent/1.0)" });
    const big = await webFetch({ url: `http://127.0.0.1:${port}/big`, maxBytes: 100 }, options);
    assert.equal(big.body.length, 100);
    assert.equal(big.truncated, true);
    assert.match((await webFetch({ url: `http://127.0.0.1:${port}/bin` }, options)).body, /image\/png response, 10 bytes/);
    await assert.rejects(webFetch({ url: `http://127.0.0.1:${port}/`, headers: { Host: "evil" } }, options), /not allowed/);
  } finally { http.close(); }
});

test("a redirect to a private address is refused and credentials do not follow a cross-origin redirect", async () => {
  const seen: Array<string | undefined> = [];
  const { port, http } = await server((request, response) => {
    if (request.url === "/to-private") { response.writeHead(302, { location: "http://10.0.0.7/admin" }); response.end(); return; }
    if (request.url === "/to-other") { response.writeHead(302, { location: `http://other.test:${(http.address() as { port: number }).port}/final` }); response.end(); return; }
    seen.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "text/plain" }); response.end("done");
  });
  try {
    const resolve = async (hostname: string) => hostname === "10.0.0.7" ? ["10.0.0.7"] : ["127.0.0.1"];
    // The first hop is let through by the test seam; the redirect target is still checked and refused.
    await assert.rejects(webFetch({ url: `http://localhost:${port}/to-private` }, { resolve, trustedTestHosts: ["localhost"] }), /private or local network/);
    // A redirect to another origin is followed and the Authorization header is dropped there.
    const followed = await webFetch({ url: `http://localhost:${port}/to-other`, headers: { Authorization: "Bearer secret" } }, { resolve, trustedTestHosts: ["localhost", "other.test"] });
    assert.equal(followed.body, "done");
    assert.equal(followed.redirects, 1);
    assert.deepEqual(seen, [undefined]);
  } finally { http.close(); }
});
