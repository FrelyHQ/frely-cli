import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { agentHelp } from "./agent-help.js";
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
  const mcp = help.commands.find(command => command.id === "mcp.url");
  assert.equal(mcp?.effect, "authorization-if-needed");
  assert.match(mcp!.purpose, /browser approval/);
  assert.ok(help.commands.some(command => command.id === "agent.run"));
  for (const removed of ["whoami", "key.budget", "skill.install", "agent.invoke", "mcp.renew", "mcp.revoke", "mcp.service", "provider.finalize"]) {
    assert.ok(!help.commands.some(command => command.id === removed), removed);
  }
  assert.equal(help.commands.find(command => command.id === "doctor")?.usage, "frely doctor [-v] [--json]");
  assert.ok(!help.commands.some(command => ["status", "mcp.status"].includes(command.id)));
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
  for (const id of ["mcp.workspace.list", "mcp.workspace.add", "mcp.workspace.remove"]) assert.ok(ids.includes(id));
  assert.ok(!ids.includes("mcp.workspace"));
});

test("command groups without a direct action print their subcommands offline", async () => {
  const cases: Array<[string[], RegExp]> = [
    [["mcp"], /frely mcp url/],
    [["mcp", "workspace"], /frely mcp workspace list/],
    [["agent"], /frely agent install/],
    [["provider"], /frely provider list/],
    [["cloud"], /frely cloud list/],
    [["app"], /frely app status/],
    [["app", "remote"], /frely app remote enable/],
  ];
  for (const [args, expected] of cases) {
    const result = await execute(process.execPath, [entry, ...args], {
      env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url", XDG_CONFIG_HOME: "/nonexistent-frely-test" },
    });
    assert.equal(result.stderr, "", args.join(" "));
    assert.match(result.stdout, expected, args.join(" "));
  }
});
