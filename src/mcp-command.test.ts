import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeMcpArgs } from "./mcp-command.js";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("./index.js", import.meta.url));

test("device MCP accepts the documented short entry and explicit subcommands", () => {
  // A bare group has no action of its own and prints the usage.
  assert.deepEqual(normalizeMcpArgs(["mcp"]), ["mcp", "help"]);
  assert.deepEqual(normalizeMcpArgs(["mcp", "start", "--workspace", "/project with spaces", "--days", "90"]), ["mcp", "start", "--workspace", "/project with spaces", "--days", "90"]);
  assert.deepEqual(normalizeMcpArgs(["mcp", "start", "--json"]), ["mcp", "start", "--json"]);
  // Deprecated alias: `mcp url` behaves as `mcp start`.
  assert.deepEqual(normalizeMcpArgs(["mcp", "url", "--workspace", "/project", "--days", "90", "--json"]), ["mcp", "start", "--workspace", "/project", "--days", "90", "--json"]);
  assert.deepEqual(normalizeMcpArgs(["mcp", "status", "--json"]), ["mcp", "status", "--json"]);
  assert.throws(() => normalizeMcpArgs(["mcp", "stop", "--json"]), /Unsupported MCP option/);
  // A bare group stays bare; the CLI prints its subcommands instead of listing.
  assert.deepEqual(normalizeMcpArgs(["mcp", "workspace"]), ["mcp", "workspace"]);
  // Update bridge for Windows commands printed by 0.7.x.
  assert.deepEqual(normalizeMcpArgs(["mcp", "service", "start"]), ["mcp", "start", "--resume"]);
  for (const args of [
    ["mcp", "workspace", "list"],
    ["mcp", "workspace", "list", "--json"],
    ["mcp", "workspace", "add", "/project"],
    ["mcp", "stop"],
    ["mcp", "start"],
    ["mcp", "status"],
    ["mcp", "remove"],
    ["mcp", "stdio", "--workspace", "/project"],
    ["mcp", "serve", "--workspace", "/project", "--service-config-home", "/config", "--service-credential-store", "native"],
  ]) assert.deepEqual(normalizeMcpArgs(args), args);
});

test("MCP help works offline for the entry and subcommands", async () => {
  for (const args of [["mcp", "--help"], ["mcp", "remove", "--help"], ["mcp", "help"]]) {
    const result = await execute(process.execPath, [entry, ...args], {
      env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
    });
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /frely mcp start \[--workspace <path>\]/);
    assert.match(result.stdout, /frely doctor/);
    assert.match(result.stdout, /Claude Code/);
    assert.doesNotMatch(result.stdout, /frely provider share/);
  }
});

test("a bare workspace add means the current directory", () => {
  assert.deepEqual(normalizeMcpArgs(["mcp", "workspace", "add"]), ["mcp", "workspace", "add", "."]);
});

test("invalid MCP arguments fail before login, authorization, service installation or credential access", async () => {
  for (const args of [
    ["mcp", "--workspace"],
    ["mcp", "--json"],
    ["mcp", "start", "--workspace"],
    ["mcp", "url", "--workspace", "--days", "90"],
    ["mcp", "start", "--unknown", "synthetic-secret"],
    ["mcp", "url", "--days", "90", "--days", "365"],
    ["mcp", "setup"],
    ["mcp", "renew"],
    ["mcp", "revoke"],
    ["mcp", "stop", "--force"],
    ["mcp", "workspace", "--json"],
    ["mcp", "workspace", "list", "--verbose"],
    ["mcp", "workspace", "remove"],
    ["mcp", "typo"],
    ["mcp", "chatgpt"],
    ["mcp", "service"],
    ["mcp", "service", "uninstall"],
    ["mcp", "service", "unknown"],
  ]) {
    await assert.rejects(execute(process.execPath, [entry, ...args], {
      env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
    }), (error: unknown) => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /MCP|frely mcp/);
      assert.doesNotMatch(result.stderr, /synthetic-secret|not-a-url|intentionally-invalid/);
      return true;
    });
  }
});
