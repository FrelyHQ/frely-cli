import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { AgentHostConnection } from "./supervisor.js";

test("a stream error on the host connection closes it instead of raising an uncaught exception", async () => {
  const duplex = new PassThrough();
  const child = new EventEmitter();
  const Connection = AgentHostConnection as unknown as new (process: unknown, duplex: unknown) => AgentHostConnection;
  const connection = new Connection(child, duplex);
  const closed = new Promise<Error | undefined>((resolve) => connection.onClose(resolve));
  duplex.destroy(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
  const error = await closed;
  assert.match(error?.message ?? "", /ECONNRESET/u);
});
