import { access } from "node:fs/promises";
import { subcommandUsage } from "../agent-help.js";
import { loadManualEntries, removeManualEntry } from "../runtime/local-mcp.js";
import { COMPUTER_MCP_NAME, computerLocallyVetoed, setComputerLocalVeto } from "./builtin.js";
import { OCU_VERSION, ocuBinaryPath } from "./ocu.js";
import { installOcuRuntime } from "./runtime.js";

/** An entry named `computer` that an earlier `frely computer enable` registered by hand; the built-in entry replaces it. */
async function removeLegacyEntry(): Promise<boolean> {
  if (!(await loadManualEntries().catch(() => [])).some((entry) => entry.name === COMPUTER_MCP_NAME)) return false;
  await removeManualEntry(COMPUTER_MCP_NAME);
  return true;
}

/**
 * `frely computer enable|disable|status`. Computer use is a built-in local MCP named `computer`: every device offers it, and the
 * switch on the Frely connections page (which asks for a passkey or authenticator code) is what turns it on for remote clients.
 * The runtime is installed on first use. `disable` is a local veto the web cannot override; `enable` lifts it.
 */
export async function runComputerCommand(args: string[]): Promise<string> {
  const action = args[0];
  if (action === undefined) return subcommandUsage("computer");
  if (action === "enable") {
    const present = () => access(ocuBinaryPath()).then(() => true, () => false);
    // Lifting the veto is all that is needed; downloading the pinned runtime (checksum verified) now only saves the wait on first use.
    const downloaded = !(await present());
    if (downloaded) await installOcuRuntime();
    await setComputerLocalVeto(false);
    await removeLegacyEntry();
    return [
      "Computer use is allowed on this device. It stays off until you turn it on for this device on the Frely connections page.",
      "While it is on, a connected client can see this screen and operate apps as you, except terminals, password managers, OS security prompts, system settings and Frely itself.",
      downloaded ? `Installed the computer-use runtime (open-computer-use ${OCU_VERSION}, checksum verified).` : "",
      process.platform === "darwin" ? "macOS: the first use asks this Mac for Accessibility and Screen Recording permission for \"Open Computer Use\"; grant both in System Settings." : "",
      "Block it on this device at any time with `frely computer disable`; the web page cannot override that.",
    ].filter(Boolean).join("\n") + "\n";
  }
  if (action === "disable") {
    const vetoed = await computerLocallyVetoed();
    await setComputerLocalVeto(true);
    await removeLegacyEntry();
    return vetoed ? "Computer use was already blocked on this device.\n" : "Computer use is blocked on this device. The Frely connections page cannot turn it on until you run `frely computer enable`.\n";
  }
  if (action === "status") {
    const enabled = !(await computerLocallyVetoed());
    const binary = ocuBinaryPath();
    const installed = await access(binary).then(() => true, () => false);
    const value = { enabled, runtimeVersion: OCU_VERSION, runtimeInstalled: installed };
    if (args.includes("--json")) return `${JSON.stringify(value)}\n`;
    return `Computer use: ${enabled ? "allowed here (turn it on for this device on the Frely connections page)" : "blocked on this device (run `frely computer enable` to allow it)"}\nRuntime: open-computer-use ${OCU_VERSION}, ${installed ? "installed" : `not installed yet (${binary}); it installs on first use`}\n`;
  }
  throw new Error(`Unknown computer command.\n${subcommandUsage("computer")}`);
}
