import test from "node:test";
import assert from "node:assert/strict";
import { cliLaunchArguments } from "./cli-launch.js";
import { windowsArgument, windowsService } from "./service-windows.js";
import { startDetachedRelay, detachedRelayPid, stopDetachedRelay, systemdUnit, launchAgentPlist, serviceLaunchArguments, systemdUnitPath, parseServiceCommand, trimServiceLog } from "./service.js";
import { join } from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

test("standalone and npm services invoke the intended executable", () => {
  assert.deepEqual(cliLaunchArguments("/src/index.js", ["mcp", "serve"], true, "/bin/frely"), ["/bin/frely", "mcp", "serve"]);
  assert.deepEqual(cliLaunchArguments("/src/index.js", ["mcp", "serve"], false, "/bin/node"), ["/bin/node", "/src/index.js", "mcp", "serve"]);
});

test("service configuration escapes arguments and never includes an external master key", () => {
  const previous = { FRELY_CREDENTIAL_KEY: process.env.FRELY_CREDENTIAL_KEY, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.FRELY_CREDENTIAL_KEY = "a".repeat(64); process.env.XDG_CONFIG_HOME = "/synthetic/config";
  try {
    const command = serviceLaunchArguments("/synthetic/index.js", "/workspace/with % and $value");
    assert.equal(command.includes("a".repeat(64)), false);
    assert.equal(command.includes("encrypted-file"), true);
    assert.equal(systemdUnitPath(), join("/synthetic/config", "systemd", "user", "frely-mcp.service"));
    const unit = systemdUnit(command);
    assert.match(unit, /%% and \$\$value/);
    const plist = launchAgentPlist(["/bin/frely", "mcp", "serve", "--workspace", "/a&b<project>"], "/state");
    assert.match(plist, /a&amp;b&lt;project&gt;/);
    assert.throws(() => systemdUnit(["/bin/frely", "bad\nargument"]), /control characters/);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test("Windows task requests carry paths as stdin data, not PowerShell code", async () => {
  const path = 'C:\\Users\\synthetic\\odd & name\\frely.exe';
  const workspace = 'C:\\synthetic\\trailing\\';
  const result = await windowsService("install", [path, "mcp", "serve", "--workspace", workspace], async (file, args, stdin) => {
    assert.match(file, /WindowsPowerShell/);
    assert.equal(args.join(" ").includes(path), false);
    assert.equal(args.includes("-ExecutionPolicy"), false);
    const request = JSON.parse(stdin ?? "");
    assert.equal(request.executable, path);
    assert.equal(request.arguments, ['mcp', 'serve', '--workspace', workspace].map(windowsArgument).join(" "));
    return { code: 0, stdout: '{"installed":true,"active":true}', stderr: "" };
  });
  assert.deepEqual(result, { installed: true, active: true });
  assert.equal(windowsArgument('a"b'), '"a\\"b"');
  assert.throws(() => windowsArgument("bad\nargument"));
});


test("update reads the existing service command without changing escaped paths", () => {
  const command = ["/bin/node", '/odd path/quote"slash\\%$&<name>/index.js', "mcp", "serve", "--workspace", "/workspace"];
  assert.deepEqual(parseServiceCommand("darwin", launchAgentPlist(command, "/state")), command);
  assert.deepEqual(parseServiceCommand("linux", systemdUnit(command)), command);
  assert.equal(parseServiceCommand("linux", "ExecStart=/custom/unrecognized-format"), null);
});

test("a service log over the limit is trimmed to its tail, and launchd throttles restarts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-cli-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "mcp.log");
  await writeFile(path, `${"a".repeat(90)}${"b".repeat(10)}`);
  await trimServiceLog(path, 200, 10);
  assert.equal((await stat(path)).size, 100);
  await trimServiceLog(path, 50, 10);
  assert.equal(await readFile(path, "utf8"), "b".repeat(10));
  assert.match(launchAgentPlist(["/bin/frely"], "/state"), /<key>ThrottleInterval<\/key><integer>30<\/integer>/u);
});

test("without a systemd user manager the relay starts as a detached process and prints a crontab line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "frely-detached-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deps = { pidFile: join(directory, "mcp.pid"), logPath: join(directory, "state", "mcp.log"), settleMs: 0 };
  const running = new Set<number>();
  const calls: { file: string; args: readonly string[]; options: { detached?: boolean } }[] = [];
  const spawnFake = ((file: string, args: readonly string[], options: { detached?: boolean }) => {
    calls.push({ file, args, options }); running.add(4242);
    return { pid: 4242, on() {}, unref() {} };
  }) as unknown as typeof import("node:child_process").spawn;
  const alive = async (pid: number) => running.has(pid);
  const write = process.stderr.write.bind(process.stderr);
  let output = "";
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stderr.write;
  try {
    const command = ["/opt/my frely/frely", "mcp", "serve", "--workspace", "/w"];
    const info = await startDetachedRelay(command, { ...deps, spawn: spawnFake, alive });
    assert.deepEqual([info.active, info.detached, info.pid], [true, true, 4242]);
    assert.equal(calls[0]!.file, "/opt/my frely/frely");
    assert.equal(calls[0]!.options.detached, true);
    assert.equal(await readFile(deps.pidFile, "utf8"), "4242\n");
    assert.match(output, /will not restart after a reboot/);
    // The log path is quoted only when it needs it (Windows temp paths do), so compare the command part exactly.
    assert.ok(info.crontab?.startsWith("@reboot '/opt/my frely/frely' mcp serve --workspace /w >> ") && info.crontab.endsWith(" 2>&1") && info.crontab.includes(deps.logPath));
    assert.ok(output.includes(`${info.crontab}\n`));
    assert.equal(await detachedRelayPid({ ...deps, alive }), 4242);
    running.delete(4242);
    assert.equal(await detachedRelayPid({ ...deps, alive }), undefined);
    assert.equal(await stopDetachedRelay({ ...deps, alive }), false);
    await assert.rejects(startDetachedRelay(command, { ...deps, spawn: (() => ({ pid: 7, on() {}, unref() {} })) as unknown as typeof spawnFake, alive }), /exited right away/);
  } finally { process.stderr.write = write; }
});
