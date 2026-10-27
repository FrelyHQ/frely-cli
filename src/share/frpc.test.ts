import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureFrpc, frpcAsset, frpcDirectory, FRPC_VERSION } from "./frpc.js";
import { frpcConfigToml, parseShareGrant } from "./frpc-config.js";

const grantValue = () => ({
  id: "frps_" + "ab".repeat(12), url: "https://s" + "0a".repeat(7) + ".share.example.test/?t=abc", expiresAt: "2026-10-29T10:00:00.000Z", node: "dmit-la",
  bandwidthBytesPerSecond: 1048576, remainingBytes: 100 * 1048576,
  frpc: { serverAddr: "203.0.113.7", serverPort: 7000, user: "frps_" + "ab".repeat(12), token: "frs_" + "T".repeat(43), proxyName: "share", subdomain: "s" + "0a".repeat(7) },
});

test("every supported platform has a pinned archive; others are refused", () => {
  for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"], ["win32", "arm64"]]) {
    const asset = frpcAsset(platform, arch);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(asset.file.includes(FRPC_VERSION));
  }
  assert.equal(frpcAsset("win32", "x64").binary, "frpc.exe");
  assert.throws(() => frpcAsset("freebsd", "x64"), /no frpc build/u);
  assert.equal(frpcDirectory({ XDG_DATA_HOME: "/data" }, "linux", "/home/u"), join("/data", "frely", "bin"));
  assert.equal(frpcDirectory({}, "linux", "/home/u"), join("/home/u", ".local", "share", "frely", "bin"));
});

test("a download is verified against its pinned checksum before it is unpacked, installed once and kept", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frely-frpc-test-"));
  try {
    const real = frpcAsset("linux", "x64");
    // Bytes that do not match the pinned checksum are refused and nothing is installed.
    await assert.rejects(ensureFrpc({ platform: "linux", arch: "x64", directory, download: async () => new TextEncoder().encode("not frpc"), extract: async () => assert.fail("must not unpack") }), /pinned checksum/u);
    await assert.rejects(access(join(directory, `frpc-${FRPC_VERSION}`)));
    // Matching bytes install the extracted binary; the second call downloads nothing.
    const archive = new TextEncoder().encode("fake archive");
    const asset = { ...real, sha256: createHash("sha256").update(archive).digest("hex") };
    let downloads = 0;
    const deps = {
      platform: "linux", arch: "x64", directory, asset,
      download: async (url: string) => { downloads += 1; assert.ok(url.endsWith(real.file)); return archive; },
      extract: async (_archive: string, into: string) => { await mkdir(join(into, "frp_x"), { recursive: true }); await writeFile(join(into, "frp_x", "frpc"), "#!/bin/sh\n"); },
    };
    const path = await ensureFrpc(deps);
    assert.equal(path, join(directory, `frpc-${FRPC_VERSION}`));
    assert.equal(await readFile(path, "utf8"), "#!/bin/sh\n");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o111, 0o111);
    await ensureFrpc(deps);
    assert.equal(downloads, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an existing pinned binary is used without any download", async () => {
  const directory = await mkdtemp(join(tmpdir(), "frely-frpc-test-"));
  try {
    await writeFile(join(directory, `frpc-${FRPC_VERSION}`), "x");
    const path = await ensureFrpc({ platform: "linux", arch: "x64", directory, download: async () => assert.fail("must not download") });
    assert.equal(await readFile(path, "utf8"), "x");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the frpc config has one http proxy on loopback, TLS, the session token and no plugin or admin port", () => {
  const toml = frpcConfigToml(parseShareGrant(grantValue()), 40123);
  assert.match(toml, /^serverAddr = "203\.0\.113\.7"$/mu);
  assert.match(toml, /^user = "frps_[0-9a-f]{24}"$/mu);
  assert.match(toml, /^metadatas\.token = "frs_T{43}"$/mu);
  assert.match(toml, /^localIP = "127\.0\.0\.1"$/mu);
  assert.match(toml, /^localPort = 40123$/mu);
  assert.match(toml, /^transport\.tls\.enable = true$/mu);
  assert.match(toml, /^type = "http"$/mu);
  assert.equal((toml.match(/\[\[proxies\]\]/gu) ?? []).length, 1);
  assert.doesNotMatch(toml, /plugin|webServer|admin/iu);
});

test("a malformed or hostile share session is refused before anything is written", () => {
  const bad = (change: (value: ReturnType<typeof grantValue>) => void) => { const value = grantValue(); change(value); assert.throws(() => parseShareGrant(value), /invalid share session/u); };
  bad((v) => { v.frpc.serverAddr = "evil.example\nlocalIP = \"10.0.0.1\""; });
  bad((v) => { v.frpc.token = "frs_\"\nplugin"; });
  bad((v) => { v.frpc.user = "frps_" + "cd".repeat(12); });
  bad((v) => { v.frpc.proxyName = "other"; });
  bad((v) => { v.frpc.subdomain = "../x"; });
  bad((v) => { v.frpc.serverPort = 70000; });
  bad((v) => { v.url = "http://s" + "0a".repeat(7) + ".share.example.test/"; });
  bad((v) => { v.url = "https://other.example.test/"; });
  assert.throws(() => parseShareGrant(null), /invalid share session/u);
});
