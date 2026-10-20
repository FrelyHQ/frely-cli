import { IS_STANDALONE } from "../cli-launch.js";
import { embeddedIroh } from "./iroh-native.js";
import { TRANSFER_MAX_BYTES } from "./transfer.js";
import type { Workspace } from "./workspace.js";
import { createHash, randomBytes } from "node:crypto";
import type * as IrohTypes from "@number0/iroh";

type Iroh = typeof IrohTypes;

const ALPN = Array.from(Buffer.from("frely/transfer/1"));
const CHUNK = 256 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const SEND_WAIT_MS = 100_000;
const LISTEN_TIMEOUT_MS = 10 * 60_000;
const IDLE_CLOSE_MS = 10 * 60_000;
const MAX_HEADER = 4096;
const MAX_JOBS = 32;

export interface P2pAddress { id: string; relayUrl: string | null; directAddresses: string[] }
export interface P2pInfo extends P2pAddress { supported: true }
export interface P2pJob { jobId: string; status: "running" | "done" | "failed"; role: "send" | "receive"; bytes: number; relayBytes?: number; viaRelay?: boolean; path?: string; error?: string }

/** The module, or null on a platform that has no iroh build (Intel Macs) or when it cannot be loaded. */
async function loadIroh(): Promise<Iroh | null> {
  const unwrap = (module: unknown) => ((module as { default?: Iroh })?.default ?? module) as Iroh;
  if (embeddedIroh) return unwrap(embeddedIroh);
  // The single file embeds the module or has none; only the npm package resolves it from node_modules (not bundled).
  if (IS_STANDALONE) return null;
  const name = "@number0/iroh";
  try { return unwrap(await import(name)); } catch { return null; }
}

