import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runAgentLocal, listLocalAgents, type LocalIo } from "../agent/local/command.js";
import type { ApprovalDeps } from "../agent/local/approvals.js";
import { ControllerError, EXIT } from "../controller/client.js";
import { runKeyCommand, KEY_SETUP_AGENTS, type KeySetupIo } from "../key-setup.js";
import { installEntrySkill } from "../skill/entry.js";
import { syncAgentLinks } from "../skill/link-sync.js";
import { linkLines } from "../skill/agent-links.js";
import type { SkillScope } from "../skill/managed.js";
import { buildDefinition, getDefinition, saveDefinition } from "../task/definition.js";
import type { ManagerDeps } from "../task/manager.js";
import { startSavedTask, type TaskIo } from "../task/command.js";
import { AGENT_IDS, agentStatus, getAgent, listAgentStatuses, runnableAgents } from "./registry.js";
import { detectBinary } from "./detect.js";
import type { AgentAdapter, AgentDetection } from "./types.js";

export const AGENT_USAGE = `Usage:
  frely agent list [--json]                          Agents on this computer (pi, codex, claude-code) and local Agents
  frely agent status <id> [--json]                   Is it installed, which version, what it can do here
  frely agent run <id> "<task>" [--cwd <dir>] [--model <name>] [--wait [--wait-sec <n>]] [--json]
                                                     Run one task in that agent, inside the Frely sandbox. Read it with frely result
  frely agent setup [<id>] [--gateway [<url>]] [--scope global|project] [--dir <path>] [--json]
                                                     Give the agent the Frely Skill (all detected agents without <id>); --gateway also points it at the Frely gateway
${["start <name | username/name | https://github.com/owner/repo> [--name <folder-name>] [--foreground]", "stop <name>", "logs <name> [--lines <n>] [--follow]", "remove <name>", "key --api-key-stdin | --clear"].map((line) => `  frely agent ${line}`).join("\n")}
`;

export interface AgentCommandIo extends TaskIo {
  readSecret(): Promise<string>;
}

export interface AgentCommandDeps {
  readonly detect?: (binary: string) => Promise<AgentDetection>;
  readonly manager?: ManagerDeps;
  readonly approval?: ApprovalDeps;
  readonly key?: () => Promise<KeySetupIo>;
}

const fail = (message: string, code: number = EXIT.cli): never => { throw new ControllerError(message, code); };
const has = (args: readonly string[], name: string): boolean => args.includes(name);
function value(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) return fail(`${name} needs a value.`);
  return next;
}
const FLAGS_WITH_VALUE = new Set(["--cwd", "--model", "--wait-sec", "--scope", "--dir", "--timeout", "--name"]);
function positional(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--gateway") { if (args[index + 1] !== undefined && !args[index + 1]!.startsWith("--")) index += 1; continue; }
    if (arg.startsWith("--")) { if (FLAGS_WITH_VALUE.has(arg)) index += 1; continue; }
    out.push(arg);
  }
  return out;
}

/** Runs `frely agent ...`; returns the exit code. `list|status|run|setup` are about agents installed here; the rest are local Agents (repositories this computer runs). */
export async function runAgentCommand(args: readonly string[], io: AgentCommandIo, deps: AgentCommandDeps = {}): Promise<number> {
  const [action, ...rest] = args;
  try {
    switch (action) {
      case "list": return await list(rest, io, deps);
      case "status": return await status(rest, io, deps);
      case "run": return await run(rest, io, deps);
      case "setup": return await setup(rest, io, deps);
      case "start": case "stop": case "logs": case "remove": case "key": case "supervise":
        return await runAgentLocal(args, { out: io.out, err: io.err, interactive: io.interactive, readSecret: io.readSecret } satisfies LocalIo, deps.approval);
      default: io.out(AGENT_USAGE); return action === undefined || action === "help" || action === "--help" ? EXIT.ok : EXIT.cli;
    }
  } catch (error) {
    if (error instanceof ControllerError) { io.err(`${error.message}\n`); return error.exitCode; }
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.cli;
  }
}

async function list(args: readonly string[], io: AgentCommandIo, deps: AgentCommandDeps): Promise<number> {
  const statuses = await listAgentStatuses(deps.detect);
  if (has(args, "--json")) {
    const local: string[] = [];
    await listLocalAgents(["--json"], { out: (text) => { local.push(text); }, err: io.err, interactive: false, readSecret: io.readSecret });
    io.out(`${JSON.stringify({ agents: statuses, local: JSON.parse(local.join("") || "[]") as unknown }, null, 2)}\n`);
    return EXIT.ok;
  }
  io.out("Agents on this computer:\n");
  io.out(statuses.map((item) => `  ${item.id}\t${item.installed ? `installed${item.version ? ` ${item.version}` : ""}\t${item.path ?? ""}` : "not installed"}`).join("\n") + "\n");
  io.out("\nLocal Agents:\n");
  await listLocalAgents([], { out: io.out, err: io.err, interactive: io.interactive, readSecret: io.readSecret });
  return EXIT.ok;
}

function requireAgent(id: string | undefined): AgentAdapter {
  if (!id) return fail(`Name an agent: ${AGENT_IDS.join(", ")}.`);
  try { return getAgent(id); } catch (error) { return fail((error as Error).message); }
}

