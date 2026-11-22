#!/usr/bin/env node
// Auth and connection-critical dependencies (scripts/critical-deps.json) are upgraded in their own PR and released alone:
// batch upgrades have silently broken login and connection paths. One diff module, two callers: the CI pull request check
// (`node scripts/critical-deps.mjs pr <base> <head>`) and the release admission in release-entry.mjs.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const criticalDeps = JSON.parse(readFileSync(resolve(root, "scripts/critical-deps.json"), "utf8"));
const SECTIONS = ["dependencies", "devDependencies", "overrides"];
const WORKFLOWS = ".github/workflows/";
const defaultGit = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const show = (git, ref, path) => { try { return git("show", `${ref}:${path}`); } catch { return ""; } };

// name -> serialized pins for one revision: package.json sections plus the Bun version pinned in the workflows.
export function dependencyPins(ref, git = defaultGit) {
  const pkg = JSON.parse(show(git, ref, "package.json") || "{}");
  const names = new Set(SECTIONS.flatMap(section => Object.keys(pkg[section] || {})));
  const pins = new Map([...names].map(name => [name, JSON.stringify(SECTIONS.map(section => pkg[section]?.[name] ?? null))]));
  const bun = new Set();
  for (const file of git("ls-tree", "--name-only", ref, WORKFLOWS).split("\n").filter(Boolean))
    for (const match of show(git, ref, file).matchAll(/bun-version:\s*["']?([^"'\s#]+)/g)) bun.add(match[1]);
  if (bun.size) pins.set("bun", [...bun].sort().join(","));
  return pins;
}
export function changedDeps(base, head, git = defaultGit) {
  const before = dependencyPins(base, git), after = dependencyPins(head, git);
  return [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).sort();
}
const split = changed => ({ critical: changed.filter(name => criticalDeps.includes(name)), other: changed.filter(name => !criticalDeps.includes(name)) });

export function assertPullRequestSplit(base, head, git = defaultGit) {
  const { critical, other } = split(changedDeps(base, head, git));
  if (critical.length && other.length) throw new Error(`Upgrade ${critical.join(", ")} in its own PR (also changed: ${other.join(", ")})`);
}

// Release admission: the range from the previous stable vX.Y.Z tag to the release source must not mix a critical upgrade with other commits.
export function assertReleaseRangeSplit(source, { currentTag = "", git = defaultGit } = {}) {
  const previous = git("tag", "--list", "v*", "--merged", source, "--sort=-v:refname").split("\n")
    .find(tag => /^v\d+\.\d+\.\d+$/.test(tag) && tag !== currentTag);
  if (!previous) return;
  const commits = git("rev-list", "--no-merges", "--format=%H %s", "--no-commit-header", `${previous}..${source}`).split("\n").filter(Boolean)
    .map(line => ({ sha: line.slice(0, 40), subject: line.slice(41) })).filter(commit => !/^release: v/.test(commit.subject));
  const touching = new Set(git("rev-list", "--no-merges", `${previous}..${source}`, "--", "package.json", WORKFLOWS).split("\n").filter(Boolean));
  const criticalCommits = new Map();
  for (const { sha } of commits) {
    if (!touching.has(sha)) continue;
    const critical = split(changedDeps(`${sha}^`, sha, git)).critical;
    if (critical.length) criticalCommits.set(sha, critical);
  }
  const names = [...new Set([...criticalCommits.values()].flat())].sort();
  const others = commits.filter(commit => !criticalCommits.has(commit.sha));
  if (names.length && others.length)
    throw new Error(`Release range ${previous}..${source.slice(0, 12)} upgrades ${names.join(", ")} together with ${others.length} other commit(s). ` +
      `Critical dependencies are released alone: release the other changes first (from the commit before the upgrade), then release the ${names.join(", ")} upgrade by itself.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, base, head] = process.argv.slice(2);
  try {
    if (mode !== "pr" || !base || !head) throw new Error("Usage: critical-deps.mjs pr <base> <head>");
    assertPullRequestSplit(base, head);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
