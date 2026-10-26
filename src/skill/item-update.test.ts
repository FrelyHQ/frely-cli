import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudItemError, installCloudItem, type CloudToolCaller } from "./cloud-item.js";
import { checkItemUpdates, updateCloudItem } from "./item-update.js";

const skillId = "cloud_skill_0123456789abcdef01234567";
const b64 = (text: string) => Buffer.from(text).toString("base64");

function caller(state: { version: number }, calls: string[] = []): CloudToolCaller {
  return async (name, input) => {
    assert.equal(name, "skills.install");
    calls.push(String(input.part));
    const manifest = { id: skillId, kind: "skill", slug: "review", displayName: "Review", version: state.version, hasScripts: false, manifestDigest: "a".repeat(64), premium: { fileCount: 0, totalBytes: 0 }, scan: null };
    return { manifest, files: [{ path: "SKILL.md", contentBase64: b64(`version ${state.version}`), isScript: false }] };
  };
}

test("a check reports a newer version and changes nothing on disk", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-update-")));
  try {
    const state = { version: 1 };
    const installed = await installCloudItem({ skillId, call: caller(state), host: "claude-code", scope: "global", home });
    state.version = 2;
    const statuses = await checkItemUpdates({ call: caller(state), home });
    assert.deepEqual(statuses.map((status) => [status.installed, status.latest, status.state]), [[1, 2, "available"]]);
    assert.equal(await readFile(join(installed.path, "SKILL.md"), "utf8"), "version 1");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an update installs the new version only when asked, and refuses an edited folder", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-update-")));
  try {
    const state = { version: 1 };
    const installed = await installCloudItem({ skillId, call: caller(state), host: "claude-code", scope: "global", home });
    state.version = 2;
    const updated = await updateCloudItem({ folder: installed.path, call: caller(state), home });
    assert.equal(updated.version, 2);
    assert.equal(await readFile(join(installed.path, "SKILL.md"), "utf8"), "version 2");
    assert.equal((await checkItemUpdates({ call: caller(state), home }))[0]?.state, "current");
    state.version = 3;
    await writeFile(join(installed.path, "SKILL.md"), "edited");
    await assert.rejects(updateCloudItem({ folder: installed.path, call: caller(state), home }), (error: unknown) => error instanceof CloudItemError && error.code === "managed_item_modified");
    await assert.rejects(updateCloudItem({ folder: join(home, "elsewhere"), call: caller(state), home }), (error: unknown) => error instanceof CloudItemError && error.code === "item_invalid");
  } finally { await rm(home, { recursive: true, force: true }); }
});
