import assert from "node:assert/strict";
import { test } from "node:test";
import { bumpLevel, classifyCommit, nextVersion } from "./release-level.mjs";

test("commit types decide the level", () => {
  assert.equal(classifyCommit("feat: add a command"), "minor");
  assert.equal(classifyCommit("fix(item): a bug"), "patch");
  assert.equal(classifyCommit("refactor!: rename a flag"), "major");
  assert.equal(classifyCommit("fix: x\n\nBREAKING CHANGE: y"), "major");
  assert.equal(classifyCommit("Merge pull request #269 from a/b\n\nfeat: transfer_check"), "minor");
  assert.equal(classifyCommit("release: v0.35.0"), "ignore");
  assert.equal(classifyCommit("update stuff"), "minor");
});

test("the highest level in the range wins", () => {
  assert.equal(bumpLevel(["fix: a", "feat: b", "chore: c"]), "minor");
  assert.equal(bumpLevel(["fix: a", "release: v0.1.1"]), "patch");
  assert.equal(bumpLevel([]), "patch");
});

test("versions: minor on 0.x for breaking, major from 1.0", () => {
  assert.equal(nextVersion([0, 35, 0], "patch"), "0.35.1");
  assert.equal(nextVersion([0, 35, 4], "minor"), "0.36.0");
  assert.equal(nextVersion([0, 35, 4], "major"), "0.36.0");
  assert.equal(nextVersion([1, 2, 3], "major"), "2.0.0");
});
