/**
 * `frely app ops`: stdio bridge to the local agent ops socket.
 *
 * The Frely App GUI cannot open Unix domain sockets from Dart, so it spawns
 * this command instead: the process connects to `<state>/agent/ops.sock`,
 * bridges stdin -> socket and socket -> stdout line by line, and exits 1 with
 * a stderr hint when no serving process is running. This keeps the socket's
 * same-user permission boundary (the bridge runs as the current user) while
 * giving the GUI a plain NDJSON stream with tasks_changed pushes.
 */
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";

import { agentStateDir } from "./task-store.js";
import { pingAgentOpsSocket } from "./ops-server.js";

export async function runAgentOpsStdioBridge(args: { stdout: NodeJS.WriteStream; stdin: NodeJS.ReadStream; stderr: NodeJS.WriteStream }): Promise<number> {
  const socketPath = `${agentStateDir()}/ops.sock`;
  const probe = await pingAgentOpsSocket(socketPath, 1000);
  if (!probe.running) {
    args.stderr.write(`Agent ops socket is not reachable at ${socketPath}. Start it with: frely mcp serve\n`);
    return 1;
  }
  await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (!settled) {
        settled = true;
        resolve(code);
      }
    };
    const socket: Socket = connect(socketPath);
    socket.on("error", (error) => {
      args.stderr.write(`Agent ops socket failed: ${error instanceof Error ? error.message : String(error)}\n`);
      finish(1);
    });
    socket.on("close", () => finish(0));
    socket.pipe(args.stdout);
    const lines = createInterface({ input: args.stdin });
    lines.on("line", (line) => {
      if (line.trim().length > 0 && !socket.destroyed) socket.write(`${line}\n`);
    });
    args.stdin.on("close", () => socket.end());
    args.stdin.on("end", () => socket.end());
  });
  return 0;
}
