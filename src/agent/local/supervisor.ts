import { requireLogin } from "../../auth.js";
import { terminateProcessTree } from "../../runtime/process-tree.js";
import { restrictSandboxNetwork, shutdownSandbox } from "../../runtime/sandbox.js";
import { agentEnv, gatewayOrigin, readApiKey, spawnConfined } from "./confine.js";
import { MODEL_HOST, startModelProxy } from "./model-proxy.js";
import { approvedHosts, readRecord, socketPath, writeRecord } from "./store.js";

export class SupervisorError extends Error {
  constructor(message: string) { super(message); this.name = "SupervisorError"; }
}

/**
 * Runs one Agent until it exits or this process is told to stop: the model proxy on a Unix socket, then the Agent's `local.run`
 * inside the sandbox with only Frely's gateway, the proxy name and the approved sites reachable. Everything the program prints goes to
 * this process's output, which `frely agent local start` points at the Agent's log file.
 */
export async function superviseAgent(slug: string): Promise<number> {
  const record = await readRecord(slug);
  if (!record) throw new SupervisorError(`No local Agent named ${slug}. Add it with frely agent local add.`);
  if (!record.setupDone) throw new SupervisorError(`${slug} was not set up yet. Run frely agent local add again to finish.`);
  const login = await requireLogin().catch(() => { throw new SupervisorError("Frely login is required. Run `frely login`."); });
  const origin = gatewayOrigin(login.config.relayUrl);
  const apiKey = await readApiKey(origin);
  if (!apiKey) throw new SupervisorError(`${slug} needs a Frely API key for its model calls. Create one at ${login.config.relayUrl}/user/keys, then run: frely agent local key --api-key-stdin`);

  const sites = approvedHosts(record);
  const skipped = record.network.filter((host) => !sites.includes(host));
  if (skipped.length > 0) process.stderr.write(`Not approved, so blocked: ${skipped.join(", ")}. Run frely agent local start ${slug} again to ask.\n`);
  const socket = socketPath(slug);
  restrictSandboxNetwork({ allowedDomains: [new URL(origin).hostname, MODEL_HOST, ...sites], mitmProxy: { socketPath: socket, domains: [MODEL_HOST] } });
  const proxy = await startModelProxy({ socketPath: socket, upstream: origin, authorization: async () => `Bearer ${apiKey}` });
  let confined;
  try {
    confined = await spawnConfined(record.run, record.workspace, agentEnv(record.workspace, { model: true }));
  } catch (error) {
    await proxy.close();
    await shutdownSandbox();
    throw error;
  }
  const { child } = confined;
  child.stdout?.pipe(process.stdout, { end: false });
  child.stderr?.pipe(process.stderr, { end: false });
  await writeRecord({ ...record, pid: process.pid, startedAt: new Date().toISOString() });
  process.stderr.write(`[frely] ${slug} started${sites.length ? `; sites: ${sites.join(", ")}` : ""}\n`);

  const stop = () => { void terminateProcessTree(child); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const code = await new Promise<number>((done) => { child.once("error", () => done(1)); child.once("close", (exit) => done(exit ?? 1)); });
  const blocked = confined.violations();
  if (blocked.length > 0) process.stderr.write(`[frely] The sandbox blocked:\n${[...new Set(blocked)].slice(0, 10).join("\n")}\n`);
  await proxy.close();
  await shutdownSandbox();
  const latest = await readRecord(slug);
  if (latest) await writeRecord({ ...latest, pid: undefined, startedAt: undefined });
  process.stderr.write(`[frely] ${slug} stopped (exit ${code}).\n`);
  return code;
}

