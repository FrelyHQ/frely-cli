import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cliLaunchArguments } from "../cli-launch.js";
import type { LocalMcpEntry } from "../runtime/local-mcp.js";
import { computerDir } from "./state.js";

/** Name of the built-in local MCP for computer use; the web connections page turns it on by this name. */
export const COMPUTER_MCP_NAME = "computer";

/** The local veto: while this marker exists, computer use is off on this device whatever the web page says. */
export const computerOptOutPath = (): string => join(computerDir(), "local-opt-out");

export async function computerLocallyVetoed(): Promise<boolean> {
  return access(computerOptOutPath()).then(() => true, () => false);
}

export async function setComputerLocalVeto(vetoed: boolean): Promise<void> {
  const path = computerOptOutPath();
  if (!vetoed) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, "computer use is turned off on this device (frely computer disable)\n", { mode: 0o600 });
}

/**
 * Computer use is built in: every device offers the local MCP `computer` without local registration, and the web switch is the
 * only key to turn it on. `frely computer disable` is the one thing the web cannot override, so the entry disappears while vetoed.
 */
export async function builtinLocalMcps(entryPoint: string = process.argv[1] ?? ""): Promise<LocalMcpEntry[]> {
  if (await computerLocallyVetoed()) return [];
  const [command, ...args] = cliLaunchArguments(entryPoint, ["computer", "mcp"]);
  return [{ name: COMPUTER_MCP_NAME, source: "manual", transport: "stdio", command: command!, args, path: process.env.PATH ?? "" }];
}
