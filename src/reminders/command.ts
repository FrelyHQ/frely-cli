import { readEnabled, setupReminders, syncReminders, writeEnabled, type Reminders } from "./sync.js";
import { REMINDER_LIST } from "./plan.js";

type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface RemindersCommandIo { out: (text: string) => void; call: Call; run?: Reminders }

/** `frely reminders setup|status|sync|off`: link the signed-in account's todos to Apple Reminders on this Mac. */
export async function runRemindersCommand(args: readonly string[], io: RemindersCommandIo): Promise<number> {
  const action = args[0];
  const json = args.includes("--json");
  const emit = (value: unknown, text: string) => io.out(json ? `${JSON.stringify(value)}\n` : text);
  try {
    if (action === "setup") {
      const { created } = await setupReminders(io.run);
      await writeEnabled(true);
      emit({ enabled: true, list: REMINDER_LIST, created }, `Linked. ${created ? `Created the list "${REMINDER_LIST}".` : `The list "${REMINDER_LIST}" already exists.`} The background service now keeps it in step with your tasks every few minutes.\n`);
      return 0;
    }
    if (action === "status") {
      const enabled = await readEnabled();
      emit({ enabled, list: REMINDER_LIST }, enabled ? `On: tasks with a date or in progress appear in the "${REMINDER_LIST}" list.\n` : "Off. Run `frely reminders setup`.\n");
      return 0;
    }
    if (action === "sync") {
      const result = await syncReminders(io.call, io.run);
      emit(result, `${result.actions} change${result.actions === 1 ? "" : "s"}${result.failed.length ? `, ${result.failed.length} failed:\n${result.failed.join("\n")}` : ""}\n`);
      return result.failed.length ? 1 : 0;
    }
    if (action === "off") { await writeEnabled(false); emit({ enabled: false }, "Off. The reminders already in the list stay; delete the list in Reminders if you do not want them.\n"); return 0; }
  } catch (error) {
    io.out(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  io.out("Usage: frely reminders setup|status|sync|off [--json]\n");
  return 2;
}
