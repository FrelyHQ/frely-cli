import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import test from "node:test";
import { waitForLocalProviderRelay } from "./control.js";

test("local Provider Relay readiness probe waits for the device data path", async () => {
  const providerToken = "Bearer signed-provider-token";
  let validRequests = 0;
  const probeAuthorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/local-provider/v1/models") {
      validRequests += 1;
      probeAuthorizations.push(request.headers.authorization);
      if (validRequests <= 2) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "device_offline", message: "Frely device is offline." } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [] }));
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
    await waitForLocalProviderRelay(`http://127.0.0.1:${address.port}/local-provider/v1`, "signed-provider-token", 3_000);
    // The probe retries on 503 until the device data path answers 200. Under test
    // load the per-probe timeout can fire and other parallel tests can send stray
    // requests at this socket, so the exact probe count is not deterministic. Only
    // track requests for the data-path endpoint and assert the contract that
    // matters: it waited at least until the data path was ready, and every data-path
    // request authenticated with the provider token.
    assert.ok(validRequests >= 3, "probe waited until the device data path was ready");
    assert.ok(
      probeAuthorizations.length >= 3 && probeAuthorizations.every((a) => a === providerToken),
      "every data-path request authenticated with the provider token"
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
