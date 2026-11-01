import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../../controller/client.js";
import { runAgentLocal, type LocalIo } from "./command.js";
import { logPath, readRecord, workspaceOf, writeRecord, type LocalAgentRecord } from "./store.js";

function harness() {
  const out: string[] = [], err: string[] = [];
  const io: LocalIo = { out: (text) => { out.push(text); }, err: (text) => { err.push(text); }, interactive: false, readSecret: async () => "" };
  return { io, out, err, text: () => out.join(""), errors: () => err.join("") };
}
const make = (slug: string, overrides: Partial<LocalAgentRecord> = {}): LocalAgentRecord => ({
  version: 1, slug, source: "alice/" + slug, repoUrl: "https://github.com/alice/" + slug, commit: "c".repeat(40), name: slug, workspace: workspaceOf(slug),
  setup: undefined, run: "node index.js", network: [], addedAt: "2026-10-28T00:00:00Z", setupDone: true, approvals: {}, pid: undefined, startedAt: undefined, ...overrides,
});
const isolate = () => { process.env.FRELY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "frely-agents-")); };

test("with no arguments the usage lists every local command", async () => {
  const h = harness();
  assert.equal(await runAgentLocal([], h.io), EXIT.ok);
  for (const word of ["add", "start", "stop", "logs", "list", "remove", "key"]) assert.match(h.text(), new RegExp(`agent local ${word}`, "u"));
  assert.equal(await runAgentLocal(["nonsense"], harness().io), EXIT.cli);
});

test("list shows an empty state, then each Agent with its state", async () => {
  isolate();
  const empty = harness();
  assert.equal(await runAgentLocal(["list"], empty.io), EXIT.ok);
  assert.match(empty.text(), /No local Agents/u);
  await writeRecord(make("stopped-one"));
  await writeRecord(make("half", { setupDone: false }));
  const listing = harness();
  await runAgentLocal(["list"], listing.io);
  assert.match(listing.text(), /half\tnot set up/u);
  assert.match(listing.text(), /stopped-one\tstopped/u);
  const json = harness();
  await runAgentLocal(["list", "--json"], json.io);
  assert.deepEqual((JSON.parse(json.text()) as Array<{ name: string; running: boolean }>).map((item) => [item.name, item.running]), [["half", false], ["stopped-one", false]]);
});

test("remove deletes the Agent's folder and records, and nothing outside the Agents folder", async () => {
  isolate();
  const record = make("gone");
  mkdirSync(record.workspace, { recursive: true });
  writeFileSync(join(record.workspace, "x.txt"), "x");
  await writeRecord(record);
  const h = harness();
  assert.equal(await runAgentLocal(["remove", "gone"], h.io), EXIT.ok);
  assert.equal(existsSync(record.workspace), false);
  assert.equal(await readRecord("gone"), undefined);

  const outside = mkdtempSync(join(tmpdir(), "frely-precious-"));
  writeFileSync(join(outside, "keep.txt"), "keep");
  await writeRecord(make("evil", { workspace: outside }));
  const refused = harness();
  assert.equal(await runAgentLocal(["remove", "evil"], refused.io), EXIT.cli);
  assert.match(refused.errors(), /Refusing to delete/u);
  assert.equal(existsSync(join(outside, "keep.txt")), true);
});

test("start and stop say what is wrong with an Agent that is missing, half set up or not running", async () => {
  isolate();
  const missing = harness();
  assert.equal(await runAgentLocal(["start", "nope"], missing.io), EXIT.cli);
  assert.match(missing.errors(), /No local Agent named nope/u);
  await writeRecord(make("half", { setupDone: false }));
  const half = harness();
  assert.equal(await runAgentLocal(["start", "half"], half.io), EXIT.cli);
  assert.match(half.errors(), /not set up yet.*add again/u);
  await writeRecord(make("idle"));
  const idle = harness();
  assert.equal(await runAgentLocal(["stop", "idle"], idle.io), EXIT.ok);
  assert.match(idle.text(), /not running/u);
  assert.equal(await runAgentLocal(["start", "../etc"], harness().io), EXIT.cli);
});

test("logs prints the tail of what the Agent wrote", async () => {
  isolate();
  await writeRecord(make("talker"));
  writeFileSync(logPath("talker"), Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const h = harness();
  assert.equal(await runAgentLocal(["logs", "talker", "--lines", "3"], h.io), EXIT.ok);
  assert.match(h.text(), /line 7\nline 8\nline 9/u);
  assert.ok(!h.text().includes("line 6"));
  assert.equal(await runAgentLocal(["logs", "talker", "--lines", "0"], harness().io), EXIT.cli);
});

test("add refuses an address that is not a Frely Agent or a public GitHub repository", async () => {
  isolate();
  const h = harness();
  assert.equal(await runAgentLocal(["add", "http://example.com/x.git"], h.io), EXIT.cli);
  assert.match(h.errors(), /Frely Agent name.*public GitHub address/u);
});
