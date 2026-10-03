import { access } from "node:fs/promises";
import { subcommandUsage } from "../agent-help.js";
import { OCU_VERSION, ocuBinaryPath } from "./ocu.js";
import { clearComputerSwitch, readComputerSwitch, writeComputerSwitch } from "./state.js";

/** `frely computer enable|disable|status`: the local key of the two-key rule (plan computer-use D3). Returns the text to print. */
export async function runComputerCommand(args: string[]): Promise<string> {
  const action = args[0];
  if (action === undefined) return subcommandUsage("computer");
  if (action === "enable") {
    await writeComputerSwitch();
    const installed = await access(ocuBinaryPath()).then(() => true, () => false);
    return [
      "Computer use is turned on locally.",
      "It also needs the Computer use permission granted on the Frely connections page (a passkey or TOTP check). Until then no remote client can use it.",
      "While it is on, a connected client can see this screen and operate apps as you, except terminals, password managers, OS security prompts, system settings and Frely itself.",
      installed ? "" : `Runtime not found at ${ocuBinaryPath()}; open-computer-use ${OCU_VERSION} must be installed there first.`,
      "Turn it off at any time with `frely computer disable`.",
    ].filter(Boolean).join("\n") + "\n";
  }
  if (action === "disable") return (await clearComputerSwitch()) ? "Computer use is turned off.\n" : "Computer use was already off.\n";
  if (action === "status") {
    const enabled = await readComputerSwitch();
    const binary = ocuBinaryPath();
    const installed = await access(binary).then(() => true, () => false);
    const value = { enabled: enabled !== null, ...(enabled ? { enabledAt: enabled.enabledAt } : {}), runtimeVersion: OCU_VERSION, runtimeInstalled: installed };
    if (args.includes("--json")) return `${JSON.stringify(value)}\n`;
    return `Computer use: ${value.enabled ? `on (since ${enabled!.enabledAt})` : "off"}\nRuntime: open-computer-use ${OCU_VERSION}, ${installed ? "installed" : `not installed (${binary})`}\n`;
  }
  throw new Error(`Unknown computer command.\n${subcommandUsage("computer")}`);
}
