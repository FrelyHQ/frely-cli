import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { irohDirectory, loadDownloadedIroh, type IrohNativeSpec } from "./iroh-download.js";

const module_ = Buffer.from("pretend native module");
const sha256 = createHash("sha256").update(module_).digest("hex");
const spec: IrohNativeSpec = { package: "iroh-linux-x64-gnu", version: "1.2.0", file: "iroh.linux-x64-gnu.node", sha256 };

async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "frely-iroh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const urls: string[] = [], logs: string[] = [], opened: string[] = [];
  const deps = (over: Partial<Parameters<typeof loadDownloadedIroh>[1]> = {}) => ({
    directory, log: (text: string) => { logs.push(text); }, dlopen: (path: string) => { opened.push(path); return { loaded: path }; },
    download: async (url: string) => { urls.push(url); return Buffer.from("tarball"); }, extract: async () => module_, ...over,
  });
  return { directory, urls, logs, opened, deps, cached: join(directory, `${spec.version}-${spec.package}`, spec.file) };
}

test("a verified cached module loads without any download", async (t) => {
  const s = await setup(t);
  await mkdir(join(s.directory, `${spec.version}-${spec.package}`), { recursive: true });
  await writeFile(s.cached, module_);
  assert.deepEqual(await loadDownloadedIroh(spec, s.deps()), { loaded: s.cached });
  assert.deepEqual(s.urls, []);
  assert.deepEqual(s.logs, []);
});

test("a missing module is downloaded once, verified, stored and loaded", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await loadDownloadedIroh(spec, s.deps()), { loaded: s.cached });
  assert.deepEqual(s.urls, ["https://registry.npmmirror.com/@number0/iroh-linux-x64-gnu/-/iroh-linux-x64-gnu-1.2.0.tgz"]);
  assert.match(s.logs.join(""), /Downloading the direct-transfer component/);
  assert.deepEqual(await readFile(s.cached), module_);
  assert.deepEqual((await readdir(join(s.directory, `${spec.version}-${spec.package}`))), [spec.file], "no temporary files left");
  assert.deepEqual((await readdir(s.directory)).filter((name) => name.startsWith(".download-")), []);
  if (process.platform !== "win32") assert.equal((await lstat(s.cached)).mode & 0o777, 0o700);
});

test("a cached file with the wrong hash is replaced by a fresh download", async (t) => {
  const s = await setup(t);
  await mkdir(join(s.directory, `${spec.version}-${spec.package}`), { recursive: true });
  await writeFile(s.cached, "tampered");
  assert.deepEqual(await loadDownloadedIroh(spec, s.deps()), { loaded: s.cached });
  assert.equal(s.urls.length, 1);
  assert.deepEqual(await readFile(s.cached), module_);
});

test("a download whose hash differs is refused, nothing is stored or loaded, and the next registry is tried", async (t) => {
  const s = await setup(t);
  let calls = 0;
  const result = await loadDownloadedIroh(spec, s.deps({ extract: async () => (++calls === 1 ? Buffer.from("evil") : module_) }));
  assert.deepEqual(result, { loaded: s.cached });
  assert.deepEqual(s.urls.map((url) => new URL(url).hostname), ["registry.npmmirror.com", "registry.npmjs.org"]);
  const refused = await setup(t);
  assert.equal(await loadDownloadedIroh(spec, refused.deps({ extract: async () => Buffer.from("evil") })), null);
  assert.deepEqual(refused.opened, []);
  await assert.rejects(lstat(refused.cached));
  assert.match(refused.logs.join(""), /checksum mismatch/);
});

test("download or load failures return null instead of throwing", async (t) => {
  const offline = await setup(t);
  assert.equal(await loadDownloadedIroh(spec, offline.deps({ download: async () => { throw new Error("offline"); } })), null);
  assert.match(offline.logs.join(""), /unavailable: offline/);
  const unloadable = await setup(t);
  assert.equal(await loadDownloadedIroh(spec, unloadable.deps({ dlopen: () => { throw new Error("GLIBC_2.34 not found"); } })), null);
});

test("no spec (Intel Mac, npm install) and malformed specs never touch the network", async (t) => {
  const s = await setup(t);
  assert.equal(await loadDownloadedIroh(null, s.deps()), null);
  for (const bad of [{ ...spec, file: "../evil.node" }, { ...spec, package: "iroh/../x" }, { ...spec, sha256: "abc" }, { ...spec, version: "1.2" }])
    assert.equal(await loadDownloadedIroh(bad, s.deps()), null);
  assert.deepEqual(s.urls, []);
});

test("the module directory follows XDG_DATA_HOME, then LOCALAPPDATA on Windows, then ~/.local/share", () => {
  assert.equal(irohDirectory({ XDG_DATA_HOME: "/x" }, "linux", "/h"), join("/x", "frely", "native", "iroh"));
  assert.equal(irohDirectory({ LOCALAPPDATA: "C:\\L" }, "win32", "C:\\h"), join("C:\\L", "frely", "native", "iroh"));
  assert.equal(irohDirectory({}, "linux", "/h"), join("/h", ".local", "share", "frely", "native", "iroh"));
});
