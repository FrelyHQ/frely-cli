import assert from "node:assert/strict";
import { lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultWorkspacePath, ensureDefaultWorkspace } from "./default-workspace.js";

test("the default workspace is ~/Frely, not the home directory, and is created on demand", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-home-")));
  assert.equal(defaultWorkspacePath(home), join(home, "Frely"));
  await assert.rejects(lstat(join(home, "Frely")));
  const created = await ensureDefaultWorkspace(home);
  assert.equal(created, join(home, "Frely"));
  assert.ok((await lstat(created)).isDirectory());
  // Idempotent: an existing folder, with files in it, is reused untouched.
  await writeFile(join(created, "keep.txt"), "x");
  assert.equal(await ensureDefaultWorkspace(home), created);
  assert.ok((await lstat(join(created, "keep.txt"))).isFile());
});

test("a file named Frely in the home directory is an error, not silently replaced", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-home-")));
  await writeFile(join(home, "Frely"), "not a folder");
  await assert.rejects(ensureDefaultWorkspace(home));
});
