#!/usr/bin/env node
// Real-systemd lifecycle check for the background service, against a fake relay. No mocks of the service or the supervisor.
//   node scripts/systemd-upgrade-smoke.mjs <old-binary> <new-binary>
// 1. old release runs as a systemd user service and connects.
// 2. the installation is replaced by the new build (what `frely update` does): within 60 s the old pid is gone and the
//    new version is connected from a new pid.
// 3. the relay closes the connection with 4412 (hourly hard lifetime): the same process reconnects within 60 s.
// 4. the relay goes down and comes back: the same process reconnects within 60 s.
// It writes a unit named frely-mcp.service into the real user's systemd directory, so it only runs in CI (or with FRELY_SMOKE_ALLOW=1).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocketServer } from "ws";

if (!process.env.GITHUB_ACTIONS && process.env.FRELY_SMOKE_ALLOW !== "1") throw new Error("This check installs frely-mcp.service for the current user; run it in CI or set FRELY_SMOKE_ALLOW=1.");
const [oldBinary, newBinary] = process.argv.slice(2).map((p) => resolve(p));
if (!oldBinary || !newBinary) throw new Error("usage: systemd-upgrade-smoke.mjs <old-binary> <new-binary>");
const PROTOCOL = "frely.device-relay.v1";
const WITHIN_MS = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const systemctl = (...args) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8" });
const versionOf = (binary) => execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();

const base = mkdtempSync(join(tmpdir(), "frely-systemd-smoke-"));
const home = join(base, "home"), config = join(base, "config"), data = join(base, "data"), state = join(base, "state"), bin = join(base, "bin");
for (const dir of [home, config, data, state, bin]) mkdirSync(dir, { recursive: true, mode: 0o700 });
const installed = join(bin, "frely");
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
const unitPath = join(unitDir, "frely-mcp.service");

// ---- fake relay ----
const seen = []; // { at, pid, version } for every device connection that reported capabilities
let sockets = new Set();
let server, wss, port = 0;
function startRelay() {
  server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    const body = (value) => response.end(JSON.stringify(value));
    if (request.method === "GET" && request.url === "/api/auth/me") return body({ user: { id: "user_smoke", email: "smoke@example.com" } });
    if (request.method === "POST" && request.url === "/api/user/device-relay/enroll") return body({ deviceId: "device_smoke" });
    if (request.method === "POST" && request.url === "/api/user/device-relay/connect") {
      return body({ websocketUrl: `ws://127.0.0.1:${port}/device-relay`, accessToken: "smoke-grant", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    response.writeHead(404); response.end("{}");
  });
  wss = new WebSocketServer({ server, handleProtocols: () => PROTOCOL });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString("utf8"));
        if (frame.type === "device_capabilities" && frame.capabilities?.instance) seen.push({ at: Date.now(), pid: frame.capabilities.instance.pid, version: frame.capabilities.instance.version });
      } catch { /* the protocol is the CLI's concern */ }
    });
  });
  return new Promise((resolveListen) => server.listen(port, "127.0.0.1", () => { port = server.address().port; resolveListen(); }));
}
async function stopRelay() {
  for (const socket of sockets) socket.terminate();
  sockets = new Set();
  wss.close();
  await new Promise((r) => server.close(() => r()));
}
async function waitFor(label, predicate, ms = WITHIN_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await sleep(500); }
  throw new Error(`timed out after ${ms / 1000}s: ${label}`);
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

