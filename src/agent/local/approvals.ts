import { ensureDevice } from "../../device/control.js";
import { openController, resultData, resultText, type Controller } from "../../controller/client.js";
import { ControllerError, EXIT } from "../../controller/session.js";
import { approvedHosts, type LocalAgentRecord } from "./store.js";

/** The shape of FrelyMCP's request_permission / permission_status answers that this file reads. */
export interface ApprovalIo {
  err(text: string): void;
  /** A person is at the terminal and can be waited for. */
  interactive: boolean;
}

export interface ApprovalDeps {
  open?: () => Promise<Controller>;
  deviceId?: () => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  waitMs?: number;
}

const sleepFor = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
/** When the relay does not say, an approval is taken to last as long as its default window. */
const DEFAULT_WINDOW_MS = 12 * 3_600_000;

/** The FrelyMCP resource name for one site. The relay shows it to the owner as "connect to <site>". */
export const siteResource = (host: string): string => `net:${host}`;

/**
 * Makes sure every site the Agent listed in frely.yaml is approved, asking the owner through the same approval link as any other
 * device permission. Returns the approvals gained (site -> end time). A site the owner declines is left out and the Agent starts without it.
 * Without a person at the terminal a pending request ends the command with exit code 3 and the link; run the command again after approving.
 */
export async function approveSites(record: LocalAgentRecord, io: ApprovalIo, deps: ApprovalDeps = {}): Promise<Record<string, string>> {
  const now = deps.now ?? Date.now;
  const open = deps.open ?? (() => openController({ interactive: io.interactive }));
  const missing = record.network.filter((host) => !approvedHosts(record, now()).includes(host));
  const gained: Record<string, string> = {};
  if (missing.length === 0) return gained;
  const controller = await open();
  try {
    const device = await (deps.deviceId ?? (async () => (await ensureDevice()).deviceId))();
    for (const host of missing) {
      const end = await approveSite(controller, device, record, host, io, deps);
      if (end) gained[host] = end;
    }
  } finally {
    await controller.close().catch(() => undefined);
  }
  return gained;
}

async function approveSite(controller: Controller, device: string, record: LocalAgentRecord, host: string, io: ApprovalIo, deps: ApprovalDeps): Promise<string | undefined> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? sleepFor;
  const result = await controller.call("request_permission", {
    device, resource: siteResource(host), mode: "window",
    reason: `The local Agent ${record.slug} lists ${host} in its frely.yaml.`.slice(0, 300),
    command: `frely agent local start ${record.slug}`,
  });
  const data = resultData(result);
  if (result.isError === true || !data) throw new ControllerError(`Could not ask for approval of ${host}: ${resultText(result) || "no answer"}`, EXIT.tool);
  const status = data.status;
  if (status === "allowed") return typeof data.expiresAt === "string" ? data.expiresAt : new Date(now() + DEFAULT_WINDOW_MS).toISOString();
  if (status === "not_needed") return new Date(now() + DEFAULT_WINDOW_MS).toISOString();
  const code = typeof data.shortCode === "string" ? data.shortCode : undefined;
  const link = typeof data.approveUrl === "string" ? data.approveUrl : undefined;
  if (status !== "pending" || !code) throw new ControllerError(`Could not ask for approval of ${host}: ${resultText(result) || String(status)}`, EXIT.tool);
  io.err(`${record.slug} wants to connect to ${host}. Approve it here (you choose how long): ${link ?? "Frely > Device MCP"}\n`);
  if (!io.interactive) {
    throw new ControllerError(`Approval needed for ${host}. Open the link above, approve it, then run the same command again.`, EXIT.approval);
  }
  io.err("Waiting for your decision…\n");
  const deadline = now() + (deps.waitMs ?? 10 * 60_000);
  for (;;) {
    const answer = resultData(await controller.call("permission_status", { code }));
    if (answer?.status === "approved") return typeof answer.expiresAt === "string" ? answer.expiresAt : new Date(now() + DEFAULT_WINDOW_MS).toISOString();
    if (answer?.status === "denied") { io.err(`${host} was declined; ${record.slug} will run without it.\n`); return undefined; }
    if (answer?.status === "expired" || answer?.status === "revoked") { io.err(`The request for ${host} ended without an answer; ${record.slug} will run without it.\n`); return undefined; }
    if (now() + (deps.pollMs ?? 3000) >= deadline) throw new ControllerError(`Still waiting for approval of ${host}. Run the same command again to keep waiting.`, EXIT.approval);
    await sleep(deps.pollMs ?? 3000);
  }
}
