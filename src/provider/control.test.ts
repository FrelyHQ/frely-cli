import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import test from "node:test";
import { waitForLocalProviderRelay } from "./control.js";

test("local Provider Relay readiness probe waits for the device data path", async () => {
  let attempts = 0;
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    attempts += 1;
    authorizations.push(request.headers.authorization);
    if (request.method !== "GET" || request.url !== "/local-provider/v1/models") {
      response.writeHead(404).end();
      return;
    }
    if (attempts < 3) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "device_offline", message: "Frely device is offline." } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await waitForLocalProviderRelay(`http://127.0.0.1:${address.port}/local-provider/v1`, "signed-provider-token", 3_000);
    assert.equal(attempts, 3);
    assert.deepEqual(authorizations, ["Bearer signed-provider-token", "Bearer signed-provider-token", "Bearer signed-provider-token"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
