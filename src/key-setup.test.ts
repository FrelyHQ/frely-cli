import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkedGatewayUrl, runKeyCommand, writeClaudeCodeSettings } from "./key-setup.js";

const RAW = "sk-secret-value-123";
const created = async () => ({ apiKey: { id: "key_1", prefix: "sk-secre" }, rawKey: RAW });

async function home(): Promise<string> { return mkdtemp(join(tmpdir(), "frely-key-setup-")); }

test("setup creates the key, writes Claude Code's settings (0600) and never prints the key", async () => {
  const dir = await home();
  const out: string[] = []; const calls: Array<[string, Record<string, unknown>]> = [];
  const code = await runKeyCommand(["setup", "claude-code"], { home: dir, hostName: "mbp", out: (t) => out.push(t), call: async (n, i) => { calls.push([n, i]); return created(); } });
  assert.equal(code, 0);
  assert.deepEqual(calls, [["keys.create", { name: "Claude Code on mbp" }]]);
  const file = join(dir, ".claude", "settings.json");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).env, { ANTHROPIC_BASE_URL: "https://api.frely.cloud", ANTHROPIC_AUTH_TOKEN: RAW });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!out.join("").includes(RAW));
});

test("--json prints ids and paths but not the key", async () => {
  const dir = await home(); const out: string[] = [];
  await runKeyCommand(["setup", "claude-code", "--json", "--name", "ci"], { home: dir, out: (t) => out.push(t), call: created });
  const printed = JSON.parse(out.join(""));
  assert.equal(printed.keyId, "key_1");
  assert.ok(!out.join("").includes(RAW));
});

test("other settings are kept, the old file is backed up, and a non-JSON file is refused untouched", async () => {
  const dir = await home();
  await mkdir(join(dir, ".claude"));
  const file = join(dir, ".claude", "settings.json");
  await writeFile(file, JSON.stringify({ permissions: { deny: ["x"] }, env: { KEEP: "1", ANTHROPIC_AUTH_TOKEN: "old" } }));
  const written = await writeClaudeCodeSettings({ home: dir, gatewayUrl: "https://api.frely.cloud", apiKey: RAW });
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.permissions, { deny: ["x"] });
  assert.deepEqual(saved.env, { KEEP: "1", ANTHROPIC_BASE_URL: "https://api.frely.cloud", ANTHROPIC_AUTH_TOKEN: RAW });
  assert.equal(JSON.parse(await readFile(written.backup!, "utf8")).env.ANTHROPIC_AUTH_TOKEN, "old");
  await writeFile(file, "{ nope");
  await assert.rejects(writeClaudeCodeSettings({ home: dir, gatewayUrl: "https://api.frely.cloud", apiKey: RAW }), /not a JSON object/);
  assert.equal(await readFile(file, "utf8"), "{ nope");
});

test("a write failure names the created key but not its value", async () => {
  const dir = await home();
  await mkdir(join(dir, ".claude"));
  await writeFile(join(dir, ".claude", "settings.json"), "[]");
  await assert.rejects(runKeyCommand(["setup", "claude-code"], { home: dir, out: () => undefined, call: created }), (error: Error) => /key_1/.test(error.message) && !error.message.includes(RAW));
});

