import assert from "node:assert/strict";
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudToolError, installCloudItem, SEALED_LEASE_FILE, type CloudToolCaller } from "./cloud-item.js";
import { runSealedScript } from "./sealed-run.js";
import { loadOrCreateDeviceSealKey } from "./sealed.js";

const skillId = "cloud_skill_0123456789abcdef01234567";
const secret = Buffer.from("test-secret");
const b64 = (text: string) => Buffer.from(text).toString("base64");

/** The sender side of the format, written out here so the CLI is checked against the format and not against itself. */
const versionKey = (version: number) => Buffer.from(hkdfSync("sha256", secret, Buffer.from("frely.cloud-skill.seal.v1"), Buffer.from(`s1|${skillId}|${version}`), 32));
function seal(version: number, path: string, content: string): string {
  const fileKey = Buffer.from(hkdfSync("sha256", versionKey(version), Buffer.alloc(0), Buffer.from(`frely.cloud-skill.seal.file.v1|${path}`), 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", fileKey, nonce);
  cipher.setAAD(Buffer.from(`${skillId}|${version}|${path}`));
  const body = Buffer.concat([cipher.update(content), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}
function lease(version: number, devicePublicKey: string, expiresAt: string) {
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = Buffer.from(String(ephemeral.publicKey.export({ format: "jwk" }).x), "base64url");
  const deviceRaw = Buffer.from(devicePublicKey, "base64url");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: devicePublicKey }, format: "jwk" }) });
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, deviceRaw]), Buffer.from("frely.cloud-skill.seal.wrap.v1"), 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrapKey, nonce);
  cipher.setAAD(Buffer.from(`s1|${skillId}|${version}|${expiresAt}`));
  const body = Buffer.concat([cipher.update(versionKey(version)), cipher.final(), cipher.getAuthTag()]);
  return { keyId: "s1", expiresAt, ephemeralPublicKey: ephemeralRaw.toString("base64url"), nonce: nonce.toString("base64url"), wrappedKey: body.toString("base64url") };
}

const SCRIPT = 'printf "%s|%s" "$(cat "$(dirname "$0")/note.txt")" "$1" > "$2"\n';

/** A server with one Skill: a plain SKILL.md, a paid note and a paid sealed script. */
function server(options: { expiresIn?: number; renewFails?: "pass" | "network" } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const call: CloudToolCaller = async (name, input) => {
    assert.equal(name, "skills.install");
    calls.push(input);
    const manifest = { id: skillId, kind: "skill", slug: "demo", displayName: "Demo", version: 2, hasScripts: true, manifestDigest: "a".repeat(64), premium: { fileCount: 2, totalBytes: 10 }, scan: null };
    if (input.part === "free") return { manifest, files: [{ path: "SKILL.md", contentBase64: b64("# demo"), isScript: false }] };
    if (input.leaseOnly === true && options.renewFails === "pass") throw new CloudToolError("creator_pass_required");
    if (input.leaseOnly === true && options.renewFails === "network") throw new Error("offline");
    const expiresAt = new Date(Date.now() + (input.leaseOnly === true ? 7 * 24 * 3600_000 : options.expiresIn ?? 7 * 24 * 3600_000)).toISOString();
    const withLease = { ...manifest, lease: lease(2, String(input.sealTo), expiresAt) };
    if (input.leaseOnly === true) return { manifest: withLease, files: [] };
    return { manifest: withLease, files: [
      { path: "premium/note.txt", contentBase64: b64("the note"), isScript: false },
      { path: "premium/run.sh", sealed: true, sealedBase64: seal(2, "premium/run.sh", SCRIPT), isScript: true },
    ] };
  };
  return { call, calls };
}

async function setup(options: Parameters<typeof server>[0] = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "frely-sealed-")));
  const env = { ...process.env, XDG_CONFIG_HOME: join(home, ".config") };
  const remote = server(options);
  const result = await installCloudItem({ skillId, call: remote.call, host: "generic", scope: "global", home, env });
  return { home, env, remote, result, out: join(home, "out.txt") };
}

