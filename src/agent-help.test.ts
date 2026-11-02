import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { agentHelp, agentHelpView } from "./agent-help.js";
import { VERSION } from "./version.js";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("./index.js", import.meta.url));
test("Agent help runs offline without authentication or credential-store access", async () => {
  const result = await execute(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "help", "--agent", "--json"], {
    env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
  });
  assert.equal(result.stderr, "");
  const help = JSON.parse(result.stdout) as { schemaVersion: string; cliVersion: string; commands: { id: string; usage: string; effect: string; purpose: string }[] };
  assert.equal(help.schemaVersion, "frely.cli.agent-help.v1");
  assert.equal(help.cliVersion, VERSION);
  const mcp = help.commands.find(command => command.id === "link.on");
  assert.equal(mcp?.effect, "authorization-if-needed");
  assert.match(mcp!.purpose, /browser approval/);
  assert.ok(help.commands.some(command => command.id === "agent.run"));
  assert.ok(help.commands.some(command => command.id === "skill.install"));
  for (const removed of ["whoami", "key.budget", "agent.invoke", "mcp.renew", "mcp.revoke", "mcp.service", "provider.finalize"]) {
    assert.ok(!help.commands.some(command => command.id === removed), removed);
  }
  assert.equal(help.commands.find(command => command.id === "doctor")?.usage, "frely doctor [-v] [--json]");
  assert.ok(!help.commands.some(command => ["status"].includes(command.id)));
  const ordinary = await execute(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "--help"]);
  assert.ok(ordinary.stdout.includes("frely help --agent --json"));
  assert.ok(ordinary.stdout.includes("frely agent status"));
  for (const hidden of ["frely mcp serve", "frely mcp stdio", "frely network", "frely whoami", "frely key"]) assert.ok(!ordinary.stdout.includes(hidden), hidden);
});

test("agent status argument failures are JSON and never echo unsupported secret arguments", async () => {
  try {
    await execute(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "agent", "status", "--api-key", "synthetic-argv-key", "--json"]);
    assert.fail("must reject unsupported credential input");
  } catch (error) {
    const result = error as Error & { stdout: string; stderr: string; code: number };
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(!result.stdout.includes("synthetic-argv-key"));
  }
});

test("agent help lists the mcp workspace subcommands", () => {
  const ids = agentHelp().commands.map((command: { id: string }) => command.id);
  for (const id of ["link.workspace.list", "link.workspace.add", "link.workspace.remove", "link.local.list", "link.local.add", "link.local.remove"]) assert.ok(ids.includes(id));
  assert.ok(!ids.includes("link.workspace"));
});

test("command groups without a direct action print their subcommands offline", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["link"], /frely link on/],
    [["link", "workspace"], /frely link workspace list/],
    [["link", "local"], /frely link local list/],
    [["agent"], /frely agent install/],
    [["provider"], /frely provider list/],
    [["api"], /frely api list/],
    [["app"], /frely app status/],
  ];
  for (const [args, expected] of cases) {
    const result = await execute(process.execPath, [entry, ...args], {
      env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url", XDG_CONFIG_HOME: "/nonexistent-frely-test" },
    });
    assert.equal(result.stderr, "", args.join(" "));
    assert.match(result.stdout, expected, args.join(" "));
  }
});

test("agent help summary is a short grouped index without internal commands", async () => {
  const run = (...args: string[]) => execute(process.execPath, [entry, "help", "--agent", "--json", ...args], {
    env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
  });
  const full = (await run()).stdout;
  const summary = (await run("--summary")).stdout;
  assert.ok(summary.length < 9000, `summary is ${summary.length} chars`);
  assert.ok(summary.length < full.length / 2);
  const index = JSON.parse(summary) as { view: string; instructions: string[]; groups: { key: string; commands: string[] }[] };
  assert.equal(index.view, "summary");
  assert.ok(index.instructions.length > 0);
  const lines = index.groups.flatMap((group) => group.commands);
  assert.ok(lines.some((line) => line.startsWith("agent.run [remote-call] ")));
  for (const hidden of ["mcp.serve", "mcp.stdio", "computer.mcp", "network"]) assert.ok(!lines.some((line) => line.startsWith(`${hidden} `)), hidden);
  assert.ok(!index.groups.some((group) => group.key === "internal"));
  const all = JSON.parse((await run("--summary", "--all")).stdout) as { groups: { key: string; commands: string[] }[] };
  assert.ok(all.groups.flatMap((group) => group.commands).some((line) => line.startsWith("mcp.serve ")));
});

test("agent help by group or id returns full entries with examples", async () => {
  const run = (name: string) => execute(process.execPath, [entry, "help", "--agent", "--json", name], {
    env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
  });
  type Entry = { id: string; usage: string; group: string; examples?: string[]; confirm?: string };
  const agents = JSON.parse((await run("agent")).stdout) as { commands: Entry[] };
  assert.ok(agents.commands.length > 5 && agents.commands.every((command) => command.id.startsWith("agent.")));
  assert.ok(agents.commands.find((command) => command.id === "agent.run")?.examples?.length);
  const same = JSON.parse((await run("agents")).stdout) as { commands: Entry[] };
  assert.equal(same.commands.length, agents.commands.length);
  const one = JSON.parse((await run("api")).stdout) as { commands: Entry[] };
  assert.ok(one.commands.some((command) => command.id === "remote.call"), "the api group includes remote.*");
  assert.match(one.commands.find((command) => command.id === "api")?.confirm ?? "", /Credit/);
  await assert.rejects(run("nope"), (error: Error & { stdout: string; code: number }) => {
    assert.equal(error.code, 1);
    const body = JSON.parse(error.stdout) as { ok: boolean; known: string[] };
    assert.equal(body.ok, false);
    assert.ok(body.known.includes("agents"));
    return true;
  });
});

test("every agent help command belongs to a group and examples point at real commands", () => {
  for (const [name, id] of [["agents", "agent.run"], ["link", "link.on"], ["devices", "run"]] as const) {
    const result = agentHelpView({ name });
    assert.ok(result.ok);
    const commands = (result.value as { commands: { id: string; group: string; examples?: string[] }[] }).commands;
    assert.ok(commands.some((command) => command.id === id), `${name} lists ${id}`);
  }
  const internal = (agentHelpView({ name: "internal" }).value as { commands: { id: string }[] }).commands.map((command) => command.id).sort();
  assert.deepEqual(internal, ["computer.mcp", "mcp.serve", "mcp.stdio", "network"]);
  for (const id of ["login", "api", "agent.run", "item.install", "agent.install", "link.on", "permission", "share"]) {
    const entry = (agentHelpView({ name: id }).value as { commands: { id: string; examples?: string[] }[] }).commands.find((command) => command.id === id);
    assert.ok(entry?.examples?.length, `${id} has examples`);
    for (const example of entry!.examples!) assert.ok(/^(frely |printf .*\| frely )/u.test(example), `${id}: ${example}`);
  }
});
