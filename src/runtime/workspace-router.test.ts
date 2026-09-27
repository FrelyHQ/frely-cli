import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { Workspace } from "./workspace.js";
import { resolveWorkspace } from "./workspace-router.js";

test("resolveWorkspace: single workspace is backward compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-workspace-"));
  const workspace = await Workspace.open(root);
  const workspaces = new Map([[root, workspace]]);

  // Relative path should be preserved
  const result = resolveWorkspace(workspaces, "src/file.ts");
  assert.equal(result.workspace, workspace);
  assert.equal(result.relativeInput, "src/file.ts");

  // Dot should be preserved
  const dotResult = resolveWorkspace(workspaces, ".");
  assert.equal(dotResult.relativeInput, ".");

  // Absolute path should work and be converted to relative
  const absPath = join(root, "src/file.ts");
  const absResult = resolveWorkspace(workspaces, absPath);
  assert.equal(absResult.workspace, workspace);
  assert.equal(absResult.relativeInput, join("src", "file.ts"));
});

test("resolveWorkspace: multiple workspaces require absolute paths", async () => {
  const root1 = await mkdtemp(join(tmpdir(), "frely-workspace-1-"));
  const root2 = await mkdtemp(join(tmpdir(), "frely-workspace-2-"));
  const ws1 = await Workspace.open(root1);
  const ws2 = await Workspace.open(root2);
  const workspaces = new Map([
    [root1, ws1],
    [root2, ws2],
  ]);

  // Relative path should throw
  assert.throws(() => resolveWorkspace(workspaces, "src/file.ts"), /Multiple workspaces.*absolute path/i);

  // Dot should throw
  assert.throws(() => resolveWorkspace(workspaces, "."), /Multiple workspaces.*absolute path/i);
});

test("resolveWorkspace: routes absolute paths to correct workspace", async () => {
  const root1 = await mkdtemp(join(tmpdir(), "frely-workspace-1-"));
  const root2 = await mkdtemp(join(tmpdir(), "frely-workspace-2-"));
  const ws1 = await Workspace.open(root1);
  const ws2 = await Workspace.open(root2);
  const workspaces = new Map([
    [root1, ws1],
    [root2, ws2],
  ]);

  // Path in workspace 1
  const absPath1 = join(root1, "src/file.ts");
  const result1 = resolveWorkspace(workspaces, absPath1);
  assert.equal(result1.workspace, ws1);
  assert.equal(result1.relativeInput, join("src", "file.ts"));

  // Path in workspace 2
  const absPath2 = join(root2, "src/file.ts");
  const result2 = resolveWorkspace(workspaces, absPath2);
  assert.equal(result2.workspace, ws2);
  assert.equal(result2.relativeInput, join("src", "file.ts"));
});

test("resolveWorkspace: throws for path outside all workspaces", async () => {
  const root1 = await mkdtemp(join(tmpdir(), "frely-workspace-1-"));
  const root2 = await mkdtemp(join(tmpdir(), "frely-workspace-2-"));
  const ws1 = await Workspace.open(root1);
  const ws2 = await Workspace.open(root2);
  const workspaces = new Map([
    [root1, ws1],
    [root2, ws2],
  ]);

  const outsidePath = join(tmpdir(), "not-in-any-workspace.txt");
  assert.throws(() => resolveWorkspace(workspaces, outsidePath), /not inside any registered workspace/i);
});

test("resolveWorkspace: correctly computes relative paths for subdirectories", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-workspace-"));
  const ws = await Workspace.open(root);
  const workspaces = new Map([[root, ws]]);

  const deepPath = join(root, "a", "b", "c", "file.ts");
  const result = resolveWorkspace(workspaces, deepPath);
  assert.equal(result.relativeInput, join("a", "b", "c", "file.ts"));
});
