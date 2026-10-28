import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// The controller (this CLI as a controlling client) and the controlled side (runtime, device, share, provider)
// use separate credentials; this keeps their code from growing into each other.
const src = join(process.cwd(), "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(src, dir), { withFileTypes: true })) {
    const path = join(src, dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(join(dir, entry.name)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/gu)].map((m) => m[1]!);
}

function violations(from: string, forbidden: string[]): string[] {
  const found: string[] = [];
  for (const file of sources(from)) {
    for (const spec of imports(file)) {
      const target = relative(src, join(file, "..", spec)).split("\\").join("/");
      if (forbidden.some((dir) => target === dir || target.startsWith(`${dir}/`))) found.push(`${relative(src, file)} -> ${spec}`);
    }
  }
  return found;
}

test("src/controller does not import controlled-side code", () => {
  assert.deepEqual(violations("controller", ["runtime", "share", "provider"]), []);
});

test("controlled-side code does not import src/controller", () => {
  assert.deepEqual([...violations("runtime", ["controller"]), ...violations("device", ["controller"])], []);
});

test("controller credential identifiers stay out of runtime code", () => {
  const found: string[] = [];
  for (const file of [...sources("runtime"), ...sources("device")]) {
    if (/frely-cli-controller/u.test(readFileSync(file, "utf8"))) found.push(relative(src, file));
  }
  assert.deepEqual(found, []);
});

test("boundary directories exist", () => {
  for (const dir of ["controller", "runtime", "device", "share", "provider"]) assert.ok(statSync(join(src, dir)).isDirectory());
});
