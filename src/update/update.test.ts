import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { VERSION } from "../version.js";
import { inspectInstallation, manualUpdateCommand } from "./installation.js";
import { compareVersions, latestRelease } from "./release.js";
import { acquireMaintenance, MaintenanceGate, serveMaintenance } from "./maintenance.js";
import { prepareStandalone, update, validateStandalone, type UpdateDependencies } from "./update.js";

const execFile = promisify(execFileCallback);
const NEW = "999.0.0";

test("detect npm custom prefix, refuse local links and source/temporary installations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frely-detect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const global = join(root, "custom prefix", "lib", "node_modules");
  const pkg = join(global, "frely-cli"), entry = join(pkg, "dist", "index.js");
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, ""); await writeFile(join(pkg, "package.json"), '{"name":"frely-cli"}');
  const options = { entry, standalone: false, find: async (name: string) => name === "npm" ? "/fake/npm" : undefined,
    run: async (_: string, args: string[]) => args[0] === "root" ? global : join(root, "custom prefix") };
  const result = await inspectInstallation(options);
  assert.equal(result.method, "npm"); assert.equal(result.prefix, join(root, "custom prefix"));
  await writeFile(join(pkg, ".git"), "gitdir: synthetic");
  assert.equal((await inspectInstallation(options)).method, "source");
  await rm(join(pkg, ".git"));
  assert.equal((await inspectInstallation({ ...options, run: async () => "/elsewhere" })).method, "unknown");
  if (process.platform !== "win32") {
    const other = join(root, "linked-global"); await mkdir(other);
    await symlink(pkg, join(other, "frely-cli"));
    assert.equal((await inspectInstallation({ ...options, run: async () => other })).method, "unknown");
  }
});

test("Bun ownership uses the global bin and registry dependency; source dependencies stay manual", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frely-bun-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "global", "node_modules", "frely-cli", "dist", "index.js");
  const bin = join(root, "bin");
  await mkdir(dirname(entry), { recursive: true }); await mkdir(bin);
  await writeFile(entry, ""); await writeFile(join(dirname(dirname(entry)), "package.json"), '{"name":"frely-cli"}');
  await writeFile(join(root, "global", "package.json"), '{"dependencies":{"frely-cli":"^0.6.2"}}');
  await symlink(entry, join(bin, "frely"));
  const options = { entry, standalone: false, find: async (name: string) => name === "bun" ? "/fake/bun" : undefined, run: async () => bin };
  assert.equal((await inspectInstallation(options)).method, "bun");
  await writeFile(join(root, "global", "package.json"), '{"dependencies":{"frely-cli":"file:/source"}}');
  assert.equal((await inspectInstallation(options)).method, "unknown");
});

test("release lookup pins stable official versions and never follows a metadata redirect", async () => {
  const install = { method: "standalone" as const, entry: "/frely", platform: "linux" as const };
  const request: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://api.github.com/repos/FrelyHQ/frely-cli/releases/latest");
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    return Response.json({ draft: false, prerelease: false, tag_name: "v1.2.3" });
  };
  assert.equal((await latestRelease(install, request, null)).baseUrl, "https://github.com/FrelyHQ/frely-cli/releases/download/v1.2.3");
  for (const tag of ["v1.2.3-rc.1", "v1.2.3/evil", "v01.2.3", "../bad"]) {
    await assert.rejects(latestRelease(install, async () => Response.json({ draft: false, prerelease: false, tag_name: tag }), null));
  }
  const npm = { method: "npm" as const, entry: "/frely", platform: "linux" as const, manager: "npm", prefix: "/p" };
  const packument = (latest: string, versions: string[]) => async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://registry.npmjs.org/frely-cli");
    assert.equal(new Headers(init?.headers).get("accept"), "application/vnd.npm.install-v1+json");
    return Response.json({ name: "frely-cli", "dist-tags": { latest }, versions: Object.fromEntries(versions.map((v) => [v, {}])) });
  };
  assert.equal((await latestRelease(npm, packument("1.2.3", ["1.2.2", "1.2.3"]))).version, "1.2.3");
  // A publish still processing on npm is not offered: the installer could not resolve it yet.
  await assert.rejects(latestRelease(npm, packument("1.2.3", ["1.2.2"])));
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3-rc.1"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
});

