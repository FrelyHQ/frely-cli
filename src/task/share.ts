import { createServer } from "node:net";
import { createInterface } from "node:readline/promises";
import { accountServiceControl, type ServiceControl } from "../share/service-control.js";
import { listLocalServices, removeLocalService, saveLocalService } from "../share/service-state.js";
import { listLocalProviders } from "../provider/state.js";
import { installDeviceRelayService } from "../service.js";
import { createA2aServer } from "./a2a-server.js";
import { getDefinition, type TaskDefinition } from "./definition.js";
import { readTaskRun, writeTaskRun, type TaskWorkspace } from "./run-store.js";
import { listTaskShares, writeTaskShares, type TaskShare } from "./share-store.js";

export const WORKSPACES: readonly TaskWorkspace[] = ["none", "read", "worktree"];

export interface ShareOptions {
  readonly workspace: TaskWorkspace;
  readonly description: string;
  /** The owner accepts that gateway-model calls deduct model fees from their Credit. */
  readonly chargeMyCredit: boolean;
  readonly interactive: boolean;
}

export interface ShareDeps {
  readonly control?: () => Promise<ServiceControl>;
  readonly installDaemon?: () => Promise<void>;
  readonly ask?: (question: string) => Promise<string>;
  readonly freePort?: () => Promise<number>;
  readonly providers?: typeof listLocalProviders;
}

async function askTerminal(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try { return await reader.question(question); } finally { reader.close(); }
}

export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = (probe.address() as { port: number }).port; probe.close(() => resolve(port)); });
  });
}

/** Why a definition may not be shared as it is (T3, T7); undefined when it may. */
export async function shareRefusal(definition: TaskDefinition, options: Pick<ShareOptions, "chargeMyCredit" | "workspace">, providers = listLocalProviders): Promise<string | undefined> {
  if (definition.model !== undefined && !options.chargeMyCredit) {
    const local = (await providers()).some((provider) => !provider.pending && provider.models.includes(definition.model!));
    if (!local) return `${definition.model} is not a model registered on this computer (frely provider add). Calls to it would use the Frely gateway and deduct model fees from your Credit. Share with --charge-my-credit if you accept that.`;
  }
  return undefined;
}

/**
 * Shares a task as an A2A service: asks the owner (at the terminal) to approve exactly this definition, registers a service on Frely and
 * hands the loopback endpoint to the background service. Changing the definition afterwards delists the share until it is approved again.
 */
export async function shareTask(name: string, options: ShareOptions, write: (text: string) => void, deps: ShareDeps = {}): Promise<TaskShare> {
  const definition = await getDefinition(name);
  if (!definition) throw new Error(`No task named ${name}. See frely task list.`);
  if (!WORKSPACES.includes(options.workspace)) throw new Error(`The workspace must be ${WORKSPACES.join(", ")}.`);
  if (definition.runner === "script" && options.workspace !== "none") throw new Error("A script task runs in its own folder; leave --workspace out for it.");
  const refusal = await shareRefusal(definition, options, deps.providers);
  if (refusal) throw new Error(refusal);
  const bound = definition.runner === "pi" && options.workspace !== "none";
  if (!options.interactive) throw new Error("Sharing needs the owner at a terminal on this computer: the approval cannot be answered remotely.");
  const summary = [
    `Share task ${definition.name} (${definition.runner}, definition ${definition.hash.slice(0, 12)}) as an A2A service?`,
    `  Callers send only a text request. The ${definition.runner === "pi" ? "instructions" : "command"}, folder and limits stay as defined.`,
    definition.runner === "pi" ? `  Workspace: ${options.workspace}${options.workspace === "none" ? " (a one-time empty folder)" : options.workspace === "read" ? " (callers get answers about the project; it is not changed)" : " (a git worktree per call; nothing is committed to your main branch or pushed)"}.` : "",
    bound ? "  Callers can read your project's content through the answers: keep the service private to yourself and your Team unless you accept that for everyone who can call it." : "",
    definition.model ? `  Model ${definition.model}: ${options.chargeMyCredit ? "calls may use the Frely gateway and deduct model fees from your Credit." : "runs on a model registered on this computer."}` : "",
    "  One call runs at a time, three more wait; further calls are answered busy and nothing is charged.",
    "  Any change to the task delists the share until you approve it again.",
  ].filter(Boolean).join("\n");
  const answer = await (deps.ask ?? askTerminal)(`${summary}\nType "yes" to approve: `);
  if (answer.trim().toLowerCase() !== "yes") throw new Error("Not shared: the approval was not given.");
  const control = await (deps.control ?? accountServiceControl)();
  const shares = await listTaskShares();
  const existing = shares.find((share) => share.name === name);
  const record = existing ? { id: existing.serviceShareId } : await control.register({ type: "a2a", label: `task-${name}`.slice(0, 64) });
  const port = await (deps.freePort ?? freeLoopbackPort)();
  const share: TaskShare = { name, approvedHash: definition.hash, workspace: options.workspace, allowCredit: options.chargeMyCredit, description: options.description, serviceShareId: record.id, port, sharedAt: new Date().toISOString() };
  await writeTaskShares([...shares.filter((item) => item.name !== name), share]);
  const local = (await listLocalServices()).find((service) => service.serviceShareId === record.id);
  await saveLocalService({ serviceShareId: record.id, type: "a2a", label: `task-${name}`.slice(0, 64), port, createdAt: local?.createdAt ?? new Date().toISOString(), background: true });
  await (deps.installDaemon ?? (async () => { await installDeviceRelayService(); }))();
  write(`Shared task ${name} as service ${record.id}. The background service serves it and keeps it connected; only Frely can reach it.\n`);
  return share;
}

