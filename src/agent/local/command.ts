import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectAuth, normalizeRelayUrl, requireLogin } from "../../auth.js";
import { cliLaunchArguments } from "../../cli-launch.js";
import { credentialStore } from "../../credential-store.js";
import { ControllerError, EXIT } from "../../controller/client.js";
import { restrictSandboxNetwork, sandboxUnavailableReason, shutdownSandbox } from "../../runtime/sandbox.js";
import { approveSites, type ApprovalDeps } from "./approvals.js";
import { API_KEY_SERVICE, agentEnv, gatewayOrigin, readApiKey, spawnConfined } from "./confine.js";
import { parseManifest } from "./manifest.js";
import { download, githubUrl, parseSource, resolveRegisteredRepo, type AgentSource } from "./source.js";
import {
  SLUG, agentsRoot, approvedHosts, assertSlug, insideAgentsRoot, isRunning, listRecords, logPath, readRecord, removeRecordFiles, stateDir, workspaceOf, writeRecord,
  type LocalAgentRecord,
} from "./store.js";
import { superviseAgent } from "./supervisor.js";

export interface LocalIo {
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
  readSecret(): Promise<string>;
}

export const LOCAL_USAGE = `Usage:
  frely agent local add <username/name | https://github.com/owner/repo> [--name <folder-name>]
  frely agent local start <name> [--foreground]
  frely agent local stop <name>
  frely agent local logs <name> [--lines <n>] [--follow]
  frely agent local list [--json]
  frely agent local remove <name>
  frely agent local key --api-key-stdin | --clear
`;

const fail = (message: string, code: number = EXIT.cli): never => { throw new ControllerError(message, code); };
const flag = (args: readonly string[], name: string): boolean => args.includes(name);
function value(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) return fail(`${name} needs a value.`);
  return next;
}
const positional = (args: readonly string[]): string[] => args.filter((arg, index) => !arg.startsWith("--") && !(index > 0 && ["--name", "--lines"].includes(args[index - 1]!)));

/** Runs `frely agent local ...`; returns the exit code. */
export async function runAgentLocal(args: readonly string[], io: LocalIo, deps: ApprovalDeps = {}): Promise<number> {
  try {
    const [action, ...rest] = args;
    switch (action) {
      case "add": return await add(rest, io, deps);
      case "start": return await start(rest, io, deps);
      case "stop": return await stop(rest, io);
      case "logs": return await logs(rest, io);
      case "list": return await list(rest, io);
      case "remove": return await remove(rest, io);
      case "key": return await key(rest, io);
      case "supervise": return await superviseAgent(rest[0] ?? "");
      default: io.out(LOCAL_USAGE); return action === undefined ? EXIT.ok : EXIT.cli;
    }
  } catch (error) {
    if (error instanceof ControllerError) { io.err(error.message + "\n"); return error.exitCode; }
    io.err((error instanceof Error ? error.message : String(error)) + "\n");
    return EXIT.cli;
  }
}

function slugFor(source: AgentSource, requested: string | undefined, manifestName: string | undefined): string {
  const raw = requested ?? (source.kind === "frely" ? source.name : source.repo);
  const slug = raw.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 63);
  if (!SLUG.test(slug)) return fail(`Could not make a folder name from ${JSON.stringify(manifestName ?? raw)}. Pass --name <letters-digits-dashes>.`);
  return slug;
}

async function add(args: string[], io: LocalIo, deps: ApprovalDeps): Promise<number> {
  const [target] = positional(args);
  if (!target) return fail(LOCAL_USAGE);
  const source = parseSource(target);
  const requested = value(args, "--name");
  if (requested !== undefined) assertSlug(requested);
  const relayUrl = normalizeRelayUrl((await inspectAuth().catch(() => null))?.relayUrl);
  const unavailable = sandboxUnavailableReason();
  if (unavailable) return fail(`Agents run on this computer only inside the Frely sandbox, and it cannot run here (${unavailable}). On Linux install bubblewrap, socat and ripgrep; Windows is not supported.`, EXIT.tool);

  // Resume an Agent whose setup was interrupted (for example by an approval link) instead of downloading it again.
  const existing = (await listRecords()).find((item) => !item.setupDone && item.source === target && (requested === undefined || item.slug === requested));
  let record: LocalAgentRecord;
  if (existing) {
    record = existing;
  } else {
    const registered = source.kind === "frely" ? await resolveRegisteredRepo(source.user, source.name, relayUrl) : undefined;
    const repoUrl = registered?.repoUrl ?? githubUrl(source as { owner: string; repo: string });
    const slug = slugFor(source, requested, registered?.name);
    if (await readRecord(slug)) return fail(`${slug} is already on this computer. Remove it first with frely agent local remove ${slug}, or pick another --name.`);
    const workspace = workspaceOf(slug);
    if (await stat(workspace).then(() => true, () => false)) return fail(`${workspace} already exists. Pick another --name or move that folder away.`);
    io.err(`Downloading ${repoUrl}${registered?.commit ? ` at ${registered.commit.slice(0, 8)}` : ""}…\n`);
    const commit = await download(repoUrl, workspace, registered?.commit).catch(async (error: unknown) => { await rm(workspace, { recursive: true, force: true }); throw error; });
    let manifest;
    try { manifest = parseManifest(await readFile(`${workspace}/frely.yaml`, "utf8").catch(() => fail("The repository has no frely.yaml, so it cannot run through Frely."))); }
    catch (error) { await rm(workspace, { recursive: true, force: true }); throw error; }
    record = { version: 1, slug, source: target, repoUrl, commit, name: manifest.name ?? registered?.name ?? slug, workspace, setup: manifest.setup, run: manifest.run, network: [...manifest.network],
      addedAt: new Date().toISOString(), setupDone: false, approvals: {}, pid: undefined, startedAt: undefined };
    await writeRecord(record);
  }

  io.out(`${record.name} (${record.repoUrl} at ${record.commit.slice(0, 8)})\n  runs: ${record.run}\n${record.setup ? `  setup: ${record.setup}\n` : ""}  folder: ${record.workspace}\n`);
  io.out(`  can reach: Frely's API${record.network.length ? `, and after your approval ${record.network.join(", ")}` : " only"}\n`);
  record = await withApprovals(record, io, deps);

  if (record.setup && !record.setupDone) {
    io.err(`Running setup inside the sandbox: ${record.setup}\n`);
    const code = await runSetup(record, relayUrl, io);
    if (code !== 0) return fail(`Setup failed (exit ${code}). Fix it or remove the Agent with frely agent local remove ${record.slug}, then run add again.`, EXIT.tool);
  }
  await writeRecord({ ...record, setupDone: true });
  io.out(`Added. Start it with: frely agent local start ${record.slug}\n`);
  return EXIT.ok;
}

