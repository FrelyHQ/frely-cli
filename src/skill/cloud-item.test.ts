import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudItemError, CloudToolError, installCloudItem, parseItemRef, trustCloudItem, type CloudToolCaller } from "./cloud-item.js";

const skillId = "cloud_skill_0123456789abcdef01234567";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function caller(options: { kind?: "prompt" | "skill"; premium?: "ok" | "pass" | "none"; paths?: string[]; scan?: "pass" | "stale" } = {}): CloudToolCaller {
  const kind = options.kind ?? "skill";
  const premium = options.premium ?? "none";
  return async (name, input) => {
    assert.equal(name, "skills.install");
    const manifest = { id: skillId, kind, slug: "review", displayName: "Review", version: 2, hasScripts: true, manifestDigest: "a".repeat(64), premium: { fileCount: premium === "none" ? 0 : 1, totalBytes: 4 },
      scan: options.scan ? { verdict: "pass", manifestDigest: options.scan === "pass" ? "a".repeat(64) : "b".repeat(64) } : null };
    if (input.part === "premium") {
      if (premium === "pass") throw new CloudToolError("creator_pass_required");
      return { manifest, files: [{ path: kind === "prompt" ? "PREMIUM.md" : "premium/extra.md", contentBase64: b64("paid"), isScript: false }] };
    }
    const paths = options.paths ?? (kind === "prompt" ? ["PROMPT.md"] : ["SKILL.md", "scripts/run.sh"]);
    return { manifest, files: paths.map((path) => ({ path, contentBase64: b64(`content of ${path}`), isScript: path.endsWith(".sh") })) };
  };
}

