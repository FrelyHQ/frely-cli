import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { capsuleTargetId, cliInstallPath, installCapsule, readAnyInstall } from "./capsule-install.js";

const archive = Buffer.from("fake archive");
const sha = createHash("sha256").update(archive).digest("hex");
const SOURCE = "a".repeat(40);

function fakeFetch(options: { checksum?: string; release?: boolean } = {}): typeof fetch {
  return (async (url: string) => {
    if (url.includes("/releases")) {
      const asset = (name: string) => ({ name, browser_download_url: `https://dl/${name}` });
      return new Response(JSON.stringify(options.release === false ? [] : [{ tag_name: "capsule/v1.0.0", assets: [asset("pi-node-capsule-linux-x64.tar.gz"), asset("pi-node-capsule-linux-x64.tar.gz.sha256")] }]));
    }
    return new Response(url.endsWith(".sha256") ? `${options.checksum ?? sha}  pi-node-capsule-linux-x64.tar.gz\n` : archive);
  }) as unknown as typeof fetch;
}

async function run(env: NodeJS.ProcessEnv, deps: Parameters<typeof installCapsule>[0] = {}) {
  const tar = async (args: string[]): Promise<string> => {
    if (args[0] === "-tzf") return "capsule-manifest.json\npi-node\n";
    const dest = args[args.indexOf("-C") + 1]!;
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "pi-node"), "bin", { mode: 0o755 });
    await writeFile(join(dest, "capsule-manifest.json"), JSON.stringify({ schemaVersion: 3, capsuleKind: "pi-node-executable", sourceCommit: SOURCE, target: { id: "x", platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux", architecture: "x64" }, versions: { piNode: "1", protocol: "1" }, runtime: { executable: "pi-node", headlessArguments: ["headless"] } }));
    return "";
  };
  return installCapsule({ env, target: "linux-x64", tar, verifyIntegrity: async () => undefined, fetchFn: fakeFetch(), ...deps });
}

test("installCapsule verifies the checksum, installs and records the capsule", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cap-"));
  const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
  try {
    const result = await run(env);
    assert.equal(result.changed, true);
    assert.equal(result.capsulePath, join(root, "frely", "pi-node", "capsules", SOURCE));
    const install = JSON.parse(await readFile(cliInstallPath(env), "utf8"));
    assert.equal(install.capsulePath, result.capsulePath);
    assert.equal((await readAnyInstall(env)).capsulePath, result.capsulePath);
    assert.equal((await run(env)).changed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installCapsule refuses a wrong checksum, an unsafe archive and a missing release", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cap-"));
  const env = { XDG_CONFIG_HOME: root } as NodeJS.ProcessEnv;
  try {
    await assert.rejects(run(env, { fetchFn: fakeFetch({ checksum: "0".repeat(64) }) }), /checksum/u);
    await assert.rejects(run(env, { tar: async () => "../evil\n" }), /unsafe path/u);
    await assert.rejects(run(env, { fetchFn: fakeFetch({ release: false }) }), /No Pi Node Capsule/u);
    await assert.rejects(readFile(cliInstallPath(env)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("capsuleTargetId rejects unsupported platforms", () => {
  assert.equal(capsuleTargetId("linux", "x64"), "linux-x64");
  assert.throws(() => capsuleTargetId("freebsd", "x64"));
});