test("installs paid scripts as ciphertext with a placeholder and a lease", async () => {
  const { home, result, remote } = await setup();
  try {
    assert.equal(result.sealedScripts, 1);
    assert.equal(typeof remote.calls.find((input) => input.part === "premium")?.sealTo, "string");
    const placeholder = await readFile(join(result.path, "premium", "run.sh"), "utf8");
    assert.match(placeholder, /frely item run/u);
    assert.doesNotMatch(placeholder, /printf/u);
    const sealed = await readFile(join(result.path, ".frely-sealed", "files", "premium", "run.sh.sealed"));
    assert.equal(sealed.includes(Buffer.from("printf")), false);
    assert.equal(await readFile(join(result.path, "premium", "note.txt"), "utf8"), "the note");
    assert.equal(JSON.parse(await readFile(join(result.path, SEALED_LEASE_FILE), "utf8")).skillId, skillId);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("runs a sealed script from its decrypted copy and leaves no copy behind", async () => {
  const { home, env, remote, result, out } = await setup();
  try {
    const commands: string[] = [];
    const code = await runSealedScript({ target: join(result.path, "premium", "run.sh"), args: ["arg", out], call: remote.call, env, home, sandbox: async (command) => { commands.push(command); return command; } });
    assert.equal(code, 0);
    assert.equal(await readFile(out, "utf8"), "the note|arg");
    assert.match(commands[0]!, /^bash \S*frely-item-run-\S+\/premium\/run\.sh arg /u);
    assert.equal(remote.calls.filter((input) => input.leaseOnly === true).length, 0);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("renews a lease that is near its end", async () => {
  const { home, env, remote, result, out } = await setup({ expiresIn: 60_000 });
  try {
    const code = await runSealedScript({ target: join(result.path, "premium", "run.sh"), args: ["x", out], call: remote.call, env, home, sandbox: async (command) => command });
    assert.equal(code, 0);
    assert.equal(remote.calls.filter((input) => input.leaseOnly === true).length, 1);
    const stored = JSON.parse(await readFile(join(result.path, SEALED_LEASE_FILE), "utf8")) as { lease: { expiresAt: string } };
    assert.ok(Date.parse(stored.lease.expiresAt) - Date.now() > 6 * 24 * 3600_000);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("keeps running on the old lease while renewal fails, and stops when it has ended", async () => {
  const live = await setup({ expiresIn: 60_000, renewFails: "network" });
  try {
    assert.equal(await runSealedScript({ target: join(live.result.path, "premium", "run.sh"), args: ["x", live.out], call: live.remote.call, env: live.env, home: live.home, sandbox: async (command) => command }), 0);
    await assert.rejects(runSealedScript({ target: join(live.result.path, "premium", "run.sh"), args: ["x", live.out], call: live.remote.call, env: live.env, home: live.home, now: () => new Date(Date.now() + 3600_000), sandbox: async (command) => command }), /could not be renewed/u);
  } finally { await rm(live.home, { recursive: true, force: true }); }
});

test("removes the lease and refuses when the pass has ended", async () => {
  const { home, env, remote, result } = await setup({ expiresIn: 60_000, renewFails: "pass" });
  try {
    await assert.rejects(runSealedScript({ target: join(result.path, "premium", "run.sh"), args: [], call: remote.call, env, home, sandbox: async (command) => command }), /access to this item has ended/u);
    await assert.rejects(readFile(join(result.path, SEALED_LEASE_FILE)));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("a copy of the folder does not open on another device", async () => {
  const { home, remote, result } = await setup();
  const other = await realpath(await mkdtemp(join(tmpdir(), "frely-sealed-other-")));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: join(other, ".config") };
    await loadOrCreateDeviceSealKey(env, other);
    await assert.rejects(runSealedScript({ target: join(result.path, "premium", "run.sh"), args: [], call: remote.call, env, home: other, sandbox: async (command) => command }));
  } finally { await rm(home, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test("refuses a script that is not sealed", async () => {
  const { home, env, remote, result } = await setup();
  try {
    await writeFile(join(result.path, "premium", "plain.sh"), "echo hi\n");
    await assert.rejects(runSealedScript({ target: join(result.path, "premium", "plain.sh"), args: [], call: remote.call, env, home, sandbox: async (command) => command }), /not a sealed script/u);
  } finally { await rm(home, { recursive: true, force: true }); }
});