async function status(args: readonly string[], io: AgentCommandIo, deps: AgentCommandDeps): Promise<number> {
  const agent = requireAgent(positional(args)[0]);
  const found = await agentStatus(agent, deps.detect);
  if (has(args, "--json")) { io.out(`${JSON.stringify(found)}\n`); return EXIT.ok; }
  io.out(`${agent.title} (${agent.id})\n  ${found.installed ? `installed${found.version ? ` ${found.version}` : ""} at ${found.path}` : "not installed"}\n  can: ${(Object.entries(agent.capabilities) as Array<[string, boolean]>).filter(([, on]) => on).map(([name]) => name).join(", ") || "nothing here"}\n`);
  if (!found.installed) io.out(`  ${agent.installHint}\n`);
  return found.installed ? EXIT.ok : EXIT.tool;
}

/** The task a `frely agent run` leaves behind: one saved definition per agent, so the approvals of its sites last between runs. */
const runTaskName = (agent: AgentAdapter): string => `agent-run-${agent.id}`;

async function run(args: readonly string[], io: AgentCommandIo, deps: AgentCommandDeps): Promise<number> {
  const [id, text, ...extra] = positional(args);
  const agent = requireAgent(id);
  if (!text || extra.length > 0) return fail(`Usage: frely agent run <id> "<task>" [--cwd <dir>] [--model <name>] [--wait [--wait-sec <n>]] [--json]`);
  if (!agent.capabilities.run) return fail(`${agent.title} cannot run a task from frely-cli.`);
  const found = await agentStatus(agent, deps.detect);
  if (!found.installed) return fail(`${agent.title} is not installed on this computer. ${agent.installHint}`, EXIT.tool);
  const cwd = resolve(value(args, "--cwd") ?? process.cwd());
  if (!(await stat(cwd).then((info) => info.isDirectory(), () => false))) return fail(`The folder ${cwd} does not exist.`);
  const name = runTaskName(agent);
  const model = value(args, "--model");
  const timeout = value(args, "--timeout");
  const definition = buildDefinition({ name, runner: agent.id, command: text, cwd, network: [...agent.hosts], ...(model === undefined ? {} : { model }), ...(timeout === undefined ? {} : { timeoutSec: Number(timeout) }) }, await getDefinition(name));
  await saveDefinition(definition);
  return startSavedTask(name, args, io, { ...(deps.manager ? { manager: deps.manager } : {}), ...(deps.approval ? { approval: deps.approval } : {}) }, { approveAlways: true });
}

async function setup(args: readonly string[], io: AgentCommandIo, deps: AgentCommandDeps): Promise<number> {
  const [id] = positional(args);
  const json = has(args, "--json");
  const scope = (value(args, "--scope") ?? "global") as SkillScope;
  if (scope !== "global" && scope !== "project") return fail("--scope must be global or project.");
  const dir = value(args, "--dir");
  const gatewayAt = args.indexOf("--gateway");
  const gateway = gatewayAt >= 0 ? (args[gatewayAt + 1] !== undefined && !args[gatewayAt + 1]!.startsWith("--") ? args[gatewayAt + 1]! : "") : undefined;
  let targets: AgentAdapter[];
  if (id !== undefined) {
    const agent = requireAgent(id);
    if (!agent.capabilities.skillHost) return fail(`${agent.title} cannot be set up from frely-cli.`);
    targets = [agent];
  } else {
    if (gateway !== undefined) return fail(`--gateway needs one agent: ${KEY_SETUP_AGENTS.join(" or ")}.`);
    const detect = deps.detect ?? detectBinary;
    targets = [];
    for (const agent of runnableAgents()) if (agent.capabilities.skillHost && (await detect(agent.binary)).installed) targets.push(agent);
  }
  const done: Array<Record<string, unknown>> = [];
  for (const agent of targets) {
    const skill = await installEntrySkill({ host: agent.skillHost, scope, ...(dir ? { dir } : {}) });
    done.push({ agent: agent.id, skill: skill.path });
    if (!json) io.out(`${agent.title}: Frely Skill at ${skill.path}\n${linkLines(skill.links)}`);
  }
  // Agents that read another folder than .agents/skills (and hosts such as WorkBuddy) get a link to the one copy.
  const links = await syncAgentLinks({ mode: "full" });
  if (!json) {
    for (const change of links.added) io.out(`Linked: ${change.path} (${change.agent})\n`);
    if (targets.length === 0 && links.added.length === 0) io.out("No supported agent was found on this computer. Install one, or name it: frely agent setup <id>.\n");
  }
  if (gateway !== undefined) {
    if (!id || !(KEY_SETUP_AGENTS as readonly string[]).includes(id)) return fail(`--gateway works for ${KEY_SETUP_AGENTS.join(" or ")}.`);
    const keyIo = await (deps.key ?? (() => { throw new Error("The Frely login is not available here."); }))();
    const code = await runKeyCommand(["setup", id, ...(gateway === "" ? [] : ["--gateway", gateway]), ...(has(args, "--json") ? ["--json"] : [])], keyIo);
    if (code !== 0) return code;
  }
  if (json && gateway === undefined) io.out(`${JSON.stringify({ agents: done, links: links.added })}\n`);
  else if (!json && done.length > 0) io.out("Restart or reload the agent session so it rescans Skills.\n");
  return EXIT.ok;
}
