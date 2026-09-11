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
