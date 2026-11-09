import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudItemError } from "./cloud-item.js";
import { ENTRY_SKILL, ensureEntrySkill, fetchEntrySkill, installEntrySkill, removeEntrySkill, untouchedEntrySkills } from "./entry.js";

test("installs the entry Skill into the host folder and refreshes it on a second run", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const result = await installEntrySkill({ host: "claude-code", scope: "global", home });
    assert.equal(result.path, join(home, ".agents", "skills", "frely"));
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
    const unmanaged = join(home, ".agents", "skills", "frely");
    await rm(unmanaged, { recursive: true });
    await rm(join(home, ".config"), { recursive: true });
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
    assert.equal(beside.path, join(home, ".agents", "skills", "frely"));
    // An edited entry Skill is the user's: skipped, and an item install never fails on it.
    await writeFile(join(beside.path, "SKILL.md"), "mine");
    assert.equal(await ensureEntrySkill({ host: "claude-code", scope: "global", home }), null);
    const unmanaged = join(home, ".agents", "skills", "frely");
    await rm(unmanaged, { recursive: true });
    await rm(join(home, ".config"), { recursive: true });
    await mkdir(unmanaged, { recursive: true });
    await writeFile(join(unmanaged, "SKILL.md"), "other");
    assert.equal(await ensureEntrySkill({ home, host: "pi" }), null);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("the entry Skill keeps device MCP opt-in", () => {
  assert.match(ENTRY_SKILL, /^---\nname: frely\n/u);
  assert.doesNotMatch(ENTRY_SKILL, /--mcp/u);
  assert.match(ENTRY_SKILL, /Do nothing until the user agrees/u);
});

test("the entry Skill tells how to get a payment link and installs an Agent by name", () => {
  assert.match(ENTRY_SKILL, /payment_required/u);
  assert.match(ENTRY_SKILL, /credit_products\.list/u);
  assert.match(ENTRY_SKILL, /payment_checkout\.create/u);
  assert.match(ENTRY_SKILL, /frely item install <username\/name> --host/u);
  assert.doesNotMatch(ENTRY_SKILL, /frely agent install/u);
});

test("a project install goes under --dir and no marker file is left in the Skill folder", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const project = join(home, "work");
    const { path } = await installEntrySkill({ host: "claude-code", scope: "project", dir: project, home });
    assert.equal(path, join(project, ".agents", "skills", "frely"));
    assert.deepEqual(await readdir(path), ["SKILL.md"]);
    assert.deepEqual(await untouchedEntrySkills(home), [path]);
    await removeEntrySkill(path, home);
    assert.deepEqual(await untouchedEntrySkills(home), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

/** The answer Frely gives: the text, its id, and the hash of those same bytes unless a test overrides it. */
function relayAnswer(content: string, overrides: Record<string, unknown> = {}): typeof fetch {
  const bytes = Buffer.from(content);
  return (async () => Response.json({
    version: "2026-11-09.1",
    minCliVersion: "0.0.1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
    ...overrides,
  })) as unknown as typeof fetch;
}

test("writes the text Frely serves for this CLI version", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const served = "---\nname: frely\n---\n\nServed from Frely.\n";
    const result = await installEntrySkill({ home, relayUrl: "https://relay.test", fetchFn: relayAnswer(served) });
    assert.equal(result.version, "2026-11-09.1");
    assert.equal(await readFile(join(result.path, "SKILL.md"), "utf8"), served);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("keeps the copy this CLI ships with when Frely cannot answer or the answer is not trustworthy", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-entry-")));
  try {
    const served = "---\nname: frely\n---\n\nServed.\n";
    const cases: Array<[string, typeof fetch]> = [
      ["offline", (async () => { throw new Error("offline"); }) as unknown as typeof fetch],
      ["an older server", (async () => new Response("Not found", { status: 404 })) as unknown as typeof fetch],
      ["a body that does not match its hash", relayAnswer(served, { sha256: "0".repeat(64) })],
      ["a document for a newer CLI", relayAnswer(served, { minCliVersion: "99.0.0" })],
      ["something that is not a Skill", relayAnswer("hello")],
    ];
    for (const [label, fetchFn] of cases) {
      const result = await installEntrySkill({ home, relayUrl: "https://relay.test", cliVersion: "0.23.35", fetchFn });
      assert.equal(result.version, undefined, label);
      assert.equal(await readFile(join(result.path, "SKILL.md"), "utf8"), ENTRY_SKILL, label);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("asks for the text at the entry Skill path with this CLI's version", async () => {
  const seen: string[] = [];
  const fetchFn = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}?cliVersion=${url.searchParams.get("cliVersion")}`);
    const bytes = Buffer.from("---\nname: frely\n---\n");
    return Response.json({ version: "next", minCliVersion: "0.24.0", contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
  }) as unknown as typeof fetch;
  assert.equal(await fetchEntrySkill({ relayUrl: "https://relay.test", cliVersion: "0.23.35", fetchFn }), null);
  assert.deepEqual(seen, ["/api/public/entry-skill?cliVersion=0.23.35"]);
});
