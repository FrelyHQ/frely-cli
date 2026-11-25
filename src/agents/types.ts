import type { SkillHost } from "../skill/managed.js";

/** Agents frely-cli can drive on this computer. All of them are installed by the user; frely-cli never downloads or embeds one. */
export type AgentId = "pi" | "codex" | "claude-code";

export interface AgentCapabilities {
  /** Can run one task without a person (`frely agent run`, `frely task local add --agent`). */
  readonly run: boolean;
  /** Reads Skills, so `frely agent setup` can give it the Frely Skill. */
  readonly skillHost: boolean;
  /** `frely agent setup --gateway` can point it at the Frely gateway. */
  readonly gateway: boolean;
}

export interface RunInput {
  /** Model name, passed to the agent as given. */
  readonly model?: string;
  /** Session id of an earlier run, to continue it. */
  readonly resume?: string;
  /** A file the agent may write its last message to (only used by agents that have such an option). */
  readonly outputFile: string;
}

export interface ParsedOutput {
  readonly answer: string;
  readonly sessionId?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly kind: "coding-agent" | "local-agent";
  readonly title: string;
  /** The program name looked up on PATH. */
  readonly binary: string;
  /** What to tell the user when it is not installed. */
  readonly installHint: string;
  readonly capabilities: AgentCapabilities;
  /** The Skill host name this agent has in `item install --host`. */
  readonly skillHost: SkillHost;
  /** Sites a run needs to reach for the agent's own model service (a run reaches only sites the owner approved). */
  readonly hosts: readonly string[];
  /** Arguments after the binary for one non-interactive run. The task text is sent on stdin. */
  runArguments(input: RunInput): string[];
  /** Reads what the program printed (and the output file, when `usesOutputFile`). */
  parseOutput(output: string, fileText?: string): ParsedOutput;
  readonly usesOutputFile?: boolean;
}

export interface AgentDetection {
  readonly installed: boolean;
  readonly path?: string;
  readonly version?: string;
}
