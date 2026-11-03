import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AppInstall } from "../agent/app-install.js";
import { createPiRunner, summarizeDiff } from "./pi-runner.js";
import type { RunnerContext } from "./runner.js";

async function fixture(): Promise<{ root: string; install: AppInstall }> {
  const root = await mkdtemp(join(tmpdir(), "frely-pi-"));
  const install: AppInstall = { schemaVersion: 2, appVersion: "t", capsulePath: join(root, "cap"), protocolVersion: 1, agentDir: join(root, "agent"), projectsFile: join(root, "projects.json") };
  await mkdir(join(install.agentDir, "frely"), { recursive: true });
  await writeFile(join(install.agentDir, "frely", "headless.json"), JSON.stringify({ schemaVersion: 1, url: "http://127.0.0.1:1/mcp", token: "tok", pid: 1 }));
  await writeFile(install.projectsFile, "[]");
  return { root, install };
}
const context = (cwd: string, model?: { baseUrl: string; name: string }): RunnerContext => ({
  record: { runId: "run_ABCDEFGH12345678" } as never,
  snapshot: { name: "t", command: "Fix the bug", cwd, timeoutSec: 60 } as never,
  cwd, ...(model ? { model } : {}), log: () => undefined,
});
const reply = (value: unknown, isError = false): Response => new Response(JSON.stringify({ result: { content: [{ text: typeof value === "string" ? value : JSON.stringify(value) }], isError } }));

test("summarizeDiff counts files and lines", () => {
  assert.equal(summarizeDiff(""), "No file changes.");
  assert.equal(summarizeDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n+a\n+b\n-c\n"), "1 file changed\nx.ts | +2 -1");
});

test("the pi runner starts a thread, waits and returns the answer and diff summary", async () => {
  const { root, install } = await fixture();
  try {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let polls = 0;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const { params } = JSON.parse(String(init.body)) as { params: { name: string; arguments: Record<string, unknown> } };
      calls.push({ name: params.name, args: params.arguments });
      if (params.name === "create_thread") return reply({ id: "th1" });
      polls += 1;
      return reply(polls < 2 ? { status: "running" } : { status: "completed", answer: "Done.", diff: "diff --git a/a b/a\n+x\n" });
    }) as unknown as typeof fetch;
    const runner = createPiRunner({ install: async () => install, fetchFn, sleep: async () => undefined });
    const result = await runner.execute!(context(join(root, "project"), { baseUrl: "http://127.0.0.1:9/v1", name: "qwen" }), new AbortController().signal);
    assert.equal(result.code, 0);
    assert.equal(result.patch?.answer, "Done.");
    assert.equal(result.patch?.diffSummary, "1 file changed\na | +1 -0");
    const created = calls[0]!;
    assert.equal(created.args.goal, "Fix the bug");
    assert.match(String(created.args.model), /^frely-[a-z0-9]{8}\/qwen$/u);
    // The one-run provider and the project allow-list entry are gone again.
    assert.deepEqual(JSON.parse(await readFile(install.projectsFile, "utf8")), []);
    assert.deepEqual(JSON.parse(await readFile(join(install.agentDir, "models.json"), "utf8")).providers, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the pi runner reports a missing node and a failed thread", async () => {
  const { root, install } = await fixture();
  try {
    const none = createPiRunner({ install: async () => { throw new Error("none"); } });
    assert.equal((await none.execute!(context(root), new AbortController().signal)).patch?.error?.code, "pi_unavailable");
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const name = (JSON.parse(String(init.body)) as { params: { name: string } }).params.name;
      return name === "create_thread" ? reply({ id: "th" }) : reply({ status: "failed", error: "boom", answer: "", diff: "" });
    }) as unknown as typeof fetch;
    const failed = await createPiRunner({ install: async () => install, fetchFn, sleep: async () => undefined }).execute!(context(root), new AbortController().signal);
    assert.equal(failed.code, 1);
    assert.equal(failed.patch?.error?.message, "boom");
  } finally { await rm(root, { recursive: true, force: true }); }
});
