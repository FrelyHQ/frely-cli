import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this check through `npm run test:install`.");
const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "frely-install-smoke-"));
const prefix = join(directory, "prefix");
try {
  const packageInfo = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  for (const [name, value] of Object.entries(lock.packages)) {
    assert.equal(/(?:keytar|prebuild-install|node-addon-api)/u.test(name), false, `Unexpected native dependency: ${name}`);
    assert.notEqual(value.hasInstallScript, true, `Unexpected dependency lifecycle script: ${name}`);
  }
  await run(process.execPath, [npm, "pack", "--ignore-scripts", "--pack-destination", directory], { timeout: 60_000 });
  const tarball = (await readdir(directory)).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack must produce a tarball");
  await run(process.execPath, [npm, "install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(directory, tarball)], { timeout: 90_000 });
  const installed = process.platform === "win32" ? join(prefix, "node_modules", "frely-cli") : join(prefix, "lib", "node_modules", "frely-cli");
  const bin = process.platform === "win32" ? join(prefix, "frely.cmd") : join(prefix, "bin", "frely");
  assert.ok((await stat(bin)).isFile(), "global command wrapper must be installed");
  // Deliberately invalid credentials: startup must not initialize any backend.
  const env = { ...process.env, FRELY_CREDENTIAL_STORE: "unavailable-during-install", XDG_CONFIG_HOME: join(directory, "empty-config") };
  const entry = join(installed, "dist", "index.js");
  const version = await run(process.execPath, [entry, "--version"], { env, timeout: 10_000 });
  assert.ok(version.stdout.includes(packageInfo.version));
  const help = await run(process.execPath, [entry, "--help"], { env, timeout: 10_000 });
  assert.ok(help.stdout.includes("frely"));
  console.log(`Packed install passed (${process.platform}): global wrapper, --ignore-scripts, --version, --help, no credential backend.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
