// `frely todo`: read and write the signed-in account's cloud todos (a goal and a plan of steps) through the Frely todo.* tools.
// The cloud is the only copy: the CLI needs a connection (it is online-by-default), and archived is the only delete.

type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface TodoCommandIo {
  out: (text: string) => void;
  call: Call;
}

export const TODO_STATUSES = ["open", "in_progress", "done", "cancelled", "archived"] as const;
export const TODO_STEP_STATUSES = ["pending", "succeeded", "failed", "skipped", "cancelled"] as const;

const USAGE = "Usage: frely todo list|show|add|update|archive|plan|step. Run frely help --agent --json todo for flags.";

interface Parsed { positional: string[]; flags: Map<string, string[]>; json: boolean }

/** `--flag value` pairs and bare words; a flag may repeat (`--step a --step b`). `--json` takes no value. */
export function parseTodoArgs(args: readonly string[], valueFlags: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") { json = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!valueFlags.includes(arg)) throw new Error(`Unknown option ${arg}. ${USAGE}`);
    const value = args[++i];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value.`);
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  return { positional, flags, json };
}

const one = (parsed: Parsed, flag: string): string | undefined => parsed.flags.get(flag)?.at(-1);
const steps = (parsed: Parsed): Array<{ instruction: string; deviceId?: string }> => {
  const devices = parsed.flags.get("--device") ?? [];
  return (parsed.flags.get("--step") ?? []).map((instruction, index) => ({ instruction, ...(devices[index] ? { deviceId: devices[index]! } : {}) }));
};

function oneOf<T extends string>(list: readonly T[], value: string, flag: string): T {
  if (!(list as readonly string[]).includes(value)) throw new Error(`${flag} must be one of ${list.join(", ")}.`);
  return value as T;
}

type Todo = { id?: string; title?: string; status?: string; description?: string; steps?: { total?: number; succeeded?: number } };
type Step = { id?: string; seq?: number; status?: string; instruction?: string; deviceId?: string | null; resultSummary?: string | null };

function line(todo: Todo): string {
  const progress = todo.steps && todo.steps.total ? `  ${todo.steps.succeeded ?? 0}/${todo.steps.total}` : "";
  return `${todo.id}  ${(todo.status ?? "").padEnd(11)} ${todo.title}${progress}\n`;
}

function stepLine(step: Step): string {
  return `  ${step.seq}. [${step.status}] ${step.instruction}${step.deviceId ? `  (device ${step.deviceId})` : ""}  ${step.id}\n${step.resultSummary ? `     ${step.resultSummary.split("\n")[0]}\n` : ""}`;
}

/** Runs one `frely todo` command; returns the exit code. */
export async function runTodoCommand(args: readonly string[], io: TodoCommandIo): Promise<number> {
  const action = args[0];
  const rest = args.slice(1);
  const emit = (value: unknown, json: boolean, text: () => string) => io.out(json ? `${JSON.stringify(value)}\n` : text());

  if (action === "list") {
    const parsed = parseTodoArgs(rest, ["--status", "--search", "--sort", "--direction", "--page", "--page-size"]);
    const input: Record<string, unknown> = {};
    const status = one(parsed, "--status");
    if (status) input.status = [oneOf(TODO_STATUSES, status, "--status")];
    if (one(parsed, "--search")) input.q = one(parsed, "--search");
    if (one(parsed, "--sort")) input.sort = oneOf(["title", "status", "updated_at"] as const, one(parsed, "--sort")!, "--sort");
    if (one(parsed, "--direction")) input.direction = oneOf(["asc", "desc"] as const, one(parsed, "--direction")!, "--direction");
    if (one(parsed, "--page")) input.page = Number(one(parsed, "--page"));
    if (one(parsed, "--page-size")) input.pageSize = Number(one(parsed, "--page-size"));
    const result = await io.call("todo.list", input) as { items?: Todo[]; total?: number; page?: number; totalPages?: number };
    emit(result, parsed.json, () => (result.items?.length ? result.items.map(line).join("") + (result.totalPages && result.totalPages > 1 ? `Page ${result.page}/${result.totalPages} (${result.total} todos); use --page.\n` : "") : "No todos.\n"));
    return 0;
  }
  if (action === "show") {
    const parsed = parseTodoArgs(rest, []);
    const todoId = parsed.positional[0];
    if (!todoId) throw new Error("Usage: frely todo show <todoId> [--json]");
    const result = await io.call("todo.show", { todoId }) as { todo?: Todo; steps?: Step[] };
    emit(result, parsed.json, () => `${line(result.todo ?? {})}${result.todo?.description ? `${result.todo.description}\n` : ""}${(result.steps ?? []).map(stepLine).join("") || "  (no steps)\n"}`);
    return 0;
  }
  if (action === "add") {
    const parsed = parseTodoArgs(rest, ["--description", "--step", "--device"]);
    const title = parsed.positional.join(" ").trim();
    if (!title) throw new Error("Usage: frely todo add <title> [--description <text>] [--step <instruction> [--device <id>]]... [--json]");
    const result = await io.call("todo.add", { title, ...(one(parsed, "--description") ? { description: one(parsed, "--description") } : {}), ...(parsed.flags.has("--step") ? { steps: steps(parsed) } : {}) }) as { todo?: Todo };
    emit(result, parsed.json, () => `Created ${result.todo?.id}\n`);
    return 0;
  }
  if (action === "update" || action === "archive") {
    const parsed = parseTodoArgs(rest, ["--title", "--description", "--status"]);
    const todoId = parsed.positional[0];
    if (!todoId) throw new Error(action === "archive" ? "Usage: frely todo archive <todoId>" : "Usage: frely todo update <todoId> [--title <t>] [--description <t>] [--status open|in_progress|done|cancelled|archived]");
    const input: Record<string, unknown> = { todoId };
    if (action === "archive") input.status = "archived";
    else {
      if (one(parsed, "--title") !== undefined) input.title = one(parsed, "--title");
      if (one(parsed, "--description") !== undefined) input.description = one(parsed, "--description");
      if (one(parsed, "--executor") !== undefined) input.executor = oneOf(["pi", "codex"] as const, one(parsed, "--executor")!, "--executor");
      if (one(parsed, "--status")) input.status = oneOf(TODO_STATUSES, one(parsed, "--status")!, "--status");
      if (Object.keys(input).length === 1) throw new Error("Nothing to update: pass --title, --description or --status.");
    }
    const result = await io.call("todo.update", input) as { todo?: Todo };
    emit(result, parsed.json, () => `Updated ${result.todo?.id} (${result.todo?.status})\n`);
    return 0;
  }
  if (action === "plan") {
    const parsed = parseTodoArgs(rest, ["--step", "--device"]);
    const todoId = parsed.positional[0];
    if (!todoId) throw new Error("Usage: frely todo plan <todoId> [--step <instruction> [--device <id>]]... [--json] (replaces the steps that have not started; no --step clears them)");
    const result = await io.call("todo.plan", { todoId, steps: steps(parsed) }) as { steps?: Step[] };
    emit(result, parsed.json, () => (result.steps ?? []).map(stepLine).join("") || "  (no steps)\n");
    return 0;
  }
  if (action === "step") {
    const sub = rest[0];
    if (sub === "add") {
      const parsed = parseTodoArgs(rest.slice(1), ["--device", "--executor"]);
      const [todoId, ...words] = parsed.positional;
      const instruction = words.join(" ").trim();
      if (!todoId || !instruction) throw new Error("Usage: frely todo step add <todoId> <instruction> [--device <id>] [--json]");
      const result = await io.call("todo.step_add", { todoId, instruction, ...(one(parsed, "--device") ? { deviceId: one(parsed, "--device") } : {}), ...(one(parsed, "--executor") ? { executor: oneOf(["pi", "codex"] as const, one(parsed, "--executor")!, "--executor") } : {}) }) as { steps?: Step[] };
      emit(result, parsed.json, () => (result.steps ?? []).map(stepLine).join(""));
      return 0;
    }
    if (sub === "update") {
      const parsed = parseTodoArgs(rest.slice(1), ["--instruction", "--device", "--executor", "--status", "--result"]);
      const [todoId, stepId] = parsed.positional;
      if (!todoId || !stepId) throw new Error("Usage: frely todo step update <todoId> <stepId> [--instruction <t>] [--device <id>] [--executor pi|codex] [--status pending|succeeded|failed|skipped|cancelled] [--result <text>] [--json]");
      const input: Record<string, unknown> = { todoId, stepId };
      if (one(parsed, "--instruction") !== undefined) input.instruction = one(parsed, "--instruction");
      if (one(parsed, "--device") !== undefined) input.deviceId = one(parsed, "--device");
      if (one(parsed, "--status")) input.status = oneOf(TODO_STEP_STATUSES, one(parsed, "--status")!, "--status");
      if (one(parsed, "--result") !== undefined) input.resultSummary = one(parsed, "--result");
      if (Object.keys(input).length === 2) throw new Error("Nothing to update: pass --instruction, --device, --executor, --status or --result.");
      const result = await io.call("todo.step_update", input) as { step?: Step };
      emit(result, parsed.json, () => stepLine(result.step ?? {}));
      return 0;
    }
    throw new Error("Usage: frely todo step add|update");
  }
  io.out(`${USAGE}\n`);
  return action === undefined ? 0 : 1;
}
