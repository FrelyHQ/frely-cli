import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalFolder, skillContext } from "./agent-links.js";
import { writeItemFolder } from "./cloud-item.js";
import { installEntrySkill, removeEntrySkill } from "./entry.js";
import { readInstall } from "./registry.js";

async function tempHome(): Promise<string> { return realpath(await mkdtemp(join(tmpdir(), "frely-links-"))); }
const file = (path: string, text: string) => ({ path, contentBase64: Buffer.from(text).toString("base64"), isScript: false });
const isLink = async (path: string) => (await lstat(path)).isSymbolicLink();

test("a Skill is linked into an installed agent that does not read .agents, and not into one that is absent", async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    const result = await installEntrySkill({ home });
    const link = join(home, ".workbuddy", "skills", "frely");
    assert.equal(result.path, join(home, ".agents", "skills", "frely"));
    assert.ok(await isLink(link));
    assert.equal(await realpath(link), result.path);
    assert.equal(await readFile(join(link, "SKILL.md"), "utf8"), await readFile(join(result.path, "SKILL.md"), "utf8"));
    assert.deepEqual(result.links.map((entry) => [entry.path, entry.mode]), [[link, process.platform === "win32" ? "junction" : "symlink"]]);
    assert.equal(await lstat(join(home, ".codebuddy")).then(() => true, () => false), false);
    assert.equal(await lstat(join(home, ".claude")).then(() => true, () => false), false);
    assert.equal((await readInstall(result.path, home))?.links?.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("--host workbuddy links even when its folder does not exist yet; --host codex links nothing", async () => {
  const home = await tempHome();
  try {
    const none = await installEntrySkill({ home, host: "codex" });
    assert.deepEqual(none.links, []);
    await installEntrySkill({ home, host: "workbuddy" });
    assert.ok(await isLink(join(home, ".workbuddy", "skills", "frely")));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a project install links into the project's own agent folder", async () => {
  const home = await tempHome();
  try {
    const project = join(home, "work");
    await mkdir(join(project, ".workbuddy"), { recursive: true });
    const result = await installEntrySkill({ home, scope: "project", dir: project });
    assert.equal(result.path, join(project, ".agents", "skills", "frely"));
    assert.ok(await isLink(join(project, ".workbuddy", "skills", "frely")));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("something already in the agent folder is skipped and left alone", async () => {
  const home = await tempHome();
  try {
    const own = join(home, ".workbuddy", "skills", "frely");
    await mkdir(own, { recursive: true });
    await writeFile(join(own, "SKILL.md"), "mine");
    const elsewhere = join(home, "elsewhere");
    await mkdir(join(home, ".codebuddy", "skills"), { recursive: true });
    await mkdir(elsewhere);
    await symlink(elsewhere, join(home, ".codebuddy", "skills", "frely"), "dir");
    const result = await installEntrySkill({ home });
    assert.deepEqual(result.links.map((entry) => entry.mode), ["skipped", "skipped"]);
    assert.equal(await readFile(join(own, "SKILL.md"), "utf8"), "mine");
    assert.equal(await readlink(join(home, ".codebuddy", "skills", "frely")), elsewhere);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("installing again keeps our link without complaint", async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    await installEntrySkill({ home });
    const again = await installEntrySkill({ home });
    assert.equal(again.links[0]?.mode === "skipped", false);
    assert.equal((await readInstall(again.path, home))?.links?.length, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("removing the Skill removes the link only; the content survives until its own removal", async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    const result = await installEntrySkill({ home });
    const link = join(home, ".workbuddy", "skills", "frely");
    await removeEntrySkill(result.path, home);
    assert.equal(await lstat(link).then(() => true, () => false), false);
    assert.equal(await lstat(result.path).then(() => true, () => false), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a link that points elsewhere is not removed on uninstall; a symlinked folder is never deleted through", async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    const result = await installEntrySkill({ home });
    const link = join(home, ".workbuddy", "skills", "frely");
    await rm(link);
    const other = join(home, "other");
    await mkdir(other);
    await writeFile(join(other, "keep.txt"), "keep");
    await symlink(other, link, "dir");
    await removeEntrySkill(result.path, home);
    assert.equal(await readFile(join(other, "keep.txt"), "utf8"), "keep");
    assert.ok(await isLink(link));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("when linking fails the folder is copied, refreshed on update, and left alone once edited", async () => {
  const home = await tempHome();
  try {
    const target = join(home, ".agents", "skills", "demo");
    const failing = async () => { throw Object.assign(new Error("no"), { code: "EPERM" }); };
    const { linkSkill } = await import("./agent-links.js");
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    const first = await writeItemFolder(target, "skill_aaaaaaaaaaaaaaaaaaaaaaaa", "skill", [file("SKILL.md", "v1")], home);
    // Replace the link made above with a copy, as if symlinks were not allowed.
    await rm(join(home, ".workbuddy", "skills", "demo"));
    const copied = await linkSkill({ canonical: target, home, symlinkFn: failing });
    assert.deepEqual(copied.links.map((entry) => entry.mode), ["copy"]);
    const copyPath = join(home, ".workbuddy", "skills", "demo");
    assert.equal(await readFile(join(copyPath, "SKILL.md"), "utf8"), "v1");
    // Update: the untouched copy is refreshed.
    await writeFile(join(target, "SKILL.md"), "v2");
    const refreshed = await linkSkill({ canonical: target, home, symlinkFn: failing, previous: copied.links, previousFiles: first.files });
    assert.equal(await readFile(join(copyPath, "SKILL.md"), "utf8"), "v2");
    // A copy the user edited is not replaced.
    await writeFile(join(copyPath, "SKILL.md"), "mine");
    const blocked = await linkSkill({ canonical: target, home, symlinkFn: failing, previous: refreshed.links, previousFiles: { "SKILL.md": (await readInstall(target, home))!.files["SKILL.md"]! } });
    assert.equal(blocked.outcomes[0]?.mode, "skipped");
    assert.equal(await readFile(join(copyPath, "SKILL.md"), "utf8"), "mine");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an untouched older install straight in an agent's folder gives way to the link; an edited one stays", async () => {
  const home = await tempHome();
  try {
    const legacy = join(home, ".claude", "skills", "demo");
    await writeItemFolder(legacy, "skill_aaaaaaaaaaaaaaaaaaaaaaaa", "skill", [file("SKILL.md", "old")], home);
    assert.equal(skillContext(legacy, home)?.legacy, true);
    assert.equal(canonicalFolder(legacy, home), join(home, ".agents", "skills", "demo"));
    // The canonical write finds the older install and replaces it by a link.
    const moved = await writeItemFolder(canonicalFolder(legacy, home), "skill_aaaaaaaaaaaaaaaaaaaaaaaa", "skill", [file("SKILL.md", "new")], home);
    assert.ok(await isLink(legacy));
    assert.equal(await readFile(join(legacy, "SKILL.md"), "utf8"), "new");
    assert.equal(await readInstall(legacy, home), null);
    assert.equal(moved.links?.length, 1);

    const edited = join(home, ".pi", "agent", "skills", "other");
    await writeItemFolder(edited, "skill_bbbbbbbbbbbbbbbbbbbbbbbb", "skill", [file("SKILL.md", "old")], home);
    await writeFile(join(edited, "SKILL.md"), "mine");
    const kept = await writeItemFolder(canonicalFolder(edited, home), "skill_bbbbbbbbbbbbbbbbbbbbbbbb", "skill", [file("SKILL.md", "new")], home);
    assert.equal(kept.linkOutcomes.find((entry) => entry.path === edited)?.mode, "skipped");
    assert.equal(await readFile(join(edited, "SKILL.md"), "utf8"), "mine");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("on Windows the link is a real junction that unlink removes without touching the content", { skip: process.platform !== "win32" }, async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    const result = await installEntrySkill({ home });
    const link = join(home, ".workbuddy", "skills", "frely");
    assert.equal(result.links[0]?.mode, "junction");
    assert.ok(await isLink(link));
    await removeEntrySkill(result.path, home);
    assert.equal(await lstat(link).then(() => true, () => false), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