test("standalone preparation leaves original intact; replacement and recovery use prepared copies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "frely-replace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "frely"); await writeFile(entry, "old");
  const hash = createHash("sha256").update("new").digest("hex");
  const prepared = await prepareStandalone({ method: "standalone", entry, platform: "linux" }, { version: "1.2.3", baseUrl: "https://example.invalid" },
    async (url, path) => { await writeFile(path, url.endsWith(".sha256") ? `${hash}  frely\n` : "new"); }, async () => "1.2.3");
  assert.equal(await readFile(entry, "utf8"), "old");
  await prepared.apply(); assert.equal(await readFile(entry, "utf8"), "new");
  await prepared.restore(); assert.equal(await readFile(entry, "utf8"), "old");
  await prepared.cleanup();
  let executed = false;
  await assert.rejects(validateStandalone(entry, "0".repeat(64), "1.2.3", async () => { executed = true; return "1.2.3"; }), /checksum mismatch/);
  assert.equal(executed, false); assert.equal(await readFile(entry, "utf8"), "old");
});

test("private maintenance pauses new work, waits for inflight completion and resumes on disconnect", { skip: process.platform === "win32" }, async (t) => {
  // macOS AF_UNIX paths must stay short, even when the OS temp directory is long.
  const root = await mkdtemp("/tmp/frely-gate-");
  const gate = new MaintenanceGate(), path = join(root, "update.sock");
  const close = await serveMaintenance(gate, path);
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const finish = gate.enter();
  const pending = acquireMaintenance(process.pid, path);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => gate.enter(), /preparing an update/);
  finish();
  const release = await pending;
  assert.equal(gate.idle, true); release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  gate.enter()();
  const unregister = gate.registerProcesses(() => 1);
  await assert.rejects(acquireMaintenance(process.pid, path), /busy/);
  unregister();
  await new Promise((resolve) => setTimeout(resolve, 50));
  gate.enter()();
});

function fixture(active = true) {
  const calls: string[] = [];
  let version = VERSION, running = active;
  const installation = { method: "standalone" as const, entry: "/synthetic/frely", platform: "linux" as const };
  const d: UpdateDependencies = {
    inspectInstallation: async () => installation,
    latestRelease: async () => ({ version: NEW }),
    installedVersion: async () => version,
    serviceStatus: async () => ({ installed: true, active: running, platform: "linux", pid: running ? 123 : undefined } as Awaited<ReturnType<UpdateDependencies["serviceStatus"]>>),
    serviceCommand: async () => [installation.entry, "mcp", "serve"],
    stopMcpService: async () => { calls.push("stop"); running = false; return d.serviceStatus(); },
    startMcpService: async () => { calls.push("start"); running = true; return d.serviceStatus(); },
    readDeviceBinding: async () => null, readConnectionStatus: async () => null,
    acquireMaintenance: async () => { calls.push("drain"); return () => { calls.push("resume"); }; },
    prepareStandalone: async () => ({ apply: async () => { calls.push("apply"); version = NEW; }, restore: async () => { calls.push("restore"); version = VERSION; }, cleanup: async () => { calls.push("cleanup"); } }),
    installPackage: async () => { throw new Error("not used"); },
    lockInstallation: async () => { calls.push("lock"); return async () => { calls.push("unlock"); }; },
    pause: async () => {},
  };
  return { d, calls, installation };
}

test("update restores active service, preserves stopped service and does not mistake offline for install failure", async () => {
  for (const active of [false, true]) {
    const { d, calls } = fixture(active);
    const result = await update(() => {}, d);
    assert.equal(result.state, "updated");
    assert.equal(calls.includes("start"), active); assert.equal(calls.includes("stop"), active);
    assert.equal(calls.includes("restore"), false);
    assert.equal(calls.at(-1), "unlock");
  }
});

test("busy or mismatched service cancels before replacement or stop", async () => {
  for (const mismatch of [false, true]) {
    const { d, calls } = fixture();
    if (mismatch) d.serviceCommand = async () => ["/another/frely"];
    else d.acquireMaintenance = async () => { throw new Error("busy"); };
    await assert.rejects(update(() => {}, d), mismatch ? /does not match/ : /busy/);
    assert.equal(calls.includes("stop"), false); assert.equal(calls.includes("apply"), false);
  }
});

test("failed installation attempts recovery and restarts the original service", async () => {
  const { d, calls } = fixture();
  d.prepareStandalone = async () => ({ apply: async () => { throw new Error("install failed"); }, restore: async () => { calls.push("restore"); }, cleanup: async () => {} });
  await assert.rejects(update(() => {}, d), /Restored Frely/);
  assert.ok(calls.indexOf("restore") > calls.indexOf("stop"));
  assert.ok(calls.indexOf("start") > calls.indexOf("restore"));
  assert.equal(calls.at(-1), "unlock");
});