async function withApprovals(record: LocalAgentRecord, io: LocalIo, deps: ApprovalDeps): Promise<LocalAgentRecord> {
  // When the owner has not answered yet this throws and keeps the download, so the same command carries on from here.
  const gained = await approveSites(record, io, deps);
  if (Object.keys(gained).length === 0) return record;
  const next = { ...record, approvals: { ...record.approvals, ...gained } };
  await writeRecord(next);
  return next;
}

async function runSetup(record: LocalAgentRecord, relayUrl: string, io: LocalIo): Promise<number> {
  restrictSandboxNetwork({ allowedDomains: [new URL(gatewayOrigin(relayUrl)).hostname, ...approvedHosts(record)] });
  await mkdir(`${record.workspace}/.cache`, { recursive: true });
  try {
    const { child, violations } = await spawnConfined(record.setup!, record.workspace, agentEnv(record.workspace, { model: false }));
    child.stdout?.on("data", (data: Buffer) => io.err(data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => io.err(data.toString("utf8")));
    const code = await new Promise<number>((done) => { child.once("error", () => done(1)); child.once("close", (exit: number | null) => done(exit ?? 1)); });
    const blocked = violations();
    if (code !== 0 && blocked.length > 0) io.err(`The sandbox blocked:\n${[...new Set(blocked)].slice(0, 10).join("\n")}\nIf a site is missing, the Agent's author needs to list it under local.network in frely.yaml.\n`);
    return code;
  } finally {
    await shutdownSandbox();
  }
}

async function start(args: string[], io: LocalIo, deps: ApprovalDeps): Promise<number> {
  const [slug] = positional(args);
  if (!slug) return fail("Usage: frely agent local start <name> [--foreground]");
  assertSlug(slug);
  let record = await readRecord(slug) ?? fail(`No local Agent named ${slug}. See frely agent local list.`);
  if (!record.setupDone) return fail(`${slug} was not set up yet. Run frely agent local add again to finish.`);
  if (isRunning(record)) return fail(`${slug} is already running (process ${record.pid}). Stop it first to apply new approvals.`);
  record = await withApprovals(record, io, deps);
  await preflight(record);
  if (flag(args, "--foreground")) return superviseAgent(slug);

  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  let supervisor: number | undefined;
  const log = openSync(logPath(slug), "a", 0o600);
  try {
    const launch = cliLaunchArguments(fileURLToPath(new URL("../../index.js", import.meta.url)), ["agent", "local", "supervise", slug]);
    const child = spawn(launch[0]!, launch.slice(1), { detached: true, stdio: ["ignore", log, log], env: process.env, windowsHide: true });
    child.unref();
    supervisor = child.pid;
  } finally { closeSync(log); }
  // The supervisor records its own process id once the Agent is up; wait briefly so a failed start is reported here.
  for (let waited = 0; waited < 15_000; waited += 250) {
    await new Promise((done) => setTimeout(done, 250));
    const current = await readRecord(slug);
    if (current && isRunning(current)) { io.out(`${slug} is running. Logs: frely agent local logs ${slug}\n`); return EXIT.ok; }
    if (supervisor === undefined || !isRunning({ pid: supervisor })) {
      const tail = (await readFile(logPath(slug), "utf8").catch(() => "")).trim().split("\n").slice(-6).join("\n");
      return fail(`${slug} did not start:\n${tail}`, EXIT.tool);
    }
  }
  return fail(`${slug} did not report that it started. See frely agent local logs ${slug}.`, EXIT.tool);
}

/** The two things a start needs besides the download: a login and a key for the model calls. Said now, not in a log file. */
async function preflight(record: LocalAgentRecord): Promise<void> {
  const login = await requireLogin().catch(() => fail("Frely login is required. Run `frely login`."));
  if (!await readApiKey(gatewayOrigin(login.config.relayUrl))) {
    fail(`${record.slug} needs a Frely API key for its model calls. Create one at ${login.config.relayUrl}/user/keys, then run: frely agent local key --api-key-stdin`);
  }
}

async function stop(args: string[], io: LocalIo): Promise<number> {
  const [slug] = positional(args);
  if (!slug) return fail("Usage: frely agent local stop <name>");
  assertSlug(slug);
  const record = await readRecord(slug) ?? fail(`No local Agent named ${slug}.`);
  if (!isRunning(record)) { io.out(`${slug} is not running.\n`); return EXIT.ok; }
  process.kill(record.pid!, "SIGTERM");
  for (let waited = 0; waited < 8000 && isRunning(record); waited += 200) await new Promise((done) => setTimeout(done, 200));
  if (isRunning(record)) { try { process.kill(record.pid!, "SIGKILL"); } catch { /* already gone */ } }
  await writeRecord({ ...record, pid: undefined, startedAt: undefined });
  io.out(`${slug} stopped.\n`);
  return EXIT.ok;
}

async function logs(args: string[], io: LocalIo): Promise<number> {
  const [slug] = positional(args);
  if (!slug) return fail("Usage: frely agent local logs <name> [--lines <n>] [--follow]");
  assertSlug(slug);
  if (!await readRecord(slug)) return fail(`No local Agent named ${slug}.`);
  const lines = Number(value(args, "--lines") ?? 100);
  if (!Number.isInteger(lines) || lines < 1 || lines > 10_000) return fail("--lines must be 1 to 10000.");
  const text = await readFile(logPath(slug), "utf8").catch(() => "");
  const all = text.split("\n");
  io.out(all.slice(-lines - 1).join("\n"));
  if (!flag(args, "--follow")) return EXIT.ok;
  let offset = Buffer.byteLength(text);
  for (;;) {
    await new Promise((done) => setTimeout(done, 1000));
    const size = (await stat(logPath(slug)).catch(() => undefined))?.size ?? 0;
    if (size > offset) {
      const handle = await readFile(logPath(slug));
      io.out(handle.subarray(offset).toString("utf8"));
      offset = size;
    }
  }
}

async function list(args: string[], io: LocalIo): Promise<number> {
  const records = await listRecords();
  if (flag(args, "--json")) {
    io.out(JSON.stringify(records.map((r) => ({ name: r.slug, title: r.name, source: r.source, commit: r.commit, workspace: r.workspace, running: isRunning(r), setupDone: r.setupDone, sites: r.network, approved: approvedHosts(r) })), null, 2) + "\n");
    return EXIT.ok;
  }
  if (records.length === 0) { io.out(`No local Agents. Add one with frely agent local add <username/name>. They live under ${agentsRoot()}.\n`); return EXIT.ok; }
  io.out(records.map((r) => `${r.slug}\t${isRunning(r) ? "running" : r.setupDone ? "stopped" : "not set up"}\t${r.source}\t${r.commit.slice(0, 8)}`).join("\n") + "\n");
  return EXIT.ok;
}

async function remove(args: string[], io: LocalIo): Promise<number> {
  const [slug] = positional(args);
  if (!slug) return fail("Usage: frely agent local remove <name>");
  assertSlug(slug);
  const record = await readRecord(slug) ?? fail(`No local Agent named ${slug}.`);
  if (isRunning(record)) await stop([slug], io);
  if (!insideAgentsRoot(record.workspace)) return fail(`Refusing to delete ${record.workspace}: it is not inside ${agentsRoot()}.`);
  await rm(record.workspace, { recursive: true, force: true });
  await removeRecordFiles(slug);
  io.out(`${slug} removed, with its folder ${record.workspace}.\n`);
  return EXIT.ok;
}

async function key(args: string[], io: LocalIo): Promise<number> {
  const origin = gatewayOrigin((await requireLogin().catch(() => fail("Frely login is required. Run `frely login`."))).config.relayUrl);
  if (flag(args, "--clear")) { await credentialStore.deletePassword(API_KEY_SERVICE, origin); io.out("The saved API key was removed.\n"); return EXIT.ok; }
  if (!flag(args, "--api-key-stdin")) return fail("Usage: frely agent local key --api-key-stdin | --clear");
  const secret = await io.readSecret();
  if (Buffer.byteLength(secret, "utf8") < 8 || Buffer.byteLength(secret, "utf8") > 8192 || /[\x00-\x20\x7f]/u.test(secret)) return fail("The API key is invalid.");
  await credentialStore.setPassword(API_KEY_SERVICE, origin, secret);
  io.out("The API key was saved in this computer's secure storage. Local Agents use it for their model calls.\n");
  return EXIT.ok;
}

