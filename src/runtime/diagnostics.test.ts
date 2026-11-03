import test from "node:test";
import assert from "node:assert/strict";
import { diagnostic, diagnosticError } from "./diagnostics.js";

test("diagnostics exclude untrusted messages, nested data and stack headers", () => {
  const secret = "synthetic-private-value";
  const error = Object.assign(new Error(`Bearer ${secret}\nstdout: ${secret}`), {
    code: "ENOENT", name: secret, cause: new Error(secret), stdout: secret, stderr: secret,
  });
  error.stack += `\n${secret}\n    at bad (https://example.test/?token=${secret}:1:2)`;
  const lines: string[] = [];
  diagnostic((line) => lines.push(line), "mcp.tool_failed", { requestId: "relay-request-aaa", tool: secret, method: secret }, error);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, new RegExp(secret));
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.error.code, "ENOENT");
  assert.equal(entry.tool, "unknown");
  assert.ok(entry.error.stack.some((line: string) => line.includes("diagnostics.test.js:")));
  assert.equal(diagnosticError(new Error("WebSocket closed (4412: hard_lifetime)")).message, "WebSocket closed (4412: hard_lifetime).");
  assert.equal(diagnosticError(new Error("WebSocket closed (1012: Service Restart)")).message, "WebSocket closed (1012: Service Restart).");
  assert.equal(diagnosticError(new Error("WebSocket closed (1006)")).message, "WebSocket closed (1006).");
  assert.equal(diagnosticError(new Error("WebSocket closed (4000: idle\u00e9 timeout)")).message, "WebSocket closed (4000: idle? timeout).");
  assert.equal(diagnosticError(new Error("Frely request failed with HTTP 502.")).message, "HTTP 502.");
  assert.doesNotThrow(() => diagnostic(() => { throw new Error("sink failed"); }, "mcp.request_started"));
});

test("socket close diagnostics keep only numbers and allow-listed error codes", () => {
  const lines: string[] = [];
  diagnostic((line) => lines.push(line), "relay.socket_closed", {
    closeCode: 1006, socketErrorCode: "ECONNRESET", ageMs: 600_123.4, sinceLastPingMs: 14_000, sinceLastPongMs: 29_000, sinceLastFrameMs: 31_000, inflight: 2,
  });
  diagnostic((line) => lines.push(line), "relay.socket_closed", { socketErrorCode: "private-value" });
  const [first, second] = lines.map((line) => JSON.parse(line));
  assert.deepEqual(
    { c: first.closeCode, e: first.socketErrorCode, a: first.ageMs, p: first.sinceLastPingMs, o: first.sinceLastPongMs, f: first.sinceLastFrameMs, i: first.inflight },
    { c: 1006, e: "ECONNRESET", a: 600_123, p: 14_000, o: 29_000, f: 31_000, i: 2 },
  );
  assert.equal(second.socketErrorCode, undefined);
});
