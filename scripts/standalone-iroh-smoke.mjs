// A bun-compiled executable must be able to load iroh's native module from a file on disk (process.dlopen), because the single-file
// build downloads that module on first use instead of embedding it. Compiles a tiny program for this machine and loads the module
// the dependency install placed in node_modules. Runs on every OS the standalone workflow covers.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const scope = join("node_modules", "@number0");
let module_;
for (const entry of await readdir(scope).catch(() => [])) {
  if (!entry.startsWith("iroh-")) continue;
  const file = (await readdir(join(scope, entry))).find((name) => name.endsWith(".node"));
  if (file) { module_ = join(process.cwd(), scope, entry, file); break; }
}
if (!module_) { console.log("No iroh native module installed for this platform; skipping."); process.exit(0); }
const directory = await mkdtemp(join(tmpdir(), "frely-iroh-dlopen-"));
try {
  const source = join(directory, "probe.mjs"), output = join(directory, process.platform === "win32" ? "probe.exe" : "probe");
  await writeFile(source, `const holder = { exports: {} };
process.dlopen(holder, process.argv[2]);
const key = holder.exports.SecretKey.generate();
console.log(typeof key.public().toString() === "string" ? "dlopen-ok" : "dlopen-bad");
`);
  await run("bun", ["build", source, "--compile", "--outfile", output], { timeout: 120000 });
  // bun's compiled darwin executables carry an invalid ad-hoc signature that Apple Silicon kills; build-standalone.mjs re-signs the real ones.
  if (process.platform === "darwin") await run("codesign", ["--force", "--sign", "-", output]);
  const { stdout } = await run(output, [module_], { timeout: 30000 });
  assert.equal(stdout.trim(), "dlopen-ok");
  console.log(`Compiled executable loaded the iroh native module from disk (${process.platform}/${process.arch}).`);
} finally { await rm(directory, { recursive: true, force: true }); }
