import { checkReminderAccess, readEnabled, setupReminders, syncReminders, writeEnabled, type Reminders } from "./sync.js";
import { REMINDER_LIST } from "./plan.js";

type Call = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export interface RemindersCommandIo { out: (text: string) => void; call: Call; run?: Reminders }

/**
 * `frely doctor reminders [--setup | --sync | --off] [--json]` (macOS only): checks the link between the signed-in account's tasks and
 * Apple Reminders, and with a flag turns it on, runs one sync, or turns it off. Like `frely computer doctor`, the doctor is also where the
 * one-time setup lives; the background service does the regular syncing.
 */
export async function runRemindersDoctor(args: readonly string[], io: RemindersCommandIo): Promise<number> {
  const json = args.includes("--json");
  const emit = (value: unknown, text: string) => io.out(json ? `${JSON.stringify(value)}\n` : text);
  if (process.platform !== "darwin") { emit({ supported: false }, "Apple Reminders is only available on macOS.\n"); return 1; }
  try {
    if (args.includes("--setup")) {
      const { created } = await setupReminders(io.run);
      await writeEnabled(true);
      emit({ enabled: true, list: REMINDER_LIST, created }, `Linked. ${created ? `Created the list "${REMINDER_LIST}".` : `The list "${REMINDER_LIST}" already exists.`} The background service keeps it in step with your tasks every few minutes.\n`);
      return 0;
    }
    if (args.includes("--off")) { await writeEnabled(false); emit({ enabled: false }, "Off. The reminders already in the list stay; delete the list in Reminders if you do not want them.\n"); return 0; }
    if (args.includes("--sync")) {
      const result = await syncReminders(io.call, io.run);
      emit(result, `${result.actions} change${result.actions === 1 ? "" : "s"}${result.failed.length ? `, ${result.failed.length} failed:\n${result.failed.join("\n")}` : ""}\n`);
      return result.failed.length ? 1 : 0;
    }
    // The check: is the tool there, may it read Reminders, is the link on.
    const enabled = await readEnabled();
    let access = "ok";
    try { await checkReminderAccess(io.run); } catch (error) { access = error instanceof Error ? error.message : String(error); }
    const ok = access === "ok";
    emit({ enabled, access: ok ? "ok" : access, list: REMINDER_LIST }, `Reminders link: ${enabled ? "on" : "off"}\nReminders access: ${ok ? "ok" : access}\n${!enabled && ok ? "Turn it on with: frely doctor reminders --setup\n" : ""}`);
    return ok ? 0 : 1;
  } catch (error) {
    io.out(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
