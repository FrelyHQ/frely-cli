import { createConnection, createServer, type Socket } from "node:net";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** An existing relay owns this gate; no updater daemon or remote upgrade jobs. */
export class MaintenanceGate {
  private paused = false;
  private requests = 0;
  private readonly processes = new Set<() => number>();
  enter(): () => void {
    if (this.paused) throw new Error("Frely is preparing an upgrade. Retry after it completes.");
    return this.track();
  }
  track(): () => void {
    this.requests++;
    let done = false;
    return () => { if (!done) { done = true; this.requests--; } };
  }
  registerProcesses(count: () => number): () => void {
    this.processes.add(count);
    return () => this.processes.delete(count);
  }
  pause(): void {
    if (this.paused) throw new Error("Another upgrade holds this service.");
    this.paused = true;
  }
  resume(): void { this.paused = false; }
  get idle(): boolean { return this.requests === 0 && [...this.processes].every((count) => count() === 0); }
}

export function maintenancePath(pid: number): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", `upgrade-${pid}.sock`);
}

export async function serveMaintenance(gate: MaintenanceGate, path = maintenancePath(process.pid)) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const directory = await lstat(dirname(path));
  if (directory.isSymbolicLink() || !directory.isDirectory() || directory.uid !== process.getuid?.()) throw new Error("Unsafe maintenance directory.");
  await chmod(dirname(path), 0o700);
  let owner: Socket | undefined;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); if (owner === socket) { owner = undefined; gate.resume(); } });
    socket.setTimeout(2000, () => socket.destroy());
    let input = "";
    socket.on("data", (data) => {
      input += data.toString("utf8");
      if (input.length > 32 || owner === socket) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      if (input !== "drain\n" || owner) { socket.end("busy\n"); return; }
      owner = socket;
      gate.pause();
      socket.setTimeout(0);
      const deadline = Date.now() + 3000;
      const interval = setInterval(() => {
        if (gate.idle) { clearInterval(interval); socket.write("ready\n"); }
        else if (Date.now() >= deadline) { clearInterval(interval); socket.end("busy\n"); }
      }, 50);
      socket.once("close", () => clearInterval(interval));
    });
  });
  server.maxConnections = 4;
  // Refuse an existing socket instead of unlinking another runtime's endpoint.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  await chmod(path, 0o600);
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path, { force: true });
  };
}

export async function acquireMaintenance(pid: number, path = maintenancePath(pid)): Promise<() => void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error("The running service has no private upgrade endpoint. Finish its tasks and restart it from a local terminal before upgrading.");
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const fail = () => { socket.destroy(); reject(new Error("The service is busy or cannot enter maintenance. Finish its tasks, then run frely upgrade in a local terminal.")); };
    socket.setTimeout(5000, fail);
    socket.once("error", fail);
    socket.once("connect", () => socket.write("drain\n"));
    let text = "", ready = false;
    socket.on("data", (data) => {
      text += data.toString("utf8");
      if (text.length > 32 || (text.includes("\n") && text !== "ready\n")) { fail(); return; }
      if (text === "ready\n") {
        ready = true;
        socket.setTimeout(0);
        resolve(() => socket.destroy());
      }
    });
    socket.once("close", () => { if (!ready) fail(); });
  });
}
