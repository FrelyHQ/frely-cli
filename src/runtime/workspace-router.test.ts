import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { Workspace } from "./workspace.js";
import { resolveWorkspace, resolveWorkspacePair } from "./workspace-router.js";

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

  // Absolute path is passed through untouched (single-workspace behavior is unchanged)
  const absPath = join(root, "src/file.ts");
  const absResult = resolveWorkspace(workspaces, absPath);
  assert.equal(absResult.workspace, workspace);
  assert.equal(absResult.relativeInput, absPath);
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

test("resolveWorkspace: with multiple workspaces computes the path relative to the matched root", async () => {
  const root = await mkdtemp(join(tmpdir(), "frely-workspace-"));
  const other = await mkdtemp(join(tmpdir(), "frely-workspace-other-"));
  const ws = await Workspace.open(root);
  const workspaces = new Map([[root, ws], [other, await Workspace.open(other)]]);

  const deepPath = join(root, "a", "b", "c", "file.ts");
  const result = resolveWorkspace(workspaces, deepPath);
  assert.equal(result.workspace, ws);
  assert.equal(result.relativeInput, join("a", "b", "c", "file.ts"));
});

test("resolveWorkspace: nested workspaces route to the deepest matching root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "frely-workspace-parent-"));
  const child = join(parent, "child");
  await mkdir(child);
  const parentWs = await Workspace.open(parent);
  const childWs = await Workspace.open(child);
  // Registration order must not matter: the parent comes first here.
  const workspaces = new Map([[parent, parentWs], [child, childWs]]);

  const inChild = resolveWorkspace(workspaces, join(child, "src", "a.ts"));
  assert.equal(inChild.workspace, childWs);
  assert.equal(inChild.relativeInput, join("src", "a.ts"));

  assert.equal(resolveWorkspace(workspaces, child).workspace, childWs);
  assert.equal(resolveWorkspace(workspaces, child).relativeInput, ".");

  const inParent = resolveWorkspace(workspaces, join(parent, "README.md"));
  assert.equal(inParent.workspace, parentWs);
  assert.equal(inParent.relativeInput, "README.md");

  // A sibling sharing the child's name prefix must not match the child.
  const sibling = resolveWorkspace(workspaces, join(parent, "child-2", "x"));
  assert.equal(sibling.workspace, parentWs);
});

test("resolveWorkspacePair: moves across a nested boundary use the deepest common root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "frely-workspace-pair-"));
  const child = join(parent, "child");
  await mkdir(child);
  const other = await mkdtemp(join(tmpdir(), "frely-workspace-pair-other-"));
  const parentWs = await Workspace.open(parent);
  const childWs = await Workspace.open(child);
  const workspaces = new Map([[parent, parentWs], [child, childWs], [other, await Workspace.open(other)]]);

  const within = resolveWorkspacePair(workspaces, join(child, "a"), join(child, "b"));
  assert.equal(within.workspace, childWs);
  assert.deepEqual([within.relativeFrom, within.relativeTo], ["a", "b"]);

  const across = resolveWorkspacePair(workspaces, join(child, "a"), join(parent, "b"));
  assert.equal(across.workspace, parentWs);
  assert.deepEqual([across.relativeFrom, across.relativeTo], [join("child", "a"), "b"]);

  assert.throws(() => resolveWorkspacePair(workspaces, join(child, "a"), join(other, "b")), /same workspace/);
});
