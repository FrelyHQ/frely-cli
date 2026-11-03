import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./workspace.js";

test("workspace file lifecycle and stale patch protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-workspace-"));
  const workspace = await Workspace.open(root);
  await workspace.createDirectory("src");
  await workspace.writeFile("src/a.txt", "one\ntwo\nthree\n", false);
  assert.equal((await workspace.readFileLines("src/a.txt", 2, 3)).content, "two\nthree");
  const original = await readFile(join(root, "src/a.txt"), "utf8");
  const hash = createHash("sha256").update(original).digest("hex");
  await workspace.applyPatch("src/a.txt", [{ startLine: 2, endLine: 2, replacement: "TWO" }], hash);
  assert.match(await workspace.readFile("src/a.txt"), /TWO/);
  await assert.rejects(() => workspace.applyPatch("src/a.txt", [{ startLine: 1, endLine: 1, replacement: "ONE" }], hash), /changed/);
});

test("workspace rejects symlink escape for reads and writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "frely-cli-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root, "escape"));
  const workspace = await Workspace.open(root);
  await assert.rejects(() => workspace.readFile("escape/secret.txt"), /escapes workspace|Symbolic links/);
  await assert.rejects(() => workspace.writeFile("escape/new.txt", "bad", false), /escapes workspace/);
});

test("find and search skip node_modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-workspace-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "src/main.ts"), "const marker = 'needle';\n");
  await writeFile(join(root, "node_modules/pkg/hidden.ts"), "needle\n");
  const workspace = await Workspace.open(root);
  assert.deepEqual(await workspace.findFiles(".", "*.ts", 10), ["src/main.ts"]);
  const results = await workspace.searchFiles(".", "needle", { regex: false, caseSensitive: false, maxResults: 10, contextLines: 0 });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.path, "src/main.ts");
});

test("search gives the same hits with ripgrep and with the fallback walk", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-workspace-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, ".github"), { recursive: true });
  await writeFile(join(root, "src/a.ts"), "one\nNeedle here\nthree\n");
  await writeFile(join(root, ".github/ci.yml"), "needle: true\n");
  await writeFile(join(root, "src/bin.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0, 1]));
  const workspace = await Workspace.open(root);
  const run = () => workspace.searchFiles(".", "needle", { regex: false, caseSensitive: false, maxResults: 10, contextLines: 1 });
  const fast = await run();
  process.env.FRELY_DISABLE_RIPGREP = "1";
  try {
    const slow = await run();
    const key = (hits: typeof fast) => hits.map((hit) => JSON.stringify(hit)).sort();
    assert.deepEqual(key(fast), key(slow));
  } finally {
    delete process.env.FRELY_DISABLE_RIPGREP;
  }
  assert.deepEqual(fast.find((hit) => hit.path === "src/a.ts"), { path: "src/a.ts", line: 2, text: "Needle here", before: ["one"], after: ["three"] });
  assert.ok(fast.some((hit) => hit.path === ".github/ci.yml"));
  assert.ok(!fast.some((hit) => hit.path === "src/bin.dat"));
});

test("a pattern ripgrep cannot parse falls back to JavaScript regex", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-workspace-"));
  await writeFile(join(root, "a.txt"), "foobar\nfoobaz\n");
  const workspace = await Workspace.open(root);
  const hits = await workspace.searchFiles(".", "foo(?=bar)", { regex: true, caseSensitive: true, maxResults: 10, contextLines: 0 });
  assert.deepEqual(hits.map((hit) => hit.line), [1]);
});

test("findDefinition matches declarations across languages and not plain calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-cli-workspace-"));
  await writeFile(join(root, "a.ts"), "export async function load() {}\nconst x = load();\nclass Store {\n  async load(id: string): Promise<void> {\n  }\n}\nexport const load2 = 1;\n");
  await writeFile(join(root, "b.py"), "def load(self):\n    pass\nload()\n");
  await writeFile(join(root, "c.go"), "func (s *Store) load() error {\n}\n");
  await writeFile(join(root, "d.rs"), "pub fn load() {}\n");
  const workspace = await Workspace.open(root);
  const hits = await workspace.findDefinition(".", "load", { maxResults: 20, contextLines: 0 });
  assert.deepEqual(hits.map((hit) => `${hit.path}:${hit.line}`).sort(), ["a.ts:1", "a.ts:4", "b.py:1", "c.go:1", "d.rs:1"]);
  await assert.rejects(() => workspace.findDefinition(".", "a.b", { maxResults: 5, contextLines: 0 }), /identifier/);
});
