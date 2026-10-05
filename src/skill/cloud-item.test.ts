import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudItemError, CloudToolError, installCloudItem, trustCloudItem, type CloudToolCaller } from "./cloud-item.js";

const skillId = "cloud_skill_0123456789abcdef01234567";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function caller(options: { kind?: "prompt" | "skill"; premium?: "ok" | "pass" | "none"; paths?: string[] } = {}): CloudToolCaller {
  const kind = options.kind ?? "skill";
  const premium = options.premium ?? "none";
  return async (name, input) => {
    assert.equal(name, "skills.install");
    const manifest = { id: skillId, kind, slug: "review", displayName: "Review", version: 2, hasScripts: true, premium: { fileCount: premium === "none" ? 0 : 1, totalBytes: 4 } };
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
    assert.equal(result.path, join(home, ".claude", "skills", "frely-review-01234567"));
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
    assert.equal(await readFile(join(cwd, "frely-review-01234567", "PROMPT.md"), "utf8"), "content of PROMPT.md");
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
    await rm(join(result.path, ".frely-managed.json"));
    await assert.rejects(installCloudItem({ skillId, call: caller(), home }), (error: unknown) => error instanceof CloudItemError && error.code === "unmanaged_item_exists");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("installs the guard Skill next to a Skill and tracks review per version", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller(), host: "claude-code", scope: "global", home });
    assert.equal(result.guarded, true);
    assert.match(await readFile(join(home, ".claude", "skills", "frely-item-guard", "SKILL.md"), "utf8"), /frely item trust/);
    assert.deepEqual(await trustCloudItem(result.path, { check: true }), { trusted: false });
    await trustCloudItem(result.path);
    assert.deepEqual(await trustCloudItem(result.path, { check: true }), { trusted: true });
    const updated: CloudToolCaller = async (name, input) => {
      const value = await caller()(name, input) as { files: Array<{ path: string; contentBase64: string }> };
      return { ...value, files: value.files.map((file) => (file.path === "SKILL.md" ? { ...file, contentBase64: b64("new version") } : file)) };
    };
    await installCloudItem({ skillId, call: updated, host: "claude-code", scope: "global", home });
    assert.deepEqual(await trustCloudItem(result.path, { check: true }), { trusted: false });
    await assert.rejects(trustCloudItem(home, { check: true }), CloudItemError);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("does not install the guard Skill for a Prompt", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-item-")));
  try {
    const result = await installCloudItem({ skillId, call: caller({ kind: "prompt" }), home, cwd: home });
    assert.equal(result.guarded, false);
    await assert.rejects(readFile(join(home, ".claude", "skills", "frely-item-guard", "SKILL.md"), "utf8"));
  } finally { await rm(home, { recursive: true, force: true }); }
});
