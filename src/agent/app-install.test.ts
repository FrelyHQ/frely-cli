import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCapsule, verifyCapsuleIntegrity, type AppInstall } from "./app-install.js";

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const executable = platform === "win32" ? "pi-node.exe" : "pi-node";

async function capsule(t: test.TestContext, mutate: (manifest: Record<string, any>) => void = () => {}): Promise<AppInstall> {
  const root = await mkdtemp(join(tmpdir(), "frely-capsule-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files: Record<string, string> = { [executable]: "pi-node\n", "package.json": "{}\n" };
  const entries = [];
  for (const [path, content] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    await writeFile(join(root, path), content, { mode: path === executable ? 0o755 : 0o644 });
    entries.push({ path, type: "file", size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), executable: path === executable });
  }
  const manifest: Record<string, any> = {
    schemaVersion: 3,
    capsuleKind: "pi-node-executable",
    sourceCommit: "a".repeat(40),
    target: { id: `${platform}-x64`, platform, architecture: "x64", architectures: ["x64"] },
    versions: { piNode: "0.2.0", protocol: "0.2.0", piSdk: "0.84.3", bun: "1.4.0" },
    runtime: { executable, stdioArguments: ["stdio"], headlessArguments: ["headless"] },
    integrity: {
      algorithm: "sha256",
      manifestExcludedPath: "capsule-manifest.json",
      payloadFileCount: entries.length,
      payloadSize: entries.reduce((total, entry) => total + entry.size, 0),
      files: entries,
    },
  };
  mutate(manifest);
  await writeFile(join(root, "capsule-manifest.json"), JSON.stringify(manifest), "utf8");
  return { schemaVersion: 2, appVersion: "0.2.0", capsulePath: root, protocolVersion: 0, agentDir: join(root, "agent"), projectsFile: join(root, "projects.json") };
}

test("capsule facts launch the Pi Node executable in its headless role", async (t) => {
  const install = await capsule(t);
  const facts = await verifyCapsule(install);
  assert.equal(facts.executable, join(install.capsulePath, executable));
  assert.deepEqual(facts.headlessArguments, ["headless"]);
  await verifyCapsuleIntegrity(install);
});

test("capsule verification rejects the retired Node runtime capsule", async (t) => {
  const install = await capsule(t, (manifest) => {
    manifest.schemaVersion = 2;
    manifest.capsuleKind = "pi-node-runtime";
  });
  await assert.rejects(verifyCapsule(install), /capsule_invalid/);
});

test("capsule verification rejects a redirected executable or role", async (t) => {
  const outside = await capsule(t, (manifest) => {
    manifest.runtime.executable = "../node";
  });
  await assert.rejects(verifyCapsule(outside), /capsule_invalid/);
  const wrongHeadless = await capsule(t, (manifest) => {
    manifest.runtime.headlessArguments = ["stdio"];
  });
  await assert.rejects(verifyCapsule(wrongHeadless), /capsule_invalid/);
});

test("capsule integrity rejects tampered payload bytes", async (t) => {
  const install = await capsule(t);
  await writeFile(join(install.capsulePath, "package.json"), "{ }\n", "utf8");
  await assert.rejects(verifyCapsuleIntegrity(install), /capsule_integrity_failed/);
});