test("Windows update and current-version no-op never acquire a lock, install or stop a service", async () => {
  const f = fixture();
  f.d.inspectInstallation = async () => ({ ...f.installation, platform: "win32" });
  const result = await update(() => {}, f.d);
  assert.equal(result.state, "manual"); assert.match(result.message, /powershell -NoProfile/);
  assert.match(result.message, /install\.ps1/); assert.deepEqual(f.calls, []);
  const old = fixture(); old.d.latestRelease = async () => ({ version: VERSION });
  assert.equal((await update(() => {}, old.d)).state, "current"); assert.deepEqual(old.calls, []);
});

test("Windows package instructions preserve manager and prefix, escape paths, and restore only a running service", () => {
  const installation = { method: "npm" as const, entry: "C:\\odd'name\\node_modules\\frely-cli\\dist\\index.js", manager: "C:\\odd'name\\npm.cmd", prefix: "C:\\odd'name", platform: "win32" as const };
  const command = manualUpdateCommand(installation, "1.2.3", false);
  assert.match(command, /frely-cli@1\.2\.3/); assert.match(command, /--prefix/); assert.match(command, /--ignore-scripts/);
  assert.match(command, /--min-release-age-exclude=frely-cli/);
  assert.doesNotMatch(command, /mcp start/);
  // The restore step must only resume the service; a plain `mcp start` could open an approval prompt mid-update.
  assert.match(manualUpdateCommand(installation, "1.2.3", true), /finally \{[^}]*mcp start --resume \}/);
});

test("update accepts no switches and directs version checks to doctor", async () => {
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  for (const flag of ["--check", "--version", "--json"]) {
    await assert.rejects(execFile(process.execPath, [entry, "update", flag]), (error: unknown) => {
      const result = error as { stderr: string; code: number };
      return result.code === 1 && /frely doctor/.test(result.stderr);
    });
  }
});


test("service identity changes during preparation cancel before stop or install", async () => {
  const { d, calls } = fixture();
  let observations = 0;
  d.serviceStatus = async () => ({ installed: true, active: true, platform: "linux", pid: ++observations === 1 ? 123 : 456 });
  await assert.rejects(update(() => {}, d), /service changed/);
  assert.equal(calls.includes("stop"), false); assert.equal(calls.includes("apply"), false);
  assert.equal(calls.at(-1), "unlock");
});

test("standalone lookup prefers the mirror, falls back to GitHub, and download falls back as a whole", async (t) => {
  const install = { method: "standalone" as const, entry: "/frely", platform: "linux" as const };
  const mirror = "https://mirror.example/cli";
  const viaMirror = await latestRelease(install, async (url) => {
    assert.equal(String(url), `${mirror}/latest`);
    return new Response("1.2.3\n");
  }, mirror);
  assert.deepEqual(viaMirror, { version: "1.2.3", baseUrl: `${mirror}/v1.2.3`, fallbackBaseUrl: "https://github.com/FrelyHQ/frely-cli/releases/download/v1.2.3" });
  const viaGithub = await latestRelease(install, async (url) => String(url).startsWith(mirror)
    ? new Response("down", { status: 503 })
    : Response.json({ draft: false, prerelease: false, tag_name: "v1.2.4" }), mirror);
  assert.equal(viaGithub.version, "1.2.4");
  assert.match(viaGithub.baseUrl!, /^https:\/\/github\.com\//u);

  const root = await mkdtemp(join(tmpdir(), "frely-mirror-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "frely"); await writeFile(entry, "old");
  const hash = createHash("sha256").update("new").digest("hex");
  const seen: string[] = [];
  const prepared = await prepareStandalone({ method: "standalone", entry, platform: "linux" },
    { version: "1.2.3", baseUrl: `${mirror}/v1.2.3`, fallbackBaseUrl: "https://github.com/x/v1.2.3" },
    async (url, path) => {
      seen.push(url);
      if (url.startsWith(mirror) && !url.endsWith(".sha256")) throw new Error("mirror cut off");
      await writeFile(path, url.endsWith(".sha256") ? `${hash}  frely\n` : "new");
    }, async () => "1.2.3");
  assert.ok(seen.some((url) => url.startsWith(mirror)) && seen.some((url) => url.startsWith("https://github.com/")));
  await prepared.apply(); assert.equal(await readFile(entry, "utf8"), "new");
  await prepared.cleanup();
});
