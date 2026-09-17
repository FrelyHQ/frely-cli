import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { normalizeMcpArgs } from "./mcp-command.js";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("./index.js", import.meta.url));

test("device MCP accepts the documented short entry and preserves explicit and compatibility commands", () => {
  assert.deepEqual(normalizeMcpArgs(["mcp"]), ["mcp", "setup"]);
  assert.deepEqual(normalizeMcpArgs(["mcp", "--workspace", "/project with spaces", "--days", "90"]), ["mcp", "setup", "--workspace", "/project with spaces", "--days", "90"]);
  for (const args of [
    ["mcp", "setup", "--workspace", "/project"],
    ["mcp", "url", "--json"],
    ["mcp", "chatgpt"],
    ["mcp", "renew", "--days", "180"],
    ["mcp", "service", "status", "--json"],
    ["mcp", "serve", "--workspace", "/project", "--service-config-home", "/config", "--service-credential-store", "native"],
  ]) assert.deepEqual(normalizeMcpArgs(args), args);
});

test("MCP help works offline for the entry and subcommands", async () => {
  for (const args of [["mcp", "--help"], ["mcp", "renew", "--help"], ["mcp", "help"]]) {
    const result = await execute(process.execPath, [entry, ...args], {
      env: { ...process.env, FRELY_CREDENTIAL_STORE: "intentionally-invalid", FRELY_RELAY_URL: "not-a-url" },
    });
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /frely mcp \[--workspace <path>\]/);
    assert.match(result.stdout, /frely doctor/);
    assert.match(result.stdout, /Claude Code/);
    assert.doesNotMatch(result.stdout, /frely provider share/);
  }
});

test("invalid MCP arguments fail before login, authorization, service installation or credential access", async () => {
  for (const args of [
    ["mcp", "--workspace"],
    ["mcp", "--workspace", "--days", "90"],
    ["mcp", "--unknown", "synthetic-secret"],
    ["mcp", "url", "--workspace", "/unexpected"],
    ["mcp", "setup", "--days", "90", "--days", "180"],
    ["mcp", "typo"],
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
