import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const executable = resolve(process.argv[2] ?? `artifacts/frely-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);
const directory = await mkdtemp(join(tmpdir(), "frely-standalone-smoke-"));
const run = promisify(execFile);
try {
  const env = { ...process.env, PATH: "", HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: join(directory, "config"),
    FRELY_CREDENTIAL_STORE: "invalid-for-basic-commands", FRELY_NO_BROWSER: "1" };
  delete env.FRELY_CREDENTIAL_KEY;
  delete env.BUN_OPTIONS; delete env.BUN_BE_BUN; delete env.NODE_OPTIONS;
  await writeFile(join(directory, ".env"), "FRELY_RELAY_URL=http://invalid-autoload.example\n");
  await writeFile(join(directory, "bunfig.toml"), 'preload = ["./must-not-load.js"]\n');
  const version = JSON.parse(await readFile("package.json", "utf8")).version;
  assert.equal((await run(executable, ["--version"], { env, cwd: directory, timeout: 10000 })).stdout.trim(), version);
  assert.match((await run(executable, ["--help"], { env, cwd: directory, timeout: 10000 })).stdout, /frely mcp/);
  const diagnostic = JSON.parse((await run(executable, ["doctor", "--json"], { env, cwd: directory, timeout: 10000 })).stdout);
  assert.equal(diagnostic.ok, true);
  assert.ok(diagnostic.checks.some((check) => check.name === "mcp" && check.ok && /not enabled/.test(check.detail)));
  const status = JSON.parse((await run(executable, ["mcp", "status", "--json"], { env, cwd: directory, timeout: 10000 })).stdout);
  assert.equal(status.configured, false);
  console.log(`Standalone smoke passed (${process.platform}/${process.arch}): no Node/npm/Bun on PATH, no keyring, no config autoload.`);
} finally { await rm(directory, { recursive: true, force: true }); }
