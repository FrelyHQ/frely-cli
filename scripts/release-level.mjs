#!/usr/bin/env node
// Decides the next version for the auto release from the commit types since the latest release tag, by the same semver rule
// as friday-relay's scripts/release-auto-plan.mjs: BREAKING CHANGE / "!:" -> major (minor while on 0.x, until 1.0.0 is declared),
// feat -> minor, known non-feature types -> patch, and an unrecognised commit counts as minor (when unsure, the higher level).
// Commits are the first-parent line of main, so the PR title decides for merge and squash alike.
import { execFileSync } from "node:child_process";

export const PATCH_TYPES = ["fix", "chore", "docs", "test", "tests", "refactor", "perf", "build", "ci", "deps", "style", "revert"];
const IGNORED_SUBJECT = /^(Merge (branch|remote-tracking branch)\b|release: v)/u;

// One first-parent commit -> "major" | "minor" | "patch" | "ignore".
export function classifyCommit(message) {
  const lines = message.split("\n");
  let subject = lines[0].trim();
  if (/^Merge pull request #\d+/u.test(subject)) subject = lines.slice(1).find(line => line.trim())?.trim() ?? "";
  if (/^BREAKING CHANGE/mu.test(message) || /^[a-z]+(\([^)]*\))?!:/u.test(subject)) return "major";
  if (IGNORED_SUBJECT.test(subject)) return "ignore";
  const type = /^([a-z]+)(\([^)]*\))?:/u.exec(subject)?.[1];
  if (type === "feat") return "minor";
  if (type && PATCH_TYPES.includes(type)) return "patch";
  return "minor";
}

export function bumpLevel(messages) {
  const rank = { ignore: 0, patch: 1, minor: 2, major: 3 };
  let level = "patch";
  for (const message of messages) {
    const next = classifyCommit(message);
    if (rank[next] > rank[level]) level = next;
  }
  return level;
}

// Before 1.0.0 a breaking change bumps minor, not major; 1.0.0 is declared by hand.
export function nextVersion([major, minor, patch], level) {
  if (level === "major" && major > 0) return `${major + 1}.0.0`;
  if (level === "major" || level === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function main(tag) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const messages = git("log", "--first-parent", "--format=%B%x00", `${tag}..HEAD`).split("\0").map(m => m.trim()).filter(Boolean);
  const level = bumpLevel(messages);
  const version = nextVersion(tag.replace(/^v/u, "").split(".").map(Number), level);
  process.stdout.write(`${version}\n`);
  process.stderr.write(`level=${level} since ${tag}\n`);
}

if (import.meta.main) {
  try { main(process.argv[2] ?? ""); } catch (error) { process.stderr.write((error instanceof Error ? error.message : "Release level failed") + "\n"); process.exitCode = 1; }
}