test("installs a Skill with its paid part into the host Skill folder without execute permission", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller({ premium: "ok" }), host: "claude-code", scope: "global", home });
    assert.equal(result.path, join(home, ".claude", "skills", "review"));
    assert.equal(result.premium, "installed");
    assert.equal(result.files, 3);
    assert.equal(await readFile(join(result.path, "premium", "extra.md"), "utf8"), "paid");
    assert.equal((await stat(join(result.path, "scripts", "run.sh"))).mode & 0o111, 0);
    const again = await installCloudItem({ skillId, call: caller({ premium: "ok" }), host: "claude-code", scope: "global", home });
    assert.equal(again.path, result.path);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("installs the free part of a Prompt and reports a missing pass", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller({ kind: "prompt", premium: "pass" }), cwd });
    assert.equal(result.premium, "pass_required");
    assert.equal(await readFile(join(cwd, "review", "PROMPT.md"), "utf8"), "content of PROMPT.md");
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("refuses unsafe paths, unmanaged folders and edited files", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    await assert.rejects(installCloudItem({ skillId, call: caller({ paths: ["../escape.md"] }), home }), (error: unknown) => error instanceof CloudItemError && error.code === "item_invalid");
    await assert.rejects(installCloudItem({ skillId, call: caller({ paths: ["C:/escape.md"] }), home }), (error: unknown) => error instanceof CloudItemError && error.code === "item_invalid");
    await assert.rejects(installCloudItem({ skillId: "../x", call: caller(), home }), (error: unknown) => error instanceof CloudItemError && error.code === "input_invalid");
    const result = await installCloudItem({ skillId, call: caller(), home });
    await writeFile(join(result.path, "SKILL.md"), "edited");
    await assert.rejects(installCloudItem({ skillId, call: caller(), home }), (error: unknown) => error instanceof CloudItemError && error.code === "managed_item_modified");
    await rm(join(home, ".config", "frely", "installs"), { recursive: true });
    await assert.rejects(installCloudItem({ skillId, call: caller(), home }), (error: unknown) => error instanceof CloudItemError && error.code === "unmanaged_item_exists");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("tracks review per version and leaves the Skill folder as it was delivered", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller(), host: "claude-code", scope: "global", home });
    assert.equal(result.needsReview, true);
    assert.deepEqual((await readdir(result.path)).sort(), ["SKILL.md", "scripts"]);
    await assert.rejects(readFile(join(home, ".claude", "skills", "frely-item-guard", "SKILL.md"), "utf8"));
    assert.deepEqual(await trustCloudItem(result.path, { check: true, home }), { trusted: false });
    await trustCloudItem(result.path, { home });
    assert.deepEqual(await trustCloudItem(result.path, { check: true, home }), { trusted: true });
    const updated: CloudToolCaller = async (name, input) => {
      const value = await caller()(name, input) as { files: Array<{ path: string; contentBase64: string }> };
      return { ...value, files: value.files.map((file) => (file.path === "SKILL.md" ? { ...file, contentBase64: b64("new version") } : file)) };
    };
    await installCloudItem({ skillId, call: updated, host: "claude-code", scope: "global", home });
    assert.deepEqual(await trustCloudItem(result.path, { check: true, home }), { trusted: false });
    await assert.rejects(trustCloudItem(home, { check: true, home }), CloudItemError);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a Prompt needs no review", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller({ kind: "prompt" }), home, cwd: home });
    assert.equal(result.needsReview, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a passing Frely scan for this version marks the Skill reviewed and drops the review hint", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller({ scan: "pass" }), host: "claude-code", scope: "global", home });
    assert.equal(result.scanned, true);
    assert.equal(result.needsReview, false);
    assert.deepEqual(await trustCloudItem(result.path, { check: true, home }), { trusted: true });
    // A scan for another digest, or no scan, keeps the local review.
    const stale = await installCloudItem({ skillId: "cloud_skill_" + "1".repeat(24), call: async (name, input) => ({ ...(await caller({ scan: "stale" })(name, input)), manifest: { ...(await caller({ scan: "stale" })(name, input) as { manifest: object }).manifest, id: "cloud_skill_" + "1".repeat(24), slug: "other" } }), host: "claude-code", scope: "global", home });
    assert.equal(stale.scanned, false);
    assert.equal(stale.needsReview, true);
    assert.deepEqual(await trustCloudItem(stale.path, { check: true, home }), { trusted: false });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("two items with the same name never share a folder", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    await installCloudItem({ skillId, call: caller(), host: "claude-code", home });
    const otherId = "cloud_skill_" + "2".repeat(24);
    const other: CloudToolCaller = async (name, input) => {
      const value = await caller()(name, input) as { manifest: object };
      return { ...value, manifest: { ...value.manifest, id: otherId } };
    };
    await assert.rejects(installCloudItem({ skillId: otherId, call: other, host: "claude-code", home }), (error: unknown) => error instanceof CloudItemError && error.code === "unmanaged_item_exists");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a project install goes under --dir and is recorded", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  const project = join(home, "work");
  try {
    const result = await installCloudItem({ skillId, call: caller(), host: "claude-code", scope: "project", dir: project, home });
    assert.equal(result.path, join(project, ".claude", "skills", "review"));
    assert.deepEqual(await trustCloudItem(result.path, { check: true, home }), { trusted: false });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("installs by username/skill-name and pins a version by name; the paid call reuses the resolved id and version", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const calls: Array<Record<string, unknown>> = [];
    const base = caller({ premium: "ok" });
    const result = await installCloudItem({ ...parseItemRef("Ada/review@2".replace("Ada", "ada")), call: async (name, input) => { calls.push(input); return base(name, input); }, host: "claude-code", scope: "global", home });
    assert.equal(result.id, skillId);
    assert.equal(calls[0]?.name, "ada/review");
    assert.equal(calls[0]?.version, 2);
    assert.equal(calls[1]?.skillId, skillId);
    assert.equal(calls[1]?.name, undefined);
    assert.equal(calls[1]?.version, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("parses names and ids, with an optional @version", () => {
  assert.deepEqual(parseItemRef("ada/review"), { name: "ada/review" });
  assert.deepEqual(parseItemRef("ada/review@3"), { name: "ada/review", version: 3 });
  assert.deepEqual(parseItemRef("skill_0123456789abcdef01234567"), { skillId: "skill_0123456789abcdef01234567" });
  assert.deepEqual(parseItemRef(`${skillId}@4`), { skillId, version: 4 });
  for (const bad of ["review", "ada/", "/review", "ada/review@0", "ada/review@x", "../x", "ada/review/extra"]) {
    assert.throws(() => parseItemRef(bad), (error: unknown) => error instanceof CloudItemError && error.code === "input_invalid", bad);
  }
});
