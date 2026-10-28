import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { approvedHosts, assertSlug, insideAgentsRoot, isRunning, listRecords, readRecord, removeRecordFiles, socketPath, writeRecord, workspaceOf, type LocalAgentRecord } from "./store.js";

const make = (slug: string, overrides: Partial<LocalAgentRecord> = {}): LocalAgentRecord => ({
  version: 1, slug, source: "alice/" + slug, repoUrl: "https://github.com/alice/" + slug, commit: "b".repeat(40), name: slug, workspace: workspaceOf(slug),
  setup: undefined, run: "node index.js", network: ["pypi.org"], addedAt: "2026-10-28T00:00:00Z", setupDone: true, approvals: {}, pid: undefined, startedAt: undefined, ...overrides,
});

test("records round-trip outside the Agent's folder and list in name order", async () => {
  process.env.FRELY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "frely-agents-"));
  await writeRecord(make("b-agent"));
  await writeRecord(make("a-agent", { approvals: { "pypi.org": "2030-01-01T00:00:00Z" } }));
  assert.deepEqual((await listRecords()).map((item) => item.slug), ["a-agent", "b-agent"]);
  assert.equal((await readRecord("a-agent"))?.approvals["pypi.org"], "2030-01-01T00:00:00Z");
  assert.equal(await readRecord("missing"), undefined);
  await removeRecordFiles("a-agent");
  assert.equal(await readRecord("a-agent"), undefined);
});

test("slugs cannot climb out of the folders they name", () => {
  for (const bad of ["", "..", "../x", "a/b", "A", "-a", "a b", "x".repeat(64)]) assert.throws(() => assertSlug(bad), /lower-case/u, bad);
  assertSlug("my-agent-2");
});

test("only approvals that have not ended count, and only for sites the Agent listed", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const item = make("x", { network: ["a.example.com", "b.example.com", "c.example.com"], approvals: { "a.example.com": "2026-10-28T13:00:00Z", "b.example.com": "2026-10-28T11:00:00Z", "z.example.com": "2030-01-01T00:00:00Z" } });
  assert.deepEqual(approvedHosts(item, now), ["a.example.com"]);
});

test("removal is limited to folders inside the Agents folder", () => {
  process.env.FRELY_AGENTS_DIR = "/home/u/frely-agents";
  assert.equal(insideAgentsRoot("/home/u/frely-agents/helper"), true);
  assert.equal(insideAgentsRoot("/home/u/frely-agents"), false);
  assert.equal(insideAgentsRoot("/home/u/frely-agents-evil/helper"), false);
  assert.equal(insideAgentsRoot("/home/u/frely-agents/../.ssh"), false);
  assert.equal(insideAgentsRoot("/home/u"), false);
});

test("a process id decides whether an Agent is running, and socket paths stay short", () => {
  assert.equal(isRunning({ pid: undefined }), false);
  assert.equal(isRunning({ pid: process.pid }), true);
  assert.ok(socketPath("a-rather-long-agent-name-that-goes-on-and-on-and-on").length < 90 || process.env.XDG_RUNTIME_DIR !== undefined);
});
