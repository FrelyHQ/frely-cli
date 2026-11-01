import assert from "node:assert/strict";
import test from "node:test";
import { callCloudToolWith } from "./cloud.js";
import { CloudToolError } from "./skill/cloud-item.js";

/** A Cloud tool result exactly as the relay sends it: structuredContent on success, a JSON error part on failure. */
function relayResult(body: Record<string, unknown>, isError = false): DirectResultLike {
  return { isError, content: [{ type: "text", text: JSON.stringify(body) }] };
}

interface DirectResultLike { isError?: boolean; content?: unknown; structuredContent?: unknown; [key: string]: unknown }

function reader(result: DirectResultLike | Error, log: string[]) {
  return async () => ({
    tools: async () => { throw new Error("not used in this test"); },
    call: async () => {
      log.push("reader");
      if (result instanceof Error) throw result;
      return result;
    },
    close: async () => { log.push("reader-close"); },
  });
}

function controller(result: DirectResultLike | Error, log: string[]) {
  return async () => ({
    call: async (name: string, args: Record<string, unknown>) => {
      log.push(`controller:${name}:${JSON.stringify(args)}`);
      if (result instanceof Error) throw result;
      return result;
    },
    close: async () => { log.push("controller-close"); },
  });
}

test("a read-only Cloud call runs on the login reader alone and never opens a controller", async () => {
  const log: string[] = [];
  const value = await callCloudToolWith("skills.install", { skill: "frely/gpt800" }, {
    openReader: reader(relayResult({ installed: true }), log),
    openControllerConnection: controller(relayResult({ installed: true }), log),
  });
  assert.deepEqual(value, { installed: true });
  assert.deepEqual(log, ["reader", "reader-close"]);
});

test("a tool the read-only login cannot see falls back to the controller connection (frely_call)", async () => {
  const log: string[] = [];
  const value = await callCloudToolWith("keys.create", { name: "ci" }, {
    openReader: reader(relayResult({ error: { code: "tool_unavailable_or_forbidden" } }, true), log),
    openControllerConnection: controller(relayResult({ created: "key_1" }), log),
  });
  assert.deepEqual(value, { created: "key_1" });
  assert.deepEqual(log, [
    "reader", "reader-close",
    `controller:frely_call:{"tool":"keys.create","arguments":{"name":"ci"}}`,
    "controller-close",
  ]);
});

test("any other Cloud failure propagates without a fallback", async () => {
  const log: string[] = [];
  await assert.rejects(
    callCloudToolWith("skills.install", { skill: "frely/gpt800" }, {
      openReader: reader(relayResult({ error: { code: "creator_pass_required" } }, true), log),
      openControllerConnection: controller(relayResult({ ok: true }), log),
    }),
    (error: unknown) => error instanceof CloudToolError && error.code === "creator_pass_required",
  );
  assert.deepEqual(log, ["reader", "reader-close"]);
});

test("a success whose body is not a JSON object fails as invalid_operation_output", async () => {
  const log: string[] = [];
  await assert.rejects(
    callCloudToolWith("skills.install", {}, {
      openReader: reader({ isError: false, content: [{ type: "text", text: JSON.stringify("just a string") }] }, log),
      openControllerConnection: controller(relayResult({ ok: true }), log),
    }),
    (error: unknown) => error instanceof CloudToolError && error.code === "invalid_operation_output",
  );
});
