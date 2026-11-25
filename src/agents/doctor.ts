import { getAgent, listAgentStatuses, agentStatus } from "./registry.js";
import type { AgentStatus } from "./registry.js";
import type { AgentDetection } from "./types.js";

export interface AgentDoctorValue {
  readonly ok: boolean;
  readonly agents: ReadonlyArray<AgentStatus & { readonly fix?: string }>;
}

/**
 * `frely doctor agent [<id>]`: read-only. Says which agents are installed here and what to run for the ones that are not.
 * An agent that is not installed fails the check only when it was named; a list of all of them just reports.
 */
export async function agentDoctor(id?: string, detect?: (binary: string) => Promise<AgentDetection>): Promise<AgentDoctorValue> {
  if (id !== undefined) {
    const found = await agentStatus(getAgent(id), detect);
    return { ok: found.installed, agents: [{ ...found, ...(found.installed ? { fix: `frely agent setup ${found.id}` } : { fix: found.install ?? "" }) }] };
  }
  const all = await listAgentStatuses(detect);
  return { ok: all.some((item) => item.installed), agents: all.map((item) => ({ ...item, fix: item.installed ? `frely agent setup ${item.id}` : item.install ?? "" })) };
}

export function formatAgentDoctor(value: AgentDoctorValue): string {
  const lines = value.agents.map((item) => item.installed
    ? `ok    ${item.id}  ${item.version ?? ""}  ${item.path ?? ""}\n      Give it the Frely Skill: ${item.fix}`
    : `miss  ${item.id}  not installed\n      ${item.fix}`);
  return `${lines.join("\n")}\n${value.ok ? "" : "No supported agent is installed on this computer.\n"}`;
}

