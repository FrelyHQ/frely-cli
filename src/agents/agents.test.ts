import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { EXIT } from "../controller/client.js";
import { buildDefinition, RUNNERS, saveDefinition } from "../task/definition.js";
import { startTask, waitForTaskRun, type ManagerDeps } from "../task/manager.js";
import { readTaskRun } from "../task/run-store.js";
import { executeTaskRun, registerRunner } from "../task/worker.js";
import { runAgentCommand, type AgentCommandIo } from "./command.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { agentDoctor, formatAgentDoctor } from "./doctor.js";
import { findBinary } from "./detect.js";
import { piAdapter } from "./pi.js";
import { AGENT_IDS, AGENTS, agentStatus, defaultAgentId, getAgent, isAgentId, listAgentStatuses } from "./registry.js";
import { createAgentRunner, promptOf, summarizeDiff } from "./runner.js";

let root: string;
let previousSandbox: string | undefined;
before(async () => { root = await mkdtemp(join(tmpdir(), "frely-agents-test-")); previousSandbox = process.env.FRELY_SANDBOX; process.env.FRELY_SANDBOX = "off"; });
beforeEach(async () => { process.env.XDG_CONFIG_HOME = await mkdtemp(join(root, "config-")); });
after(async () => { if (previousSandbox === undefined) delete process.env.FRELY_SANDBOX; else process.env.FRELY_SANDBOX = previousSandbox; await rm(root, { recursive: true, force: true }); });

const none = async () => ({ installed: false });
const present = (...ids: string[]) => async (binary: string) => (ids.some((id) => getAgent(id).binary === binary) ? { installed: true, path: `/bin/${binary}`, version: "1.0.0" } : { installed: false });

test("the registry is the one list of agents, and task runners come from it", () => {
  assert.deepEqual(AGENT_IDS, ["pi", "codex", "claude-code"]);
  assert.deepEqual([...RUNNERS], ["script", "pi", "codex", "claude-code"]);
  assert.equal(isAgentId("codex"), true);
  assert.equal(isAgentId("script"), false);
  assert.throws(() => getAgent("gemini"), /Unknown agent "gemini"\. Use pi, codex, claude-code\./u);
  assert.ok(AGENTS.every((agent) => agent.kind === "coding-agent" && agent.capabilities.run));
});

test("status says when an agent is missing and how to install it; the default agent is the first one installed", async () => {
  const missing = await agentStatus(piAdapter, none);
  assert.equal(missing.installed, false);
  assert.match(missing.install ?? "", /Install Pi/u);
  assert.equal((await listAgentStatuses(present("codex"))).filter((item) => item.installed).map((item) => item.id).join(), "codex");
  assert.equal(await defaultAgentId(present("codex", "claude-code")), "codex");
  assert.equal(await defaultAgentId(none), "pi");
});

