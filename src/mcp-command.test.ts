import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeLinkArgs } from "./mcp-command.js";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("./index.js", import.meta.url));

test("link accepts the documented short entry and explicit subcommands", () => {
  // A bare group has no action of its own and prints the usage.
  assert.deepEqual(normalizeLinkArgs(["link"]), ["link", "help"]);
  assert.deepEqual(normalizeLinkArgs(["link", "on", "--workspace", "/project with spaces", "--days", "90"]), ["link", "on", "--workspace", "/project with spaces", "--days", "90"]);
  assert.deepEqual(normalizeLinkArgs(["link", "on", "--json"]), ["link", "on", "--json"]);
  assert.deepEqual(normalizeLinkArgs(["link", "status", "--json"]), ["link", "status", "--json"]);
  assert.throws(() => normalizeLinkArgs(["link", "stop", "--json"]), /Unsupported link option/);
  assert.throws(() => normalizeLinkArgs(["link", "off", "--json"]), /Unsupported link option/);
  assert.throws(() => normalizeLinkArgs(["link", "start"]), /Unknown link command/);
  // A bare group stays bare; the CLI prints its subcommands instead of listing.
  assert.deepEqual(normalizeLinkArgs(["link", "workspace"]), ["link", "workspace"]);
  for (const args of [
    ["link", "workspace", "list"],
    ["link", "workspace", "list", "--json"],
    ["link", "workspace", "add", "/project"],
    ["link", "stop"],
    ["link", "on"],
    ["link", "status"],
    ["link", "off"],
    ["mcp", "stdio", "--workspace", "/project"],
    ["mcp", "serve", "--workspace", "/project", "--service-config-home", "/config", "--service-credential-store", "native"],
    ["mcp", "serve", "--standby", "--service-config-home", "/config", "--service-credential-store", "native"],
  ]) assert.deepEqual(normalizeLinkArgs(args), args);
});

test("the old frely mcp commands are gone except the internal serve/stdio and the update bridge", () => {
  for (const args of [["mcp"], ["mcp", "start"], ["mcp", "url"], ["mcp", "status"], ["mcp", "remove"], ["mcp", "workspace", "list"], ["mcp", "local", "list"], ["mcp", "auto-update"], ["mcp", "help"]]) {
    assert.throws(() => normalizeLinkArgs(args), /frely link/, args.join(" "));
  }
  // Windows update commands printed by older CLIs still bring the service back.
  assert.deepEqual(normalizeLinkArgs(["mcp", "service", "start"]), ["link", "on", "--resume"]);
  assert.deepEqual(normalizeLinkArgs(["mcp", "start", "--resume"]), ["link", "on", "--resume"]);
  assert.deepEqual(normalizeLinkArgs(["mcp", "stop"]), ["link", "stop"]);
});

test("MCP help works offline for the entry and subcommands", async () => {
  for (const args of [["link", "--help"], ["link", "off", "--help"], ["link", "help"]]) {
    const result = await execute(process.execPath, [entry, ...args], {
      env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
    });
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /frely link on \[--workspace <path>\]/);
    assert.match(result.stdout, /frely doctor/);
    assert.match(result.stdout, /Claude Code/);
    assert.doesNotMatch(result.stdout, /frely provider share/);
  }
});

test("a bare workspace add means the current directory", () => {
  assert.deepEqual(normalizeLinkArgs(["link", "workspace", "add"]), ["link", "workspace", "add", "."]);
});

test("invalid MCP arguments fail before login, authorization, service installation or credential access", async () => {
  for (const args of [
    ["link", "--workspace"],
    ["link", "--json"],
    ["link", "on", "--workspace"],
    ["link", "start"],
    ["link", "on", "--unknown", "synthetic-secret"],
    ["link", "on", "--days", "90", "--days", "365"],
    ["link", "setup"],
    ["link", "renew"],
    ["link", "revoke"],
    ["link", "stop", "--force"],
    ["link", "off", "--force"],
    ["link", "workspace", "--json"],
    ["link", "workspace", "list", "--verbose"],
    ["link", "workspace", "remove"],
    ["link", "typo"],
    ["link", "service"],
    ["mcp", "start"],
    ["mcp", "remove"],
  ]) {
    await assert.rejects(execute(process.execPath, [entry, ...args], {
      env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
    }), (error: unknown) => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /frely link|option|command/i);
      assert.doesNotMatch(result.stderr, /synthetic-secret|not-a-url|intentionally-invalid/);
      return true;
    });
  }
});