/** Stops sharing: the service stays registered on Frely, disconnected. */
export async function unshareTask(name: string): Promise<boolean> {
  const shares = await listTaskShares();
  const found = shares.find((share) => share.name === name);
  if (!found) return false;
  await writeTaskShares(shares.filter((share) => share.name !== name));
  const local = (await listLocalServices()).find((service) => service.serviceShareId === found.serviceShareId);
  if (local) await saveLocalService({ ...local, background: false });
  return true;
}

/** The owner has dealt with the changes a remote call left in its worktree. */
export async function markHandled(runId: string): Promise<boolean> {
  const record = await readTaskRun(runId);
  if (!record || record.trigger !== "remote") return false;
  await writeTaskRun({ ...record, handledAt: new Date().toISOString() });
  return true;
}

export async function removeShareRecords(serviceShareId: string): Promise<void> {
  await removeLocalService(serviceShareId).catch(() => undefined);
}

/**
 * The background service's side of shared tasks: serves each share's A2A endpoint and delists a share whose definition changed or vanished.
 */
export async function superviseTaskShares(options: { signal: AbortSignal; log: (text: string) => void; tickMs?: number }): Promise<void> {
  const servers = new Map<string, { close(): Promise<void>; port: number; hash: string }>();
  const stop = async (name: string): Promise<void> => { const server = servers.get(name); servers.delete(name); await server?.close().catch(() => undefined); };
  while (!options.signal.aborted) {
    try {
      const shares = await listTaskShares();
      for (const share of shares) {
        const definition = await getDefinition(share.name);
        if (!definition || definition.hash !== share.approvedHash) {
          await stop(share.name);
          await unshareTask(share.name);
          options.log(`Shared task ${share.name} was delisted: its definition ${definition ? "changed" : "was removed"}. Share it again to approve the new one.`);
          continue;
        }
        const running = servers.get(share.name);
        if (running && running.port === share.port && running.hash === share.approvedHash) continue;
        await stop(share.name);
        const server = createA2aServer(share);
        try {
          const port = await server.listen(share.port);
          servers.set(share.name, { close: server.close, port, hash: share.approvedHash });
          options.log(`Serving shared task ${share.name} on 127.0.0.1:${port}.`);
        } catch (error) {
          await server.close().catch(() => undefined);
          options.log(`Shared task ${share.name} could not listen on port ${share.port}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const name of [...servers.keys()]) if (!shares.some((share) => share.name === name)) await stop(name);
    } catch (error) { options.log(`Shared tasks: ${error instanceof Error ? error.message : String(error)}`); }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.tickMs ?? 5_000);
      options.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  for (const name of [...servers.keys()]) await stop(name);
}
