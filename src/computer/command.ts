import { access } from "node:fs/promises";
import { subcommandUsage } from "../agent-help.js";
import { cliLaunchArguments } from "../cli-launch.js";
import { addManualEntry, loadManualEntries, removeManualEntry } from "../runtime/local-mcp.js";
import { OCU_VERSION, ocuBinaryPath } from "./ocu.js";
import { installOcuRuntime } from "./runtime.js";
import { COMPUTER_MCP_NAME, computerEntryRegistered } from "./server.js";

/**
 * `frely computer enable|disable|status`. Computer use is an official local MCP named `computer`:
 * enabling registers `frely computer mcp` in the local MCP list (the local key of the two-key rule),
 * and the web connections page turns that name on for remote clients (the web key).
 */
export async function runComputerCommand(args: string[]): Promise<string> {
  const action = args[0];
  if (action === undefined) return subcommandUsage("computer");
  if (action === "enable") {
    const present = () => access(ocuBinaryPath()).then(() => true, () => false);
    // First enable downloads the pinned runtime and verifies its checksum; nothing is registered if that fails.
    const downloaded = !(await present());
    if (downloaded) await installOcuRuntime();
    const [command, ...commandArgs] = cliLaunchArguments(process.argv[1] ?? "", ["computer", "mcp"]);
    if ((await loadManualEntries()).some((entry) => entry.name === COMPUTER_MCP_NAME)) await removeManualEntry(COMPUTER_MCP_NAME);
    await addManualEntry({ name: COMPUTER_MCP_NAME, transport: "stdio", command: command!, args: commandArgs, path: process.env.PATH ?? "" });
    return [
      "Computer use is registered as the local MCP \"computer\" on this device.",
      "Turn it on for remote clients on the Frely connections page; until then no remote client can use it.",
      "While it is on, a connected client can see this screen and operate apps as you, except terminals, password managers, OS security prompts, system settings and Frely itself.",
      downloaded ? `Installed the computer-use runtime (open-computer-use ${OCU_VERSION}, checksum verified).` : "",
      process.platform === "darwin" ? "macOS: grant Accessibility and Screen Recording to \"Open Computer Use\" in System Settings when prompted." : "",
      "Turn it off at any time with `frely computer disable`.",
    ].filter(Boolean).join("\n") + "\n";
  }
  if (action === "disable") {
    const registered = await computerEntryRegistered();
    if (registered) await removeManualEntry(COMPUTER_MCP_NAME);
    return registered ? "Computer use is turned off.\n" : "Computer use was already off.\n";
  }
  if (action === "status") {
    const enabled = await computerEntryRegistered();
    const binary = ocuBinaryPath();
    const installed = await access(binary).then(() => true, () => false);
    const value = { enabled, runtimeVersion: OCU_VERSION, runtimeInstalled: installed };
    if (args.includes("--json")) return `${JSON.stringify(value)}\n`;
    return `Computer use: ${enabled ? "on locally (turn it on for remote clients on the Frely connections page)" : "off"}\nRuntime: open-computer-use ${OCU_VERSION}, ${installed ? "installed" : `not installed (${binary})`}\n`;
  }
  throw new Error(`Unknown computer command.\n${subcommandUsage("computer")}`);
}