function relayUrlOf(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("relayUrl must be a string.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("The relay URL must be https without credentials.");
  return url.toString();
}

const timeout = <T>(work: Promise<T>, ms: number, message: string) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  timer.unref();
  work.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

/** One iroh endpoint per process, started when a transfer first needs it and closed after ten idle minutes. */
export class P2pTransfers {
  private endpoint: IrohTypes.Endpoint | null = null;
  private starting: Promise<IrohTypes.Endpoint> | null = null;
  private relay: string | null = null;
  private idle: NodeJS.Timeout | null = null;
  private active = 0;
  private readonly jobs = new Map<string, P2pJob>();

  async supported(): Promise<boolean> { return (await loadIroh()) !== null; }

  async info(relayInput: unknown): Promise<P2pInfo> {
    const relayUrl = relayUrlOf(relayInput);
    const endpoint = await this.start(relayUrl);
    if (relayUrl) await timeout(endpoint.online(), CONNECT_TIMEOUT_MS, "Could not reach the Frely relay.");
    const addr = endpoint.addr();
    const direct = addr.directAddresses();
    // Without a relay (tests, LAN only) the bound sockets are the only addresses there are.
    const addresses = direct.length > 0 || relayUrl ? direct : endpoint.boundSockets().map((socket) => socket.replace("0.0.0.0", "127.0.0.1").replace("[::]", "[::1]"));
    return { supported: true, id: endpoint.id().toString(), relayUrl: addr.relayUrl() ?? relayUrl, directAddresses: addresses };
  }

  status(jobId: string): P2pJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Unknown transfer job.");
    return { ...job };
  }

  /** Waits for the one expected peer and writes its file; returns at once, the job runs in the background. */
  async listen(workspace: Workspace, input: { path: string; bytes: number; sha256: string; overwrite: boolean; from: string; relayUrl?: unknown }): Promise<P2pJob> {
    const endpoint = await this.start(relayUrlOf(input.relayUrl));
    const job = this.newJob("receive", input.bytes);
    this.hold();
    void (async () => {
      let peer: IrohTypes.Connection | undefined;
      let bi: IrohTypes.BiStream | undefined;
      try {
        peer = await timeout(this.acceptFrom(endpoint, input.from), LISTEN_TIMEOUT_MS, "Nobody sent the file in time.");
        bi = await peer.acceptBi();
        const header = JSON.parse(Buffer.from(await bi.recv.readExact(Buffer.from(await bi.recv.readExact(4)).readUInt32BE(0))).toString("utf8")) as { bytes?: number; sha256?: string };
        if (header.bytes !== input.bytes || header.sha256 !== input.sha256) throw new Error("The sender offered a different file than expected.");
        const written = await workspace.writeStream(input.path, this.body(bi.recv, input.bytes), input.overwrite, { bytes: input.bytes, sha256: input.sha256 });
        await bi.send.writeAll(Array.from(Buffer.from("ok")));
        await bi.send.finish();
        await timeout(peer.closed(), 5000, "").catch(() => undefined);
        Object.assign(job, { status: "done", path: written.path });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Receiving failed.";
        Object.assign(job, { status: "failed", error: message });
        // Tell the sender why instead of leaving it to wait for the connection to time out.
        await bi?.send.writeAll(Array.from(Buffer.from(message.slice(0, 200)))).then(() => bi?.send.finish()).catch(() => undefined);
        peer?.close(2n, Array.from(Buffer.from("failed")));
      } finally { this.release(); }
    })();
    return { ...job };
  }

  /** Sends one file to a prepared peer. Waits up to 100 seconds, then leaves the job running. */
  async send(workspace: Workspace, input: { path: string; bytes: number; sha256: string; to: P2pAddress; relayUrl?: unknown }): Promise<P2pJob> {
    const iroh = await this.module();
    const endpoint = await this.start(relayUrlOf(input.relayUrl));
    const job = this.newJob("send", input.bytes);
    this.hold();
    const run = (async () => {
      const { handle, bytes } = await workspace.openForTransfer(input.path, TRANSFER_MAX_BYTES);
      try {
        if (bytes !== input.bytes) throw new Error("The file changed after it was prepared.");
        const target = new iroh.EndpointAddr(iroh.EndpointId.fromString(input.to.id), input.to.relayUrl, input.to.directAddresses);
        const connection = await timeout(endpoint.connect(target, ALPN), CONNECT_TIMEOUT_MS, "Could not reach the other device.");
        const bi = await connection.openBi();
        const header = Buffer.from(JSON.stringify({ bytes, sha256: input.sha256 }));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(header.length, 0);
        await bi.send.writeAll(Array.from(Buffer.concat([length, header])));
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, highWaterMark: CHUNK })) {
          hash.update(chunk as Buffer);
          await bi.send.writeAll(Array.from(chunk as Buffer));
        }
        if (hash.digest("hex") !== input.sha256) throw new Error("The file changed while it was being sent.");
        await bi.send.finish();
        const answer = Buffer.from(await bi.recv.readToEnd(256)).toString("utf8");
        if (answer !== "ok") throw new Error(answer || "The other device did not confirm the file.");
        const relayPaths = connection.paths().filter((path) => path.isRelay);
        const relayBytes = relayPaths.reduce((sum, path) => sum + path.stats.udpTxBytes + path.stats.udpRxBytes, 0);
        Object.assign(job, { status: "done", relayBytes, viaRelay: relayBytes > 0 });
        connection.close(0n, []);
      } finally { await handle.close(); }
    })().catch((error) => { Object.assign(job, { status: "failed", error: error instanceof Error ? error.message : "Sending failed." }); }).finally(() => this.release());
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, SEND_WAIT_MS).unref())]);
    return { ...job };
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    const endpoint = this.endpoint;
    this.endpoint = null;
    this.starting = null;
    await endpoint?.close().catch(() => undefined);
  }

  private async module(): Promise<Iroh> {
    const iroh = await loadIroh();
    if (!iroh) throw new Error("This device cannot do direct transfers (no iroh build for this platform).");
    return iroh;
  }

  private async start(relayUrl: string | null): Promise<IrohTypes.Endpoint> {
    if (this.endpoint && this.relay === relayUrl) return this.endpoint;
    if (this.starting && this.relay === relayUrl) return this.starting;
    if (this.endpoint && this.active > 0) throw new Error("A transfer is running; try again when it has finished.");
    await this.close();
    const iroh = await this.module();
    this.relay = relayUrl;
    // Only the Frely relay: no n0 public relays or discovery, so devices find each other through Frely alone.
    this.starting = (async () => {
      const builder = iroh.Endpoint.builder();
      builder.applyMinimal();
      builder.alpns([ALPN]);
      builder.relayMode(relayUrl ? iroh.RelayMode.customFromUrls([relayUrl]) : iroh.RelayMode.disabled());
      const endpoint = await builder.bind();
      this.endpoint = endpoint;
      return endpoint;
    })();
    this.armIdle();
    return this.starting;
  }

  private async acceptFrom(endpoint: IrohTypes.Endpoint, from: string): Promise<IrohTypes.Connection> {
    for (;;) {
      const incoming = await endpoint.acceptNext();
      if (!incoming) throw new Error("The device stopped listening.");
      const connection = await (await incoming.accept()).connect();
      if (connection.remoteId().toString() === from) return connection;
      connection.close(1n, Array.from(Buffer.from("unexpected peer")));
    }
  }

  private async *body(recv: IrohTypes.RecvStream, bytes: number): AsyncGenerator<Buffer> {
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = await recv.read(Math.min(remaining, CHUNK));
      if (!chunk || chunk.length === 0) throw new Error("The sender stopped early.");
      remaining -= chunk.length;
      yield Buffer.from(chunk);
    }
  }

  private newJob(role: P2pJob["role"], bytes: number): P2pJob {
    if (this.jobs.size >= MAX_JOBS) {
      for (const [id, job] of this.jobs) { if (job.status !== "running") { this.jobs.delete(id); break; } }
    }
    const job: P2pJob = { jobId: `p2p_${randomBytes(8).toString("hex")}`, status: "running", role, bytes };
    this.jobs.set(job.jobId, job);
    return job;
  }

  private hold() { this.active += 1; if (this.idle) { clearTimeout(this.idle); this.idle = null; } }
  private release() { this.active -= 1; this.armIdle(); }
  private armIdle() {
    if (this.active > 0) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => { void this.close(); }, IDLE_CLOSE_MS);
    this.idle.unref();
  }
}
