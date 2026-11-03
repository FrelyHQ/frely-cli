import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeItemFolder } from "./cloud-item.js";
import { installEntrySkill } from "./entry.js";
import { linkSyncStatePath, syncAgentLinks } from "./link-sync.js";
import { readInstall } from "./registry.js";

async function tempHome(): Promise<string> { return realpath(await mkdtemp(join(tmpdir(), "frely-sync-"))); }
const exists = (path: string) => lstat(path).then(() => true, () => false);
const file = (path: string, text: string) => ({ path, contentBase64: Buffer.from(text).toString("base64"), isScript: false });

test("an agent installed after the Skill gets its link on the next pass, and only once", async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    const skill = await installEntrySkill({ home });
    await syncAgentLinks({ home, mode: "check" });
    await mkdir(join(home, ".pi"), { recursive: true });
    const result = await syncAgentLinks({ home, mode: "check" });
    const link = join(home, ".pi", "agent", "skills", "frely");
    assert.deepEqual(result.added.map((change) => [change.agent, change.path]), [["pi", link]]);
    assert.equal(await realpath(link), skill.path);
    assert.deepEqual((await readInstall(skill.path, home))?.links?.map((entry) => entry.path).sort(), [link, join(home, ".workbuddy", "skills", "frely")].sort());
    const again = await syncAgentLinks({ home, mode: "check" });
    assert.equal(again.scanned, false);
    assert.equal((await syncAgentLinks({ home, mode: "full" })).added.length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a check pass does nothing while the agent folders look the same; a CLI that knows a new agent rescans", async () => {
  const home = await tempHome();
  try {
    await installEntrySkill({ home });
    assert.equal((await syncAgentLinks({ home, mode: "check" })).scanned, true);
    assert.equal((await syncAgentLinks({ home, mode: "check" })).scanned, false);
    await writeFile(linkSyncStatePath(home), JSON.stringify({ version: 1, agents: ["workbuddy"], present: [] }));
    assert.equal((await syncAgentLinks({ home, mode: "check" })).scanned, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a link the person deleted is not put back by automatic passes; --host puts it back; reinstall clears the mark", async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".workbuddy"), { recursive: true });
    const skill = await installEntrySkill({ home });
    const link = join(home, ".workbuddy", "skills", "frely");
    await unlink(link);
    const first = await syncAgentLinks({ home, mode: "full" });
    assert.deepEqual(first.dismissed.map((change) => change.path), [link]);
    assert.equal(await exists(link), false);
    assert.deepEqual((await readInstall(skill.path, home))?.dismissedLinks, [link]);
    assert.equal((await syncAgentLinks({ home, mode: "full" })).added.length, 0);
    assert.equal(await exists(link), false);
    const forced = await syncAgentLinks({ home, mode: "check", force: "workbuddy" });
    assert.deepEqual(forced.added.map((change) => change.path), [link]);
    assert.equal((await readInstall(skill.path, home))?.dismissedLinks, undefined);
    await unlink(link);
    await syncAgentLinks({ home, mode: "full" });
    await installEntrySkill({ home });
    assert.ok(await exists(link));
    assert.equal((await readInstall(skill.path, home))?.dismissedLinks, undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("an agent that is removed is forgotten, and linked again as new when it comes back", async () => {
  const home = await tempHome();
  try {
    await mkdir(join(home, ".pi"), { recursive: true });
    const skill = await installEntrySkill({ home });
    await rm(join(home, ".pi"), { recursive: true, force: true });
    await syncAgentLinks({ home, mode: "check" });
    assert.equal((await readInstall(skill.path, home))?.links, undefined);
    await mkdir(join(home, ".pi"), { recursive: true });
    const back = await syncAgentLinks({ home, mode: "check" });
    assert.deepEqual(back.added.map((change) => change.agent), ["pi"]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("project Skills follow agents added to the project; a folder Frely did not write is left alone; prompts are never linked", async () => {
  const home = await tempHome();
  try {
    const project = join(home, "work");
    const target = join(project, ".agents", "skills", "foo");
    await writeItemFolder(target, "skill_foo", "skill", [file("SKILL.md", "foo")], home);
    await writeItemFolder(join(home, ".agents", "skills", "notes"), "skill_notes", "prompt", [file("SKILL.md", "notes")], home);
    await mkdir(join(project, ".claude", "skills", "foo"), { recursive: true });
    await mkdir(join(project, ".pi"), { recursive: true });
    await mkdir(join(home, ".pi"), { recursive: true });
    const result = await syncAgentLinks({ home, mode: "full" });
    assert.deepEqual(result.added.map((change) => change.path), [join(project, ".pi", "skills", "foo")]);
    assert.deepEqual(result.skipped.map((change) => change.path), [join(project, ".claude", "skills", "foo")]);
    assert.equal((await lstat(join(project, ".claude", "skills", "foo"))).isSymbolicLink(), false);
    assert.equal(await exists(join(home, ".pi", "agent", "skills", "notes")), false);
    await rm(project, { recursive: true, force: true });
    assert.equal((await syncAgentLinks({ home, mode: "full" })).added.length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a dry run reports missing links and writes nothing", async () => {
  const home = await tempHome();
  try {
    await installEntrySkill({ home });
    await mkdir(join(home, ".codebuddy"), { recursive: true });
    const result = await syncAgentLinks({ home, mode: "full", dryRun: true });
    assert.deepEqual(result.added.map((change) => change.agent), ["codebuddy"]);
    assert.equal(await exists(join(home, ".codebuddy", "skills", "frely")), false);
    assert.equal(await exists(linkSyncStatePath(home)), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a pass that finds the lock held by another pass skips instead of waiting", async () => {
  const home = await tempHome();
  try {
    await installEntrySkill({ home });
    await mkdir(join(home, ".pi"), { recursive: true });
    await writeFile(join(home, ".config", "frely", "agent-links.lock"), "1");
    assert.equal((await syncAgentLinks({ home, mode: "full" })).scanned, false);
    assert.equal(await exists(join(home, ".pi", "agent", "skills", "frely")), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
