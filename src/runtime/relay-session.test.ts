import test from "node:test";
import assert from "node:assert/strict";
import { RelayNodeSession, type NodeFrameHandler } from "./relay-session.js";

/**
 * A [NodeFrameHandler] that echoes frames back (optionally uppercased) so the
 * session's base64 round-trip can be verified end to end. A [gate] simulates a
 * long-running frame; when [abortOnSignal] is set the frame rejects on abort.
 */
class EchoFrameHandler implements NodeFrameHandler {
  readonly received: Buffer[] = [];
  readonly cancellations: string[] = [];
  gate?: Promise<void>;
  abortOnSignal = false;

  constructor(private readonly uppercase: boolean) {}

  async handleFrame(frame: Buffer, signal: AbortSignal): Promise<Buffer> {
    this.received.push(frame);
    if (this.gate) {
      await new Promise<void>((resolve, reject) => {
        if (this.abortOnSignal) signal.addEventListener("abort", () => reject(new Error("cancelled")));
        void this.gate!.then(resolve);
      });
    }
    return this.uppercase ? Buffer.from(frame.toString("utf8").toUpperCase()) : frame;
  }

  cancelFrame(relayId: string): void {
    this.cancellations.push(relayId);
  }
}

test("RelayNodeSession round-trips base64 frames through the handler", async () => {
  const handler = new EchoFrameHandler(true);
  const session = new RelayNodeSession(handler);
  try {
    const response = (await session.execute({ frame: Buffer.from("hello").toString("base64") }, "relay-1")) as { frame: string };
    const decoded = Buffer.from(response.frame, "base64");
    assert.equal(decoded.toString("utf8"), "HELLO");
    assert.equal(handler.received.length, 1);
    assert.equal(handler.received[0]!.toString("utf8"), "hello");
  } finally {
    await session.close();
  }
});

test("RelayNodeSession rejects malformed payloads", async () => {
  const session = new RelayNodeSession(new EchoFrameHandler(false));
  try {
    await assert.rejects(() => session.execute({ notAFrame: true }, "relay-2"), /missing a base64/);
    await assert.rejects(() => session.execute("string-payload", "relay-3"), /Invalid node frame payload/);
  } finally {
    await session.close();
  }
});

test("RelayNodeSession.cancel aborts an in-flight frame", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handler = new EchoFrameHandler(false);
  handler.gate = gate;
  handler.abortOnSignal = true;
  const session = new RelayNodeSession(handler);
  try {
    const pending = session.execute({ frame: Buffer.from("z").toString("base64") }, "relay-6");
    session.cancel("relay-6");
    assert.deepEqual(handler.cancellations, ["relay-6"]);
    release();
    await assert.rejects(pending);
  } finally {
    await session.close();
  }
});

test("RelayNodeSession.close aborts all pending frames", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const handler = new EchoFrameHandler(false);
  handler.gate = gate;
  handler.abortOnSignal = true;
  const session = new RelayNodeSession(handler);
  try {
    const pending = session.execute({ frame: Buffer.from("y").toString("base64") }, "relay-5");
    await session.close();
    release();
    await assert.rejects(pending);
  } finally {
    await session.close();
  }
});
