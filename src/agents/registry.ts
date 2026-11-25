import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { piAdapter } from "./pi.js";
import { detectBinary } from "./detect.js";
import type { AgentAdapter, AgentDetection, AgentId } from "./types.js";

/** The only place that lists the agents. Everything that needs the names (task executors, setup targets, `item install --host`) reads this. */
export const AGENTS: readonly AgentAdapter[] = [piAdapter, codexAdapter, claudeCodeAdapter];
export const AGENT_IDS: readonly AgentId[] = AGENTS.map((agent) => agent.id);

/** Hosts that can read an installed Skill but are not agents on this computer (no `agent list` entry). */
export const OTHER_SKILL_HOSTS = ["chatgpt", "workbuddy", "codebuddy", "generic"] as const;

export const isAgentId = (value: unknown): value is AgentId => typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);

export function getAgent(id: string): AgentAdapter {
  const found = AGENTS.find((agent) => agent.id === id);
  if (!found) throw new Error(`Unknown agent ${JSON.stringify(id)}. Use ${AGENT_IDS.join(", ")}.`);
  return found;
}

/** Agents that can run a task. */
export const runnableAgents = (): readonly AgentAdapter[] => AGENTS.filter((agent) => agent.capabilities.run);

export interface AgentStatus extends AgentDetection {
  readonly id: AgentId;
  readonly kind: AgentAdapter["kind"];
  readonly title: string;
  readonly capabilities: AgentAdapter["capabilities"];
  /** Present when it is not installed. */
  readonly install?: string;
}

export async function agentStatus(agent: AgentAdapter, detect: (binary: string) => Promise<AgentDetection> = detectBinary): Promise<AgentStatus> {
  const found = await detect(agent.binary);
  return { id: agent.id, kind: agent.kind, title: agent.title, capabilities: agent.capabilities, ...found, ...(found.installed ? {} : { install: agent.installHint }) };
}

export const listAgentStatuses = (detect?: (binary: string) => Promise<AgentDetection>): Promise<AgentStatus[]> => Promise.all(AGENTS.map((agent) => agentStatus(agent, detect)));

/** The agent a step runs with when it names none: the first runnable agent installed here, in registry order (`pi` when none is installed, so the run says why it cannot start). */
export async function defaultAgentId(detect: (binary: string) => Promise<AgentDetection> = detectBinary): Promise<AgentId> {
  for (const agent of runnableAgents()) if ((await detect(agent.binary)).installed) return agent.id;
  return AGENT_IDS[0]!;
}
