import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { loginDevice } from "./auth.js";
import { useMemoryCredentialStore } from "./test-support.js";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");

test("device login honors browser selection without changing account authorization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-login-browser-"));
  const oldFetch = globalThis.fetch;
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, FRELY_NO_BROWSER: process.env.FRELY_NO_BROWSER };
  const restore = useMemoryCredentialStore();
  process.env.XDG_CONFIG_HOME = directory;
  let launches = 0;
  t.mock.method(childProcess, "spawn", () => {
    launches++;
    return Object.assign(new EventEmitter(), { unref() {} });
  });
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports(); restore(); globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/device/code") return Response.json({
      device_code: "synthetic-code", user_code: "SYNTH",
      verification_uri: "https://test.invalid/device",
      verification_uri_complete: "https://test.invalid/device?user_code=SYNTH",
      expires_in: 300, interval: 1,
    });
    if (path === "/api/auth/oauth2/token") return Response.json({ access_token: "synthetic-basic", expires_in: 3600 });
    if (path === "/api/auth/me") return Response.json({ user: { id: "synthetic-user", email: "user@example.com" } });
    throw new Error("Unexpected synthetic endpoint");
  };
  for (const scenario of [
    { options: { openBrowser: false }, env: undefined, launches: 0 },
    { options: {}, env: "1", launches: 0 },
    { options: {}, env: undefined, launches: 1 },
  ]) {
    if (scenario.env === undefined) delete process.env.FRELY_NO_BROWSER;
    else process.env.FRELY_NO_BROWSER = scenario.env;
    launches = 0;
    let notified = false;
    const result = await loginDevice("https://test.invalid", ({ verificationUri }) => {
      notified = true;
      assert.equal(verificationUri, "https://test.invalid/device?user_code=SYNTH");
    }, scenario.options);
    assert.equal(launches, scenario.launches);
    assert.equal(notified, true);
    assert.equal(result.user.id, "synthetic-user");
  }
});