test("only Frely's gateway may receive the key, and unknown agents or options are refused", async () => {
  assert.equal(checkedGatewayUrl("https://api.frely.cloud/"), "https://api.frely.cloud");
  assert.equal(checkedGatewayUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  for (const bad of ["https://evil.example", "https://frely.cloud.evil.example", "https://u:p@api.frely.cloud", "http://api.frely.cloud", "nope"]) assert.throws(() => checkedGatewayUrl(bad));
  const io = { out: () => undefined, call: created };
  await assert.rejects(runKeyCommand(["setup", "cursor"], io), /Unsupported agent/);
  await assert.rejects(runKeyCommand(["setup", "claude-code", "--bogus"], io), /Unknown option/);
  await assert.rejects(runKeyCommand(["setup", "claude-code", "--gateway", "https://evil.example"], io), /--gateway/);
});

test("an answer without a key writes nothing", async () => {
  const dir = await home();
  await assert.rejects(runKeyCommand(["setup", "claude-code"], { home: dir, out: () => undefined, call: async () => ({ apiKey: { id: "key_1" } }) }), /did not return a key/);
});

import { chmod } from "node:fs/promises";
import { withCodexBaseUrl, writeCodexSettings } from "./key-setup.js";

test("withCodexBaseUrl replaces the top-level line or inserts it before the first table", () => {
  assert.equal(withCodexBaseUrl("", "https://g/v1"), 'openai_base_url = "https://g/v1"\n');
  assert.equal(withCodexBaseUrl('model = "x"\n\n[mcp_servers.a]\nurl = "u"\n', "https://g/v1"), 'model = "x"\nopenai_base_url = "https://g/v1"\n\n[mcp_servers.a]\nurl = "u"\n');
  assert.equal(withCodexBaseUrl('openai_base_url = "old"\nmodel = "x"\n[t]\nopenai_base_url = "keep"\n', "https://g/v1"), 'openai_base_url = "https://g/v1"\nmodel = "x"\n[t]\nopenai_base_url = "keep"\n');
});

/** A stand-in `codex` on PATH: `login --with-api-key` writes stdin to $CODEX_HOME/auth.json, or fails when FAKE_CODEX_FAIL is set. */
async function fakeCodex(): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "frely-fake-codex-"));
  const file = join(bin, "codex");
  await writeFile(file, '#!/bin/sh\n[ -n "$FAKE_CODEX_FAIL" ] && exit 7\nread K\nprintf \'{"auth_mode":"apikey","OPENAI_API_KEY":"%s"}\' "$K" > "$CODEX_HOME/auth.json"\n');
  await chmod(file, 0o755);
  return bin;
}

test("codex setup sets the base URL, lets codex save the key, backs up config and login, and never prints the key", async () => {
  const bin = await fakeCodex(); const dir = await home();
  const saved = { path: process.env.PATH, home: process.env.CODEX_HOME };
  process.env.PATH = `${bin}:${saved.path}`; process.env.CODEX_HOME = join(dir, ".codex");
  try {
    await mkdir(join(dir, ".codex"));
    await writeFile(join(dir, ".codex", "config.toml"), 'model = "m"\n[mcp_servers.a]\nurl = "u"\n');
    await writeFile(join(dir, ".codex", "auth.json"), '{"auth_mode":"chatgpt"}');
    const out: string[] = [];
    assert.equal(await runKeyCommand(["setup", "codex"], { home: dir, out: (t) => out.push(t), call: created }), 0);
    assert.equal(await readFile(join(dir, ".codex", "config.toml"), "utf8"), 'model = "m"\nopenai_base_url = "https://api.frely.cloud/v1"\n\n[mcp_servers.a]\nurl = "u"\n');
    assert.equal(JSON.parse(await readFile(join(dir, ".codex", "auth.json"), "utf8")).OPENAI_API_KEY, RAW);
    assert.equal(await readFile(join(dir, ".codex", "auth.json.frely-backup"), "utf8"), '{"auth_mode":"chatgpt"}');
    assert.equal(await readFile(join(dir, ".codex", "config.toml.frely-backup"), "utf8"), 'model = "m"\n[mcp_servers.a]\nurl = "u"\n');
    assert.ok(!out.join("").includes(RAW));
  } finally { process.env.PATH = saved.path; if (saved.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.home; }
});

test("when codex cannot save the key the config is put back and the error names the created key", async () => {
  const bin = await fakeCodex(); const dir = await home();
  const saved = { path: process.env.PATH, home: process.env.CODEX_HOME };
  process.env.PATH = `${bin}:${saved.path}`; process.env.CODEX_HOME = join(dir, ".codex"); process.env.FAKE_CODEX_FAIL = "1";
  try {
    await mkdir(join(dir, ".codex"));
    await writeFile(join(dir, ".codex", "config.toml"), 'model = "m"\n');
    await assert.rejects(runKeyCommand(["setup", "codex"], { home: dir, out: () => undefined, call: created }), (error: Error) => /key_1/.test(error.message) && !error.message.includes(RAW));
    assert.equal(await readFile(join(dir, ".codex", "config.toml"), "utf8"), 'model = "m"\n');
  } finally { delete process.env.FAKE_CODEX_FAIL; process.env.PATH = saved.path; if (saved.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.home; }
});

test("codex setup without codex installed says so", async () => {
  const dir = await home();
  const savedPath = process.env.PATH; process.env.PATH = dir;
  try { await assert.rejects(writeCodexSettings({ home: dir, gatewayUrl: "https://api.frely.cloud", apiKey: RAW, codexHome: join(dir, ".codex") }), /Codex is not installed/); }
  finally { process.env.PATH = savedPath; }
});
