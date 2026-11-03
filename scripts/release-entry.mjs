#!/usr/bin/env node
// Local command entry and tag admission. Deployment remains owned by each
// project's existing executor; this module never accepts hosts or commands.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, appendFileSync, realpathSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalog } from "./release-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const run = (command, args, capture = false) => execFileSync(command, args, {
  cwd: root, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
});
const git = (...args) => run("git", args, true).trim();
function fail(message) { throw new Error(message); }
// Set in the background child of `--detach`; its output goes to this log, which ends with a RELEASE_EXIT line.
const DETACHED_LOG_ENV = "FRELY_CLI_RELEASE_DETACHED_LOG";
// The background child runs this file directly, so the artifact the wrapper script chose (release-landing, ...) travels in the environment.
const DETACHED_ARTIFACT_ENV = "FRELY_CLI_RELEASE_DETACHED_ARTIFACT";

export function parseArguments(args) {
  const options = {};
  const flags = new Set(["dry-run", "purge-cache", "no-wait", "help", "list", "detach"]);
  const values = new Set(["executor", "version", "validate-tag"]);
  for (let i = 0; i < args.length; i++) {
    const key = args[i] === "-h" ? "help" : args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") && args[i] !== "-h") fail("Unexpected argument: " + args[i]);
    if (Object.hasOwn(options, key)) fail("Duplicate option: " + key);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && args[i + 1] && !args[i + 1].startsWith("--")) options[key] = args[++i];
    else fail("Unknown option or missing value: " + args[i]);
  }
  if (options.version && !semver.test(options.version)) fail("Version must be SemVer without build metadata");
  if (options["validate-tag"] &&
      ["executor", "version", "purge-cache", "no-wait", "dry-run"].some(k => options[k] !== undefined)) {
    fail("Tag input determines artifact, version and executor; overrides are forbidden");
  }
  return options;
}
export function selectTag(tag) {
  const artifact = catalog.artifacts.find(item => tag.startsWith(item.tagPrefix));
  const version = artifact && tag.slice(artifact.tagPrefix.length);
  if (!artifact || !semver.test(version)) fail("Unsupported release tag: " + tag);
  return { artifact, version };
}
function help(entryArtifact) {
  const command = entryArtifact === catalog.defaultArtifact ? "./scripts/release" : "./scripts/release-" + entryArtifact;
  console.log("Usage: " + command + " [--executor local|actions] [--version <semver>] [--dry-run] [--detach]");
  console.log("       ./scripts/release --list");
  console.log("       ./scripts/release --validate-tag <tag>");
  console.log("Command\tDefault executor\tActions tag\tContents");
  for (const item of catalog.artifacts) console.log([item.id === catalog.defaultArtifact ? "./scripts/release" : "./scripts/release-" + item.id, item.defaultExecutor, item.tagPrefix + "X.Y.Z", item.description].join("\t"));
  console.log("Command invocation and execution location are separate. The CLI defaults to full local publishing; --executor actions submits tags to Actions, Landing submits tags to Actions.");
}
// Runs this command again in its own session with output in a log file and returns at once. A release started from a
// remote tool (FrelyMCP) otherwise dies when that tool disconnects, for example when a Frely release restarts the Device Relay.
export function detachRelease(args, entryArtifact = catalog.defaultArtifact, { log = join(tmpdir(), `frely-cli-release-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`), environment = process.env } = {}) {
  const descriptor = openSync(log, "a");
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args.filter(arg => arg !== "--detach")], {
      cwd: process.cwd(), detached: true, stdio: ["ignore", descriptor, descriptor],
      env: { ...environment, [DETACHED_LOG_ENV]: log, [DETACHED_ARTIFACT_ENV]: entryArtifact },
    });
    child.unref();
    console.log(`Release running in the background (pid ${child.pid}).`);
    console.log(`log: ${log}`);
    console.log(`Follow it with: tail -f ${log}   (it ends with a RELEASE_EXIT line)`);
    return { pid: child.pid, log };
  } finally {
    closeSync(descriptor);
  }
}
function assertClean() {
  if (git("status", "--porcelain", "--untracked-files=all")) fail("Release requires a clean worktree");
}
function remoteRef(ref) {
  const lines = git("ls-remote", "origin", ref).split("\n").filter(Boolean);
  if (lines.length !== 1 || lines[0].split(/\s+/)[1] !== ref) fail("Remote ref is missing or ambiguous: " + ref);
  return lines[0].split(/\s+/)[0];
}
function assertPackage(artifact, version) {
  if (!artifact.packagePath) return;
  const pkg = JSON.parse(readFileSync(resolve(root, artifact.packagePath), "utf8"));
  if (pkg.version !== version) fail("Tag version must match " + artifact.packagePath + " (" + pkg.version + ")");
}
function assertVersionSource(artifact, version, sha) {
  for (const prefix of [artifact.tagPrefix, ...(artifact.localTagPrefixes || [])]) {
    const tag = prefix + version;
    if (git("tag", "--list", tag) && git("rev-parse", "refs/tags/" + tag + "^{commit}") !== sha)
      fail("Version is already bound to another source: " + tag);
  }
}
function validateTag(tag) {
  const { artifact, version } = selectTag(tag);
  if (process.env.GITHUB_ACTIONS === "true" &&
      !process.env.GITHUB_WORKFLOW_REF?.split("@")[0].endsWith("/.github/workflows/" + artifact.workflow))
    fail("Release artifact does not belong to this workflow");
  const ref = "refs/tags/" + tag;
  if (git("cat-file", "-t", ref) !== "tag") fail("Release tag must be annotated");
  const object = git("rev-parse", ref);
  const sha = git("rev-parse", ref + "^{commit}");
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_EVENT_NAME === "push" && sha !== process.env.GITHUB_SHA)
    fail("Release tag must match the triggering commit");
  if (object !== remoteRef(ref) || sha !== remoteRef(ref + "^{}")) fail("Local and remote tag identity differ");
  if (sha !== git("rev-parse", "HEAD")) fail("Checkout must match the tagged commit");
  assertClean();
  run("git", ["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  run("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]);
  assertPackage(artifact, version);
  assertVersionSource(artifact, version, sha);
  const result = { project: catalog.project, artifact: artifact.id, executor: "actions", tag, version, source_sha: sha };
  if (process.env.GITHUB_OUTPUT) for (const [key, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
  console.log("RELEASE_PLAN_JSON=" + JSON.stringify(result));
  return result;
}
function nextVersion(artifact) {
  const prefixes = [artifact.tagPrefix, ...(artifact.localTagPrefixes || [])];
  const versions = git("tag", "--list").split("\n").flatMap(tag => prefixes.flatMap(prefix =>
    tag.startsWith(prefix) && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(tag.slice(prefix.length))
      ? [tag.slice(prefix.length).split(".").map(Number)] : []));
  versions.sort((a,b) => b[0]-a[0] || b[1]-a[1] || b[2]-a[2]);
  if (!versions.length) {
    if (artifact.packagePath) return JSON.parse(readFileSync(resolve(root, artifact.packagePath), "utf8")).version;
    return "0.1.0";
  }
  const [major, minor, patch] = versions[0];
  return major + "." + minor + "." + (patch + 1);
}
function legacyCommand(artifact, executor, options) {
  let script;
  if (catalog.project === "frely-cli" && artifact.id === "cli") script = executor === "actions" ? "release-package" : "release-package-local";
  else if (executor === "local") script = artifact.id === "landing" ? "release-landing-local" : "release-local";
  else return false;
  const args = [];
  if (options.version) args.push("--version", options.version);
  if (options["dry-run"]) args.push("--dry-run");
  if (options["purge-cache"]) args.push("--purge-cache");
  if (options["no-wait"]) process.env.FRELY_RELEASE_WAIT_FOR_CI = "0";
  run("bash", [resolve(root, "scripts", script), ...args]);
  return true;
}
export function main(args = process.argv.slice(2), entryArtifact = catalog.defaultArtifact) {
  const options = parseArguments(args);
  if (options.help || options.list) return help(entryArtifact);
  if (options.detach) return detachRelease(args, entryArtifact);
  const tagInput = options["validate-tag"];
  if (tagInput) {
    validateTag(tagInput);
    return;
  }
  const artifact = catalog.artifacts.find(item => item.id === entryArtifact);
  if (!artifact) fail("Unknown artifact; use --list");
  const executor = options.executor || artifact.defaultExecutor;
  if (!artifact.executors.includes(executor)) fail("Unsupported executor for " + artifact.id + ": " + executor);
  if (options["purge-cache"] && !(catalog.project === "frely" && artifact.id === "landing" && executor === "local"))
    fail("--purge-cache requires the local Frely landing executor");
  if (options["no-wait"] && !(catalog.project === "frely-cli" && artifact.id === "cli" && executor === "actions"))
    fail("--no-wait is supported by the Actions CLI publisher only");
  if (executor === "local") {
    assertClean();
    run("git", ["fetch", "origin", "main", "--tags"]);
    options.version ||= nextVersion(artifact);
    assertVersionSource(artifact, options.version, git("rev-parse", "HEAD"));
  }
  if (legacyCommand(artifact, executor, options)) return;
  assertClean();
  if (git("symbolic-ref", "--quiet", "--short", "HEAD") !== "main") fail("Prepare releases from main");
  run("git", ["fetch", "origin", "main", "--tags"]);
  // （环境：发版, 原因：发版必须基于最新 origin/main；落后自动快进，分叉需人工处理）
  run("git", ["merge", "--ff-only", "refs/remotes/origin/main"]);
  const sha = git("rev-parse", "HEAD");
  run("git", ["merge-base", "--is-ancestor", "origin/main", sha]);
  const version = options.version || nextVersion(artifact);
  if (!semver.test(version)) fail("Invalid release version");
  assertPackage(artifact, version);
  assertVersionSource(artifact, version, sha);
  const tag = artifact.tagPrefix + version;
  if (git("tag", "--list", tag) || git("ls-remote", "origin", "refs/tags/" + tag))
    fail("Release tag already exists; rerun its Actions workflow for a retry: " + tag);
  const plan = { project: catalog.project, artifact: artifact.id, executor, tag, version, source_sha: sha, workflow: artifact.workflow };
  console.log("RELEASE_PLAN_JSON=" + JSON.stringify(plan));
  if (options["dry-run"]) return;
  if (git("rev-parse", "origin/main") !== sha) run("git", ["push", "origin", "HEAD:refs/heads/main"]);
  run("git", ["tag", "--annotate", "--no-sign", tag, sha, "-m", JSON.stringify(plan)]);
  run("git", ["push", "origin", "refs/tags/" + tag]);
  if (remoteRef("refs/tags/" + tag) !== git("rev-parse", "refs/tags/" + tag)) fail("Published tag identity mismatch");
  console.log("Actions submitted: " + artifact.workflow + " at " + tag + ". Deployment is pending workflow verification.");
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(undefined, process.env[DETACHED_ARTIFACT_ENV] || undefined); } catch (error) { console.error(error.message); process.exitCode = 1; }
  if (process.env[DETACHED_LOG_ENV]) console.log(`RELEASE_EXIT status=${process.exitCode ?? 0}`);
}
