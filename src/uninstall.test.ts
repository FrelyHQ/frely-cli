import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runsInsideService, runUninstall, defaultDeps, type UninstallDeps, type UninstallIo } from "./uninstall.js";
import type { Installation } from "./update/installation.js";

const exists = (path: string) => stat(path).then(() => true, () => false);

async function fixture(overrides: Partial<UninstallDeps> = {}, withApp = false) {
  const home = await mkdtemp(join(tmpdir(), "frely-uninstall-"));
  const config = join(home, ".config", "frely");
  const bin = join(home, ".local", "bin");
  await mkdir(join(config, "basic-credentials-v1"), { recursive: true });
  await mkdir(join(config, "mcp-v1"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, ".local", "state", "frely"), { recursive: true });
  await writeFile(join(config, "config.json"), "{}");
  await writeFile(join(home, ".local", "state", "frely", "mcp.log"), "log");
  await writeFile(join(bin, "frely"), "binary");
  await writeFile(join(bin, ".frely-install.stale"), "x");
  await writeFile(join(bin, "other-tool"), "keep");
  if (withApp) await writeFile(join(config, "app.json"), "{}");
  const calls: string[] = [];
  const installation: Installation = { method: "standalone", entry: join(bin, "frely"), platform: "linux" };
  const deps: UninstallDeps = {
    ...defaultDeps(),
    platform: "linux", home, env: {}, pid: 4242,
    inspectInstallation: async () => installation,
    parentPid: async () => null,
    servicePid: async () => ({ installed: true, active: false }),
    isLoggedIn: async () => true,
    hasMcpAuthorization: async () => true,
    hasDeviceBinding: async () => true,
    revokeMcp: async () => { calls.push("revoke-mcp"); },
    revokeDevice: async () => { calls.push("revoke-device"); },
    logoutCloud: async () => { calls.push("logout-cloud"); },
    logoutNetwork: async () => { calls.push("logout-network"); },
    logout: async () => { calls.push("logout"); },
    uninstallService: async () => { calls.push("uninstall-service"); },
    localProviderNames: async () => [],
    removeAgent: async (id) => { calls.push(`agent:${id}`); },
    deleteVaultKey: async () => { calls.push("vault"); },
    piNodePid: async () => null,
    terminate: async (pid) => { calls.push(`terminate:${pid}`); },
    runPackageManager: async () => { calls.push("package-manager"); },
    spawnDetached: () => { calls.push("spawn"); },
    which: async () => [],
    ...overrides,
  };
  return { home, config, bin, calls, deps };
}

function io(options: { interactive?: boolean; answers?: string[] } = {}) {
  const output: string[] = [];
  const answers = [...(options.answers ?? [])];
  const value: UninstallIo = {
    write: (text) => { output.push(text); },
    interactive: options.interactive ?? false,
    ...(options.interactive ? { prompt: async () => answers.shift() ?? "" } : {}),
  };
  return { value, output };
}

