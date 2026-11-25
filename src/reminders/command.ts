import { checkReminderAccess, readEnabled, setupReminders, syncReminders, writeEnabled, type Reminders } from "./sync.js";
import { REMINDER_LIST } from "./plan.js";

type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface RemindersCommandIo { out: (text: string) => void; call: Call; run?: Reminders }

/**
 * `frely task reminders setup|status|sync|off [--json]` (macOS only): link the signed-in account's tasks to Apple Reminders.
 * `status` is also the check: whether the link is on and whether this computer may read Reminders. The background service does the
 * regular syncing once `setup` has turned the link on.
 */
export async function runRemindersCommand(args: readonly string[], io: RemindersCommandIo): Promise<number> {
  const action = args[0];
  const json = args.includes("--json");
  const emit = (value: unknown, text: string) => io.out(json ? `${JSON.stringify(value)}\n` : text);
  if (process.platform !== "darwin") { emit({ supported: false }, "Apple Reminders is only available on macOS.\n"); return 1; }
  try {
    if (action === "setup") {
      const { created } = await setupReminders(io.run);
      await writeEnabled(true);
      emit({ enabled: true, list: REMINDER_LIST, created }, `Linked. ${created ? `Created the list "${REMINDER_LIST}".` : `The list "${REMINDER_LIST}" already exists.`} The background service keeps it in step with your tasks every few minutes.\n`);
      return 0;
    }
    if (action === "status") {
      const enabled = await readEnabled();
      let access = "ok";
      try { await checkReminderAccess(io.run); } catch (error) { access = error instanceof Error ? error.message : String(error); }
      const ok = access === "ok";
      emit({ enabled, access, list: REMINDER_LIST }, `Reminders link: ${enabled ? "on" : "off"}\nReminders access: ${access}\n${!enabled && ok ? "Turn it on with: frely task reminders setup\n" : ""}`);
      return ok ? 0 : 1;
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
  io.out("Usage: frely task reminders setup|status|sync|off [--json]\n");
  return 2;
}
