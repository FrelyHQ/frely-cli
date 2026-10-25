import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScutilProxy, proxyFromEnv, readSavedProxy, resolveUpstreamProxy, runSandboxProxyCommand, saveProxy, usableProxyUrl } from "./sandbox-proxy.js";

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : 10.0.0.0/8
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7892
  SOCKSProxy : 127.0.0.1
}
`;

test("only http(s) proxy URLs are usable; SOCKS and junk are ignored", () => {
  assert.equal(usableProxyUrl("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(usableProxyUrl(" 127.0.0.1:7890 "), "127.0.0.1:7890");
  assert.equal(usableProxyUrl("https://user:pw@proxy.corp:8443"), "https://user:pw@proxy.corp:8443");
  for (const bad of ["socks5://127.0.0.1:1080", "socks5h://x:1", "", "  ", undefined, "http://"]) assert.equal(usableProxyUrl(bad), undefined, String(bad));
});

test("process environment: HTTPS_PROXY and HTTP_PROXY first, ALL_PROXY as the fallback, NO_PROXY carried along", () => {
  assert.deepEqual(proxyFromEnv({ HTTPS_PROXY: "http://a:1", HTTP_PROXY: "http://b:2", NO_PROXY: "corp.example" }), { http: "http://b:2", https: "http://a:1", noProxy: "corp.example" });
  assert.deepEqual(proxyFromEnv({ http_proxy: "http://b:2" }), { http: "http://b:2", https: "http://b:2" });
  assert.deepEqual(proxyFromEnv({ ALL_PROXY: "http://c:3" }), { http: "http://c:3", https: "http://c:3" });
  assert.deepEqual(proxyFromEnv({ ALL_PROXY: "socks5://c:3" }), undefined);
  assert.deepEqual(proxyFromEnv({ HTTPS_PROXY: "http://a:1", ALL_PROXY: "socks5://c:3" }), { https: "http://a:1" });
  assert.equal(proxyFromEnv({}), undefined);
});

test("macOS system proxy is read from scutil output and its exceptions become NO_PROXY", () => {
  assert.deepEqual(parseScutilProxy(SCUTIL), { http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7891", noProxy: "*.local,169.254/16,10.0.0.0/8" });
  assert.equal(parseScutilProxy("<dictionary> {\n  HTTPEnable : 0\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  SOCKSEnable : 1\n}\n"), undefined);
  assert.equal(parseScutilProxy(""), undefined);
});

test("order: saved value, then process environment, then the macOS system proxy only on macOS", () => {
  const saved = { http: "http://saved:1", https: "http://saved:1" };
  const env = { HTTPS_PROXY: "http://env:2" };
  const system = () => parseScutilProxy(SCUTIL);
  assert.deepEqual(resolveUpstreamProxy({ saved, env, platform: "darwin", system }), saved);
  assert.deepEqual(resolveUpstreamProxy({ saved: undefined, env, platform: "darwin", system }), { https: "http://env:2" });
  assert.equal(resolveUpstreamProxy({ saved: undefined, env: {}, platform: "darwin", system })?.http, "http://127.0.0.1:7890");
  assert.equal(resolveUpstreamProxy({ saved: undefined, env: {}, platform: "linux", system }), undefined);
  let asked = false;
  resolveUpstreamProxy({ saved: undefined, env, platform: "darwin", system: () => { asked = true; return undefined; } });
  assert.equal(asked, false, "scutil is not run when the environment already names a proxy");
});

test("the saved proxy round-trips, is private to the owner, and a bad value is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frely-proxy-"));
  const path = join(dir, "frely", "sandbox.json");
  try {
    assert.equal(readSavedProxy(path), undefined);
    await saveProxy({ url: "http://127.0.0.1:7890", noProxy: "corp.example" }, path);
    assert.deepEqual(readSavedProxy(path), { http: "http://127.0.0.1:7890", https: "http://127.0.0.1:7890", noProxy: "corp.example" });
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);
    await assert.rejects(saveProxy({ url: "socks5://127.0.0.1:1080" }, path), /http/u);
    assert.match(readFileSync(path, "utf8"), /7890/u);
    await saveProxy(undefined, path);
    assert.equal(readSavedProxy(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frely sandbox proxy shows, saves and clears the value without printing a password", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frely-proxy-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const out: string[] = [];
    const write = (text: string) => { out.push(text); };
    await runSandboxProxyCommand(["http://me:secret@127.0.0.1:7890", "--no-proxy", "corp.example"], write);
    assert.deepEqual(readSavedProxy(join(dir, "frely", "sandbox.json")), { http: "http://me:secret@127.0.0.1:7890", https: "http://me:secret@127.0.0.1:7890", noProxy: "corp.example" });
    await runSandboxProxyCommand([], write);
    assert.doesNotMatch(out.join(""), /secret/u);
    assert.match(out.join(""), /127\.0\.0\.1:7890/u);
    await runSandboxProxyCommand(["--clear"], write);
    assert.equal(readSavedProxy(join(dir, "frely", "sandbox.json")), undefined);
    await assert.rejects(runSandboxProxyCommand(["a", "b"], write), /Usage/u);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
