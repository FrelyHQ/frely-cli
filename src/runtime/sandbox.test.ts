import test from "node:test";
import assert from "node:assert/strict";
import { buildSandboxConfig, detectSandboxBackend, isSandboxDisabled, PATH_GRANTS_META_KEY, pathGrantsFromMeta, sensitiveReadPaths } from "./sandbox.js";

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

test("a path grant reopens only its own group and never the Frely credential directory", () => {
  assert.ok(sensitiveReadPaths().includes("~/.ssh"));
  const withSsh = sensitiveReadPaths(["ssh"]);
  assert.ok(!withSsh.includes("~/.ssh"));
  assert.ok(withSsh.includes("~/.aws"));
  assert.ok(sensitiveReadPaths(["ssh", "aws", "gcloud", "kube", "gh", "gnupg", "git-credentials", "npm-tokens", "frely"]).includes("~/.config/frely"));
  assert.equal(buildSandboxConfig("/work", ["ssh"]).filesystem?.denyRead?.includes("~/.ssh"), false);
});

test("path grants are read from the relay's _meta key and unknown names are dropped", () => {
  assert.deepEqual(pathGrantsFromMeta({ [PATH_GRANTS_META_KEY]: ["ssh", "ssh", "frely", "../etc", 7] }), ["ssh"]);
  assert.deepEqual(pathGrantsFromMeta(undefined), []);
  assert.deepEqual(pathGrantsFromMeta({ [PATH_GRANTS_META_KEY]: "ssh" }), []);
});
