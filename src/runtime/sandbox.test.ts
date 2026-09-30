import test from "node:test";
import assert from "node:assert/strict";
import { detectSandboxBackend, isSandboxDisabled } from "./sandbox.js";

test("sandbox backend detection reports off when disabled and never throws", () => {
  const previous = process.env.FRELY_SANDBOX;
  try {
    process.env.FRELY_SANDBOX = "off";
    assert.equal(isSandboxDisabled(), true);
    assert.equal(detectSandboxBackend(), "off");
    process.env.FRELY_SANDBOX = "";
    const backend = detectSandboxBackend();
    assert.ok(backend === "srt" || backend === "none", `unexpected backend ${backend}`);
  } finally {
    if (previous === undefined) delete process.env.FRELY_SANDBOX; else process.env.FRELY_SANDBOX = previous;
  }
});