test("without confirmation and without a terminal, uninstall only lists and changes nothing", async () => {
  const f = await fixture();
  const terminal = io();
  assert.equal(await runUninstall([], terminal.value, f.deps), 1);
  const text = terminal.output.join("");
  assert.match(text, /Revoke this device's Device MCP authorization/);
  assert.match(text, /Nothing was removed/);
  assert.deepEqual(f.calls, []);
  assert.ok(await exists(join(f.bin, "frely")));
  assert.ok(await exists(join(f.config, "config.json")));
});

test("--json without --yes prints the plan and does not run", async () => {
  const f = await fixture();
  const terminal = io({ interactive: true, answers: ["yes"] });
  assert.equal(await runUninstall(["--json"], terminal.value, f.deps), 1);
  const plan = JSON.parse(terminal.output.join("")) as { confirmed: boolean; plan: { steps: { id: string }[] } };
  assert.equal(plan.confirmed, false);
  assert.ok(plan.plan.steps.some((step) => step.id === "remove-program"));
  assert.deepEqual(f.calls, []);
});

test("a declined prompt removes nothing", async () => {
  const f = await fixture();
  const terminal = io({ interactive: true, answers: ["no"] });
  assert.equal(await runUninstall([], terminal.value, f.deps), 1);
  assert.deepEqual(f.calls, []);
  assert.ok(await exists(join(f.bin, "frely")));
});

test("--yes revokes the account side first, then removes service, data and the program last", async () => {
  const f = await fixture({}, false);
  const terminal = io();
  assert.equal(await runUninstall(["--yes"], terminal.value, f.deps), 0);
  assert.deepEqual(f.calls, ["revoke-mcp", "revoke-device", "logout-cloud", "logout-network", "logout", "uninstall-service"]);
  assert.equal(await exists(join(f.config)), false);
  assert.equal(await exists(join(f.home, ".local", "state", "frely")), false);
  assert.equal(await exists(join(f.bin, "frely")), false);
  assert.equal(await exists(join(f.bin, ".frely-install.stale")), false);
  assert.ok(await exists(join(f.bin, "other-tool")), "unrelated files in the install directory stay");
  assert.match(terminal.output.join(""), /Frely was uninstalled/);
});

test("the Frely App's app.json is kept and the rest of the config directory is removed", async () => {
  const f = await fixture({}, true);
  const terminal = io();
  assert.equal(await runUninstall(["--yes"], terminal.value, f.deps), 0);
  assert.deepEqual(await readdir(f.config), ["app.json"]);
  assert.match(terminal.output.join(""), /app\.json/);
});

test("the Pi Node left running by the service is stopped before the service is removed", async () => {
  const f = await fixture({ piNodePid: async () => 777 });
  await runUninstall(["--yes"], io().value, f.deps);
  assert.ok(f.calls.indexOf("terminate:777") >= 0 && f.calls.indexOf("terminate:777") < f.calls.indexOf("uninstall-service"));
});

test("a failed revocation with --yes continues locally, reports the residue and exits 1", async () => {
  const f = await fixture({ revokeMcp: async () => { throw new Error("offline"); } });
  const terminal = io();
  assert.equal(await runUninstall(["--yes"], terminal.value, f.deps), 1);
  const text = terminal.output.join("");
  assert.match(text, /FAILED .*Device MCP authorization: offline/);
  assert.match(text, /may still be active/);
  assert.equal(await exists(f.config), false, "local data is still deleted");
});

test("interactively, a failed revocation asks before deleting local files and can stop", async () => {
  const f = await fixture({ revokeMcp: async () => { throw new Error("offline"); } });
  const terminal = io({ interactive: true, answers: ["yes", "no"] });
  assert.equal(await runUninstall([], terminal.value, f.deps), 1);
  assert.ok(await exists(join(f.config, "config.json")), "credentials stay so revocation can be retried");
  assert.ok(await exists(join(f.bin, "frely")));
  assert.match(terminal.output.join(""), /skipped/);
});

test("a command running under the service refuses to uninstall and changes nothing", async () => {
  const parents = new Map([[4242, 4100], [4100, 900]]);
  const f = await fixture({ servicePid: async () => ({ installed: true, active: true, pid: 900 }), parentPid: async (pid) => parents.get(pid) ?? null });
  assert.equal(await runsInsideService(f.deps), true);
  await assert.rejects(() => runUninstall(["--yes"], io().value, f.deps), /Run it in a terminal on this computer/);
  assert.deepEqual(f.calls, []);
  assert.ok(await exists(join(f.bin, "frely")));
});

test("a terminal command beside a running service is allowed", async () => {
  const f = await fixture({ servicePid: async () => ({ installed: true, active: true, pid: 900 }), parentPid: async (pid) => (pid === 4242 ? 1 : null) });
  assert.equal(await runsInsideService(f.deps), false);
});

test("source, link and unrecognised installations are reported, never deleted", async () => {
  const f = await fixture({ inspectInstallation: async () => ({ method: "source", entry: "/checkout/dist/index.js", platform: "linux", reason: "Source checkout or local link." }) });
  const terminal = io();
  await runUninstall(["--yes"], terminal.value, f.deps);
  assert.match(terminal.output.join(""), /Not removed:[\s\S]*\/checkout\/dist\/index\.js/);
  assert.ok(await exists(join(f.bin, "frely")));
  assert.ok(!f.calls.includes("package-manager"));
});

test("npm and bun installations are removed with their own manager", async () => {
  const seen: string[][] = [];
  const f = await fixture({
    inspectInstallation: async () => ({ method: "npm", entry: "/prefix/lib/node_modules/frely-cli/dist/index.js", platform: "linux", manager: "/usr/bin/npm", prefix: "/prefix" }),
    runPackageManager: async (file, args) => { seen.push([file, ...args]); },
  });
  await runUninstall(["--yes"], io().value, f.deps);
  assert.deepEqual(seen, [["/usr/bin/npm", "uninstall", "--global", "--prefix", "/prefix", "frely-cli"]]);
});

test("on Windows the program is removed by a detached helper after this process exits", async () => {
  const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const f = await fixture({
    platform: "win32",
    inspectInstallation: async () => ({ method: "standalone", entry: "C:\\Users\\u\\AppData\\Local\\Frely\\bin\\frely.exe", platform: "win32" }),
    spawnDetached: (_file, args, env) => { spawned.push({ args, env }); },
  });
  const terminal = io();
  assert.equal(await runUninstall(["--yes"], terminal.value, f.deps), 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.env.FRELY_UNINSTALL_FILE, "C:\\Users\\u\\AppData\\Local\\Frely\\bin\\frely.exe");
  assert.equal(spawned[0]!.env.FRELY_UNINSTALL_PID, "4242");
  assert.ok(!spawned[0]!.args.join(" ").includes("frely.exe"), "paths travel in the environment, not the script text");
});

test("a failing credential-vault delete is reported but local files are still removed", async () => {
  const f = await fixture({ deleteVaultKey: async () => { throw new Error("locked"); } });
  await mkdir(join(f.config, "system-credentials-v1"), { recursive: true });
  const terminal = io();
  assert.equal(await runUninstall(["--yes"], terminal.value, f.deps), 1);
  assert.match(terminal.output.join(""), /frely-cli-vault/);
  assert.equal(await exists(join(f.config, "config.json")), false);
});

test("local Providers are called out as going offline", async () => {
  const f = await fixture({ localProviderNames: async () => ["Ollama: llama3"] });
  const terminal = io();
  await runUninstall([], terminal.value, f.deps);
  assert.match(terminal.output.join(""), /Ollama: llama3.*go offline/);
});

test("unknown arguments are rejected before anything is read", async () => {
  const f = await fixture();
  await assert.rejects(() => runUninstall(["--purge"], io().value, f.deps), /Usage: frely uninstall/);
  await rm(f.home, { recursive: true, force: true });
});
