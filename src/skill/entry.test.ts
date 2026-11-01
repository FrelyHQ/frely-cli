import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudItemError } from "./cloud-item.js";
import { ENTRY_SKILL, ensureEntrySkill, installEntrySkill, removeEntrySkill, untouchedEntrySkills } from "./entry.js";

test("installs the entry Skill into the host folder and refreshes it on a second run", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const result = await installEntrySkill({ host: "claude-code", scope: "global", home });
    assert.equal(result.path, join(home, ".claude", "skills", "frely"));
    assert.equal(await readFile(join(result.path, "SKILL.md"), "utf8"), ENTRY_SKILL);
    assert.equal((await installEntrySkill({ host: "claude-code", scope: "global", home })).path, result.path);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("never overwrites an edited copy or a folder Frely did not write", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const { path } = await installEntrySkill({ home });
    await writeFile(join(path, "SKILL.md"), "mine");
    await assert.rejects(installEntrySkill({ home }), (error) => error instanceof CloudItemError && error.code === "managed_item_modified");
    const unmanaged = join(home, ".pi", "agent", "skills", "frely");
    await mkdir(unmanaged, { recursive: true });
    await writeFile(join(unmanaged, "SKILL.md"), "other");
    await assert.rejects(installEntrySkill({ home, host: "pi" }), (error) => error instanceof CloudItemError && error.code === "unmanaged_item_exists");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("ensureEntrySkill installs beside an item and yields when the folder is taken or edited", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const beside = await ensureEntrySkill({ host: "claude-code", scope: "global", home });
    assert.ok(beside);
    assert.equal(beside.path, join(home, ".claude", "skills", "frely"));
    // An edited entry Skill is the user's: skipped, and an item install never fails on it.
    await writeFile(join(beside.path, "SKILL.md"), "mine");
    assert.equal(await ensureEntrySkill({ host: "claude-code", scope: "global", home }), null);
    const unmanaged = join(home, ".pi", "agent", "skills", "frely");
    await mkdir(unmanaged, { recursive: true });
    await writeFile(join(unmanaged, "SKILL.md"), "other");
    assert.equal(await ensureEntrySkill({ home, host: "pi" }), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the entry Skill keeps device MCP opt-in", () => {
  assert.match(ENTRY_SKILL, /^---\nname: frely\n/u);
  assert.doesNotMatch(ENTRY_SKILL, /login --email <address> --mcp/u);
  assert.match(ENTRY_SKILL, /Do nothing until the user agrees/u);
});

test("the entry Skill tells how to get a payment link and installs an Agent by name", () => {
  assert.match(ENTRY_SKILL, /payment_required/u);
  assert.match(ENTRY_SKILL, /credit_products\.list/u);
  assert.match(ENTRY_SKILL, /payment_checkout\.create/u);
  assert.match(ENTRY_SKILL, /frely agent install <username\/name>/u);
  assert.doesNotMatch(ENTRY_SKILL, /frely agent install <id>/u);
});

test("a project install goes under --dir and no marker file is left in the Skill folder", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const project = join(home, "work");
    const { path } = await installEntrySkill({ host: "claude-code", scope: "project", dir: project, home });
    assert.equal(path, join(project, ".claude", "skills", "frely"));
    assert.deepEqual(await readdir(path), ["SKILL.md"]);
    assert.deepEqual(await untouchedEntrySkills(home), [path]);
    await removeEntrySkill(path, home);
    assert.deepEqual(await untouchedEntrySkills(home), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
