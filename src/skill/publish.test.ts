import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudItemError } from "./cloud-item.js";
import { buildZip, packageSkillFolder, publishSkillFolder } from "./publish.js";

async function skillFolder(extra: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "frely-publish-"));
  const folder = join(root, "demo");
  await mkdir(join(folder, "references"), { recursive: true });
  await writeFile(join(folder, "SKILL.md"), "---\nname: demo\ndescription: A demo Skill.\n---\n\n# Demo\n");
  await writeFile(join(folder, "references", "a.md"), "alpha");
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(join(folder, path, ".."), { recursive: true });
    await writeFile(join(folder, path), content);
  }
  return folder;
}
const cleanup = (folder: string) => rm(join(folder, ".."), { recursive: true, force: true });

test("packaging keeps the Skill and leaves out dotfiles, project configuration, caches and dependencies", async () => {
  const folder = await skillFolder({ ".agents/.cache/x.md": "cache", "skills-config/demo/config.yaml": "secret", "node_modules/p/i.js": "x", ".env": "KEY=1", "scripts/run.mjs": "export {}" });
  try {
    const packaged = await packageSkillFolder(folder);
    assert.deepEqual(packaged.files.map((file) => file.path), ["SKILL.md", "references/a.md", "scripts/run.mjs"]);
    assert.equal(packaged.name, "demo");
    assert.equal(packaged.description, "A demo Skill.");
  } finally { await cleanup(folder); }
});

test("a folder without SKILL.md, a name, or with a symlink or oversized file is refused before any upload", async () => {
  const folder = await skillFolder();
  try {
    await writeFile(join(folder, "SKILL.md"), "no frontmatter");
    await assert.rejects(packageSkillFolder(folder), /needs frontmatter with a name/u);
    await writeFile(join(folder, "SKILL.md"), "---\nname: demo\n---\n");
    await writeFile(join(folder, "big.md"), "x".repeat(64 * 1024 + 1));
    await assert.rejects(packageSkillFolder(folder), (error: unknown) => error instanceof CloudItemError && /at most/u.test(error.message));
    await rm(join(folder, "big.md"));
    await symlink("/etc/hostname", join(folder, "link.md"));
    await assert.rejects(packageSkillFolder(folder), /symbolic link/u);
    await assert.rejects(packageSkillFolder(join(folder, "missing")), /is not a folder/u);
  } finally { await cleanup(folder); }
});

test("the zip is a real archive any unzip tool reads", async () => {
  const folder = await skillFolder();
  try {
    const zip = buildZip((await packageSkillFolder(folder)).files);
    const file = join(folder, "..", "out.zip");
    await writeFile(file, zip);
    const listing = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.match(listing, /No errors detected/u);
    assert.equal(execFileSync("unzip", ["-p", file, "references/a.md"], { encoding: "utf8" }), "alpha");
  } finally { await cleanup(folder); }
});

test("publish sends one skills.publish call with the slug, description, package and premium paths", async () => {
  const folder = await skillFolder({ "premium/p.md": "paid" });
  try {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const result = await publishSkillFolder({
      folder, slug: "demo-skill", premium: ["premium/"],
      call: async (name, input) => { calls.push({ name, input }); return { installName: "frely/demo-skill", version: 2, created: false, unchanged: false, hasScripts: false, fileCount: 3, notices: ["n"] }; },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "skills.publish");
    assert.equal(calls[0]!.input.kind, "skill");
    assert.equal(calls[0]!.input.slug, "demo-skill");
    assert.equal(calls[0]!.input.displayName, "demo");
    assert.equal(calls[0]!.input.description, "A demo Skill.");
    assert.deepEqual(calls[0]!.input.premiumPaths, ["premium/"]);
    assert.match(String(calls[0]!.input.packageBase64), /^[A-Za-z0-9+/]+={0,2}$/u);
    assert.deepEqual([result.installName, result.version], ["frely/demo-skill", 2]);
  } finally { await cleanup(folder); }
});

test("the slug defaults to the Skill name, and bad slugs and premium paths fail locally", async () => {
  const folder = await skillFolder();
  try {
    const seen: unknown[] = [];
    await publishSkillFolder({ folder, call: async (_name, input) => { seen.push(input.slug); return { version: 1 }; } });
    assert.deepEqual(seen, ["demo"]);
    await assert.rejects(publishSkillFolder({ folder, slug: "Bad_Slug", call: async () => ({}) }), /slug/u);
    await assert.rejects(publishSkillFolder({ folder, premium: ["nope.md"], call: async () => ({}) }), /matches no file/u);
    await assert.rejects(publishSkillFolder({ folder, premium: ["SKILL.md"], call: async () => ({}) }), /always free/u);
    assert.equal(seen.length, 1);
  } finally { await cleanup(folder); }
});
