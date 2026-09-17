import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VERSION } from "./version.js";

const execute = promisify(execFile);
test("Agent help runs offline without authentication or credential-store access", async () => {
  const result = await execute(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "help", "--agent", "--json"], {
    env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
  });
  assert.equal(result.stderr, "");
  const help = JSON.parse(result.stdout) as { schemaVersion: string; cliVersion: string; commands: { id: string; usage: string }[] };
  assert.equal(help.schemaVersion, "frely.cli.agent-help.v1");
  assert.equal(help.cliVersion, VERSION);
  assert.ok(help.commands.some(command => command.id === "key.budget"));
  assert.ok(help.commands.some(command => command.id === "agent.invoke"));
  assert.equal(help.commands.find(command => command.id === "doctor")?.usage, "frely doctor [-v] [--json]");
  assert.ok(!help.commands.some(command => ["status", "mcp.status"].includes(command.id)));
  assert.ok(!help.commands.find(command => command.id === "mcp.service")?.usage.includes("status"));
  const ordinary = await execute(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "--help"]);
  assert.ok(ordinary.stdout.includes("frely help --agent --json"));
  assert.ok(ordinary.stdout.includes("frely key budget"));
});

test("key command argument failures are JSON and never echo unsupported secret arguments", async () => {
  try {
    await execute(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)), "key", "budget", "--api-key", "synthetic-argv-key", "--json"]);
    assert.fail("must reject unsupported credential input");
  } catch (error) {
    const result = error as Error & { stdout: string; stderr: string; code: number };
    assert.equal(result.code, 1);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.ok(!result.stdout.includes("synthetic-argv-key"));
  }
});