test("findBinary finds an executable on PATH and nothing else", async () => {
  const dir = await mkdtemp(join(root, "bin-"));
  await writeFile(join(dir, "frely-fake-agent"), "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
  assert.equal(await findBinary("frely-fake-agent", { PATH: dir }, join(root, "nohome")), join(dir, "frely-fake-agent"));
  assert.equal(await findBinary("frely-no-such-agent", { PATH: dir }, join(root, "nohome")), undefined);
});

test("adapters build non-interactive commands and read their output", () => {
  assert.deepEqual(piAdapter.runArguments({ model: "m", outputFile: "/tmp/o" }), ["-p", "--no-session", "--model", "m"]);
  assert.deepEqual(piAdapter.parseOutput("[frely] noise\nthe answer\n"), { answer: "the answer" });
  const codex = codexAdapter.runArguments({ model: "gpt", outputFile: "/tmp/o" });
  assert.deepEqual([codex[0], codex.at(-1), codex[codex.indexOf("-o") + 1], codex[codex.indexOf("-m") + 1]], ["exec", "-", "/tmp/o", "gpt"]);
  assert.deepEqual(codexAdapter.runArguments({ resume: "t1", outputFile: "/tmp/o" }).slice(0, 3), ["exec", "resume", "t1"]);
  assert.deepEqual(codexAdapter.parseOutput('{"type":"thread.started","thread_id":"th_1"}\n', " done \n"), { answer: "done", sessionId: "th_1" });
  assert.deepEqual(claudeCodeAdapter.runArguments({ resume: "s1", outputFile: "/tmp/o" }).slice(0, 3), ["-p", "--output-format", "json"]);
  assert.deepEqual(claudeCodeAdapter.parseOutput('[frely] x\n{"type":"result","result":"fine","session_id":"s1"}\n'), { answer: "fine", sessionId: "s1" });
  assert.deepEqual(claudeCodeAdapter.parseOutput("plain text\n"), { answer: "plain text" });
});

test("doctor agent is read-only, names the fix, and fails only for a named agent that is missing", async () => {
  const all = await agentDoctor(undefined, present("pi"));
  assert.equal(all.ok, true);
  assert.match(formatAgentDoctor(all), /frely agent setup pi/u);
  assert.match(formatAgentDoctor(all), /miss {2}codex {2}not installed\n\s+Install Codex/u);
  assert.equal((await agentDoctor("codex", none)).ok, false);
  assert.equal((await agentDoctor(undefined, none)).ok, false);
  await assert.rejects(agentDoctor("nope", none), /Unknown agent/u);
});

test("prompt text is the task, then the caller's request", () => {
  assert.equal(promptOf({ command: "Fix it" }), "Fix it");
  assert.equal(promptOf({ command: "Fix it", input: "now" }), "Fix it\n\nRequest from the caller:\nnow");
  assert.equal(summarizeDiff(""), "No file changes.");
  assert.equal(summarizeDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n+a\n+b\n-c\n"), "1 file changed\nx.ts | +2 -1");
});

/** A program that stands in for an agent: prints what it was given on stdin and its arguments to a file the test reads. */
async function fakeAgent(body: string): Promise<string> {
  const dir = await mkdtemp(join(root, "fake-"));
  const path = join(dir, "agent");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}
const inProcess = (jobs: Promise<void>[] = []): ManagerDeps => ({ spawnWorker: (runId) => { jobs.push(executeTaskRun(runId)); } });

async function runWith(adapter: typeof codexAdapter, program: string, folder: string, extra: Partial<Parameters<typeof buildDefinition>[0]> = {}) {
  registerRunner(createAgentRunner(adapter, { find: async () => program }));
  await saveDefinition(buildDefinition({ name: "t", runner: adapter.id, command: "Say hi", cwd: folder, ...extra }));
  const started = await startTask("t", {}, inProcess());
  return waitForTaskRun(started.runId, 20_000, 50);
}

test("a codex task sends the prompt on stdin and returns the last message from the output file", async () => {
  const folder = await mkdtemp(join(root, "work-"));
  const seen = join(folder, "..", "seen-codex.txt");
  const program = await fakeAgent(`out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done; cat > ${seen}; printf 'hello from codex' > "$out"`);
  const record = await runWith(codexAdapter, program, folder, { model: "my-model" });
  assert.equal(record.status, "completed", JSON.stringify(record.error));
  assert.equal(record.answer, "hello from codex");
  assert.equal((await readFile(seen, "utf8")), "Say hi");
  assert.equal(record.snapshot.model, "my-model");
  assert.equal(record.modelUsed, undefined, "an agent's own model is not routed through the model proxy");
});

test("a claude-code task reads the JSON result, and an agent that prints nothing is a failure to say so", async () => {
  const folder = await mkdtemp(join(root, "work-"));
  const record = await runWith(claudeCodeAdapter, await fakeAgent(`cat > /dev/null; echo '{"type":"result","result":"done it","session_id":"s9"}'`), folder);
  assert.equal(record.status, "completed");
  assert.equal(record.answer, "done it");
  const quiet = await runWith(piAdapter, await fakeAgent("cat > /dev/null"), folder);
  assert.equal(quiet.error?.code, "no_answer");
});

test("a missing agent fails the run with the vendor's install command", async () => {
  const folder = await mkdtemp(join(root, "work-"));
  registerRunner(createAgentRunner(codexAdapter, { find: async () => undefined }));
  await saveDefinition(buildDefinition({ name: "t", runner: "codex", command: "x", cwd: folder }));
  const record = await waitForTaskRun((await startTask("t", {}, inProcess())).runId, 20_000, 50);
  assert.equal(record.status, "failed");
  assert.match(record.error?.message ?? "", /Codex is not installed.*npm i -g @openai\/codex/u);
});

function repo(): string {
  const dir = join(root, `repo-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start"]);
  return dir;
}

test("a worktree run keeps the agent's changes in a worktree and reports a diff; the task folder stays untouched", async () => {
  const folder = repo();
  const record = await runWith(piAdapter, await fakeAgent(`cat > /dev/null; echo changed > new-file.txt; echo done`), folder, { worktree: true });
  assert.equal(record.status, "completed", JSON.stringify(record.error));
  assert.equal(record.answer, "done");
  assert.match(record.diffSummary ?? "", /1 file changed\nnew-file\.txt \| \+1 -0/u);
  assert.ok(record.worktreePath && existsSync(join(record.worktreePath, "new-file.txt")));
  assert.equal(existsSync(join(folder, "new-file.txt")), false);
});

test("a read run drops its worktree, a none run uses an empty folder, a worktree needs a git folder", async () => {
  const folder = repo();
  registerRunner(createAgentRunner(piAdapter, { find: async () => await fakeAgent(`cat > /dev/null; pwd > ${join(root, "cwd.txt")}; echo x > scratch.txt; echo ok`) }));
  await saveDefinition(buildDefinition({ name: "t", runner: "pi", command: "x", cwd: folder }));
  const read = await waitForTaskRun((await startTask("t", { workspace: "read" }, inProcess())).runId, 20_000, 50);
  assert.equal(read.status, "completed", JSON.stringify(read.error));
  assert.equal(read.diffSummary, undefined);
  assert.equal(read.worktreePath, undefined);
  const none = await waitForTaskRun((await startTask("t", { workspace: "none" }, inProcess())).runId, 20_000, 50);
  assert.equal(none.status, "completed");
  assert.notEqual((await readFile(join(root, "cwd.txt"), "utf8")).trim().replace("/private", ""), folder);
  const plain = await mkdtemp(join(root, "plain-"));
  await saveDefinition(buildDefinition({ name: "t", runner: "pi", command: "x", cwd: plain, worktree: true }));
  const bad = await waitForTaskRun((await startTask("t", {}, inProcess())).runId, 20_000, 50);
  assert.equal(bad.status, "failed");
  assert.match(bad.error?.message ?? "", /must be a git repository/u);
  assert.ok(await readTaskRun(bad.runId));
});

function io() {
  const out: string[] = [], err: string[] = [];
  const value: AgentCommandIo = { out: (text) => { out.push(text); }, err: (text) => { err.push(text); }, interactive: false, readSecret: async () => "" };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

test("frely agent list|status|run say what is installed and refuse what cannot run", async () => {
  const h = io();
  assert.equal(await runAgentCommand(["list"], h.io, { detect: present("pi") }), 0);
  assert.match(h.out(), /pi\tinstalled 1\.0\.0/u);
  assert.match(h.out(), /codex\tnot installed/u);
  const json = io();
  await runAgentCommand(["list", "--json"], json.io, { detect: present("pi") });
  assert.deepEqual((JSON.parse(json.out()) as { agents: Array<{ id: string }> }).agents.map((item) => item.id), AGENT_IDS);
  const status = io();
  assert.equal(await runAgentCommand(["status", "codex"], status.io, { detect: none }), EXIT.tool, "a missing agent is a tool failure exit code");
  assert.match(status.out(), /npm i -g @openai\/codex/u);
  const unknown = io();
  assert.notEqual(await runAgentCommand(["status", "gemini"], unknown.io, { detect: none }), 0);
  assert.match(unknown.err(), /Unknown agent/u);
  const run = io();
  assert.notEqual(await runAgentCommand(["run", "codex", "do it"], run.io, { detect: none }), 0);
  assert.match(run.err(), /Codex is not installed/u);
  const usage = io();
  assert.notEqual(await runAgentCommand(["run", "codex"], usage.io, { detect: present("codex") }), 0);
  assert.match(usage.err(), /Usage: frely agent run/u);
  const help = io();
  assert.equal(await runAgentCommand([], help.io), 0);
  assert.match(help.out(), /frely agent run <id>/u);
});

test("frely agent run saves one task per agent, starts it and can wait for the answer", async () => {
  const folder = await mkdtemp(join(root, "work-"));
  registerRunner(createAgentRunner(piAdapter, { find: async () => await fakeAgent("cat > /dev/null; echo ran") }));
  const h = io();
  const jobs: Promise<void>[] = [];
  const code = await runAgentCommand(["run", "pi", "list the files", "--cwd", folder, "--wait", "--wait-sec", "20"], h.io, { detect: present("pi"), manager: inProcess(jobs) });
  await Promise.all(jobs);
  assert.equal(code, 0, h.err());
  const printed = JSON.parse(h.out()) as { status: string; answer: string; runner: string };
  assert.deepEqual([printed.status, printed.answer, printed.runner], ["completed", "ran", "pi"]);
});

test("frely agent setup puts the Frely Skill in .agents/skills once, for one agent or for whoever is installed", async () => {
  const home = await mkdtemp(join(root, "home-"));
  {
    const h = io();
    assert.equal(await runAgentCommand(["setup", "codex", "--json"], h.io, { detect: present("codex"), home }), 0, h.err());
    const done = JSON.parse(h.out()) as { skill: string; agents: string[] };
    assert.equal(done.skill, join(home, ".agents", "skills", "frely"));
    assert.deepEqual(done.agents, ["codex"]);
    assert.ok(existsSync(join(done.skill, "SKILL.md")));
    const all = io();
    assert.equal(await runAgentCommand(["setup", "--json"], all.io, { detect: present("pi", "claude-code"), home }), 0, all.err());
    assert.deepEqual((JSON.parse(all.out()) as { agents: string[] }).agents, ["pi", "claude-code"]);
    const refused = io();
    assert.notEqual(await runAgentCommand(["setup", "pi", "--gateway"], refused.io, { detect: present("pi"), home }), 0);
    assert.match(refused.err(), /--gateway needs one agent: codex or claude-code/u);
    const noId = io();
    assert.notEqual(await runAgentCommand(["setup", "--gateway"], noId.io, { detect: none, home }), 0);
  }
});

test("task local add --agent defines an agent task with the agent's own sites and a plain-text prompt", async () => {
  const folder = await mkdtemp(join(root, "work-"));
  const { runTaskCommand } = await import("../task/command.js");
  const { getDefinition } = await import("../task/definition.js");
  const h = io();
  assert.equal(await runTaskCommand(["add", "fix-it", "--agent", "codex", "--net", "github.com", "--cwd", folder, "--", "Fix", "the", "bug", "in", "'main'"], h.io), 0, h.err());
  const definition = await getDefinition("fix-it");
  assert.deepEqual([definition?.runner, definition?.command, definition?.worktree], ["codex", "Fix the bug in 'main'", true]);
  assert.deepEqual([...(definition?.network ?? [])].sort(), ["api.openai.com", "chatgpt.com", "github.com"]);
  const bad = io();
  assert.notEqual(await runTaskCommand(["add", "x", "--agent", "gemini", "--cwd", folder, "--", "hi"], bad.io), 0);
  assert.match(bad.err(), /Unknown agent/u);
});
