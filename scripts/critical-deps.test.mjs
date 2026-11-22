// Real isolated Git history; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPullRequestSplit, assertReleaseRangeSplit, changedDeps } from "./critical-deps.mjs";

function repo(t) {
  const dir = mkdtempSync(join(tmpdir(), "frely-critical-deps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "T"); git("config", "user.email", "t@example.invalid");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  const state = { dependencies: { ws: "8.0.0", zod: "3.0.0" }, devDependencies: { typescript: "5.0.0" }, overrides: {} };
  let bun = "1.4.0";
  const write = () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify(state));
    writeFileSync(join(dir, ".github/workflows/a.yml"), `- uses: oven-sh/setup-bun@v2\n  with:\n    bun-version: ${bun}\n`);
  };
  const commit = (subject, change = () => {}) => { change(state); write(); writeFileSync(join(dir, "n"), subject); git("add", "."); git("commit", "-m", subject); return git("rev-parse", "HEAD"); };
  return { git, commit, setBun: v => { bun = v; } };
}

test("pull request check flags a critical upgrade mixed with another dependency", t => {
  const r = repo(t);
  const base = r.commit("base");
  const mixed = r.commit("mixed", s => { s.dependencies.ws = "8.1.0"; s.devDependencies.typescript = "5.1.0"; });
  assert.deepEqual(changedDeps(base, mixed, r.git), ["typescript", "ws"]);
  assert.throws(() => assertPullRequestSplit(base, mixed, r.git), /Upgrade ws in its own PR/);
});

test("pull request check allows critical-only, non-critical-only and a pinned Bun change on its own", t => {
  const r = repo(t);
  const base = r.commit("base");
  const critical = r.commit("ws", s => { s.dependencies.ws = "8.1.0"; });
  assertPullRequestSplit(base, critical, r.git);
  const other = r.commit("zod", s => { s.dependencies.zod = "3.1.0"; });
  assertPullRequestSplit(critical, other, r.git);
  r.setBun("1.5.0");
  const bun = r.commit("bun");
  assert.deepEqual(changedDeps(other, bun, r.git), ["bun"]);
  assertPullRequestSplit(other, bun, r.git);
  const mixed = r.commit("bun and zod", s => { s.dependencies.zod = "3.2.0"; r.setBun("1.6.0"); });
  assert.throws(() => assertPullRequestSplit(bun, mixed, r.git), /Upgrade bun in its own PR/);
});

test("pull request check sees overrides", t => {
  const r = repo(t);
  const base = r.commit("base");
  const head = r.commit("override", s => { s.overrides.ws = "8.2.0"; });
  assert.deepEqual(changedDeps(base, head, r.git), ["ws"]);
});

test("release range refuses a critical upgrade together with other commits and explains the split", t => {
  const r = repo(t);
  r.commit("base"); r.git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
  r.commit("feature", () => {});
  r.commit("ws", s => { s.dependencies.ws = "8.1.0"; });
  const source = r.commit("release: v1.0.1");
  assert.throws(() => assertReleaseRangeSplit(source, { git: r.git }), /upgrades ws together with 1 other commit\(s\).*release the other changes first/);
});

test("release range allows a critical upgrade alone (plus the release commit) and ranges without one", t => {
  const r = repo(t);
  r.commit("base"); r.git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
  r.commit("ws", s => { s.dependencies.ws = "8.1.0"; });
  assertReleaseRangeSplit(r.commit("release: v1.0.1"), { git: r.git });
  r.git("tag", "-a", "v1.0.1", "-m", "v1.0.1");
  r.commit("feature a"); r.commit("feature b", s => { s.dependencies.zod = "3.1.0"; });
  assertReleaseRangeSplit(r.commit("release: v1.0.2"), { currentTag: "v1.0.2", git: r.git });
});

test("release range without a previous release tag is not checked", t => {
  const r = repo(t);
  r.commit("base"); r.commit("ws", s => { s.dependencies.ws = "8.1.0"; });
  assertReleaseRangeSplit(r.commit("feature"), { git: r.git });
});