// ---- service setup ----
const oldVersion = versionOf(oldBinary), newVersion = versionOf(newBinary);
assert.notEqual(oldVersion, newVersion, "the new build must have a different version from the old release");
function seedLogin(origin) {
  mkdirSync(join(config, "frely"), { recursive: true, mode: 0o700 });
  writeFileSync(join(config, "frely", "config.json"), JSON.stringify({ version: 3, relayUrl: origin, user: { id: "user_smoke", email: "smoke@example.com" } }), { mode: 0o600 });
  const root = join(config, "frely", "basic-credentials-v1");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const entry = createHash("sha256").update(JSON.stringify(["frely-cli-basic-v1", origin])).digest("hex") + ".json";
  writeFileSync(join(root, entry), JSON.stringify({ version: 1, value: JSON.stringify({ version: 1, type: "basic-oauth", accessToken: "smoke-session", expiresAt: Date.now() + 86_400_000 }) }) + "\n", { mode: 0o600 });
}
function writeUnit() {
  mkdirSync(unitDir, { recursive: true });
  // Mirrors systemdUnit() in src/service.ts (Restart=always, RestartSec=3, RestartPreventExitStatus=77); keep them in step.
  const exec = [installed, "mcp", "serve", "--service-config-home", config, "--service-credential-store", "basic", "--standby"].map((a) => `"${a}"`).join(" ");
  writeFileSync(unitPath, `[Unit]\nDescription=Frely Device Relay (smoke)\n\n[Service]\nType=simple\nExecStart=${exec}\nRestart=always\nRestartSec=3\nRestartPreventExitStatus=77\n`
    + `Environment="HOME=${home}"\nEnvironment="XDG_CONFIG_HOME=${config}"\nEnvironment="XDG_DATA_HOME=${data}"\nEnvironment="XDG_STATE_HOME=${state}"\nEnvironment="FRELY_NO_BROWSER=1"\nEnvironment="PATH=/usr/local/bin:/usr/bin:/bin"\n\n[Install]\nWantedBy=default.target\n`);
}
const journal = () => { try { return execFileSync("journalctl", ["--user", "-u", "frely-mcp.service", "--no-pager", "-n", "80"], { encoding: "utf8" }); } catch { return "(no journal)"; } };

let failed = false;
try {
  await startRelay();
  seedLogin(`http://127.0.0.1:${port}`);
  copyFileSync(oldBinary, installed); chmodSync(installed, 0o755);
  writeUnit();
  systemctl("daemon-reload");
  systemctl("start", "frely-mcp.service");

  const first = await waitFor(`old release ${oldVersion} connected`, () => seen.find((s) => s.version === oldVersion));
  console.log(`1. old release ${oldVersion} connected (pid ${first.pid})`);

  // Replace the installation like `frely update` does: a complete file renamed over the old one.
  const staged = join(bin, ".frely.new");
  copyFileSync(newBinary, staged); chmodSync(staged, 0o755); renameSync(staged, installed);
  const started = Date.now();
  const second = await waitFor(`new build ${newVersion} connected from a new pid`, () => seen.find((s) => s.version === newVersion && s.pid !== first.pid));
  await waitFor(`old pid ${first.pid} is gone`, () => !alive(first.pid), 10_000);
  console.log(`2. upgraded to ${newVersion} (pid ${second.pid}) in ${Math.round((Date.now() - started) / 1000)}s; old pid ${first.pid} is gone`);

  // The relay ends the connection (hourly hard lifetime): same process, new connection.
  const before = seen.length;
  for (const socket of sockets) socket.close(4412, "hard_lifetime");
  await waitFor("reconnect after a 4412 close", () => seen.length > before);
  assert.equal(seen.at(-1).pid, second.pid, "a relay close must not restart the process");
  console.log("3. reconnected after a 4412 close");

  // The relay goes away and comes back on the same address.
  const beforeRestart = seen.length;
  await stopRelay();
  await sleep(8000);
  await startRelay();
  await waitFor("reconnect after a relay restart", () => seen.length > beforeRestart);
  assert.equal(seen.at(-1).pid, second.pid, "a relay restart must not restart the process");
  console.log("4. reconnected after the relay restarted");
  console.log("systemd upgrade smoke passed");
} catch (error) {
  failed = true;
  console.error(error);
  console.error("--- service journal ---\n" + journal());
} finally {
  try { systemctl("stop", "frely-mcp.service"); } catch { /* not running */ }
  rmSync(unitPath, { force: true });
  try { systemctl("daemon-reload"); } catch { /* ignore */ }
  try { await stopRelay(); } catch { /* already stopped */ }
  rmSync(base, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
