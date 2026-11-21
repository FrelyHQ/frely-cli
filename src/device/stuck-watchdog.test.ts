import test from "node:test";
import assert from "node:assert/strict";
import { SERVICE_AUTH_REQUIRED } from "../service.js";
import { SERVICE_STUCK_EXIT_CODE, STUCK_DISCONNECT_MS, relayReachable, startStuckWatchdog } from "./stuck-watchdog.js";

function setup(over: { busy?: () => boolean; reachable?: () => Promise<boolean> } = {}) {
  let clock = 0;
  let stuck = 0;
  const controller = new AbortController();
  const watchdog = startStuckWatchdog({
    busy: over.busy ?? (() => false), reachable: over.reachable ?? (async () => true), onStuck: () => { stuck++; },
    signal: controller.signal, now: () => clock, intervalMs: 3_600_000,
  });
  return { watchdog, advance: (ms: number) => { clock += ms; }, stuck: () => stuck, controller };
}

test("exit code is not the no-restart code", () => assert.notEqual(SERVICE_STUCK_EXIT_CODE, SERVICE_AUTH_REQUIRED));

test("restarts after 5 minutes disconnected while the relay answers", async () => {
  const t = setup();
  t.advance(STUCK_DISCONNECT_MS - 1);
  assert.equal(await t.watchdog.check(), false);
  t.advance(1);
  assert.equal(await t.watchdog.check(), true);
  assert.equal(await t.watchdog.check(), false, "asks only once");
  assert.equal(t.stuck(), 1);
  t.watchdog.stop();
});

test("a connection resets the clock", async () => {
  const t = setup();
  t.advance(STUCK_DISCONNECT_MS - 1);
  t.watchdog.connected();
  t.advance(STUCK_DISCONNECT_MS * 2);
  assert.equal(await t.watchdog.check(), false);
  t.watchdog.disconnected();
  t.advance(STUCK_DISCONNECT_MS - 1);
  assert.equal(await t.watchdog.check(), false);
  t.advance(1);
  assert.equal(await t.watchdog.check(), true);
  t.watchdog.stop();
});

test("never restarts while a call or managed process is running", async () => {
  let busy = true;
  const t = setup({ busy: () => busy });
  t.advance(STUCK_DISCONNECT_MS * 3);
  assert.equal(await t.watchdog.check(), false);
  busy = false;
  assert.equal(await t.watchdog.check(), true);
  t.watchdog.stop();
});

test("does not restart when the relay is unreachable", async () => {
  let up = false;
  const t = setup({ reachable: async () => up });
  t.advance(STUCK_DISCONNECT_MS * 3);
  assert.equal(await t.watchdog.check(), false);
  up = true;
  assert.equal(await t.watchdog.check(), true);
  t.watchdog.stop();
});

test("does not restart once stopped", async () => {
  const t = setup();
  t.advance(STUCK_DISCONNECT_MS * 2);
  t.controller.abort();
  assert.equal(await t.watchdog.check(), false);
  t.watchdog.stop();
});

test("relayReachable counts any HTTP answer", async () => {
  assert.equal(await relayReachable("https://relay.test", (async () => new Response(null, { status: 503 })) as typeof fetch), true);
  assert.equal(await relayReachable("https://relay.test", (async () => { throw new Error("down"); }) as typeof fetch), false);
});
