import { spawn } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const testOutput = ".test-dist";
const tscPath = join("node_modules", "typescript", "bin", "tsc");
let exitCode = 0;

try {
  await rm(testOutput, { force: true, recursive: true });
  exitCode = await run(process.execPath, [tscPath, "-p", "tsconfig.test.json"]);
  if (exitCode === 0) {
    const files = await testFiles(testOutput);
    exitCode = files.length === 0 ? 1 : await run(process.execPath, ["--test", ...files]);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  await rm(testOutput, { force: true, recursive: true });
}

process.exitCode = exitCode;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
  }
  return files.sort();
}
