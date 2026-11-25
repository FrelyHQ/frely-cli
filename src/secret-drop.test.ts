import test from "node:test";
import { HOSTED_INSTANCE, trustAnchor } from "./instance.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, subtle, webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setObserveIdentity } from "./trust/observe.js";
import { APPROVAL_DOMAIN, pinTrustChain, TRUST_DOMAIN, trustDirectory, trustRecordHash, type ApprovalPayload, type TrustRecord } from "./trust/record.js";
import { challengeFor, type Signer, type WebAuthnSignature } from "./trust/webauthn.js";
import { VAULT_ITEM_FIELDS, applySecretDrop, forgetSecretDropKeys, parseSecretDropTarget as parseAnyTarget, renderSecretFields, prepareSecretDrop, secretDropBinding, writerCommand, type SecretDropFileTarget as SecretDropTarget, type SecretDropTarget as AnySecretDropTarget } from "./secret-drop.js";

/** The tests below build file targets; the vault_unlock kind has its own tests. */
const parseSecretDropTarget = (value: unknown) => parseAnyTarget(value) as SecretDropTarget;
const ORIGIN = "https://approve.frely.cloud";
const b64 = (data: Buffer | string | Uint8Array) => Buffer.from(data).toString("base64url");
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest();
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signer: Signer = { id: "pk_1", kind: "webauthn", credId: b64("cred-1"), alg: -7, spki: b64(pair.publicKey.export({ type: "spki", format: "der" })) };
const record: TrustRecord = { typ: TRUST_DOMAIN, user: "usr_1", seq: 1, prev: null, rpId: "frely.cloud", approvalOrigins: [ORIGIN], signers: [signer] };
const DEVICE = "drd_" + "a".repeat(32);
const SECRET = "ghp_TESTSECRET0123456789abcdefghijklmnop";
const DROP = "sdrop_0123456789ab";

const assertion = (domain: string, payload: unknown): WebAuthnSignature => {
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeFor(domain, payload), origin: ORIGIN }));
  const authData = Buffer.concat([sha("frely.cloud"), Buffer.from([0x05]), Buffer.alloc(4)]);
  return { kind: "webauthn", credId: signer.credId, authData: b64(authData), clientData: b64(clientData), signature: b64(sign("sha256", Buffer.concat([authData, sha(clientData)]), pair.privateKey)) };
};

/** What apps/approve does in the browser: X25519 + HKDF-SHA256 + AES-256-GCM with WebCrypto. */
async function browserEncrypt(epk: string, dropId: string, secret: string): Promise<string> {
  const crypto = webcrypto as unknown as Crypto;
  const recipient = await subtle.importKey("raw", Buffer.from(epk, "base64url"), { name: "X25519" }, false, []);
  const own = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const bits = await subtle.deriveBits({ name: "X25519", public: recipient }, own.privateKey, 256);
  const hkdf = await subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  const aes = await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`frely.secret-drop.v1\0${dropId}`) }, hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(dropId) }, aes, new TextEncoder().encode(secret));
  return b64(Buffer.concat([Buffer.from(await subtle.exportKey("raw", own.publicKey)), iv, Buffer.from(sealed)]));
}

const target = (over: Partial<SecretDropTarget> = {}): SecretDropTarget => ({ kind: "file", path: "/tmp/x/ghcr-token", owner: "root", group: "root", mode: "0600", ...over });

function approval(args: { epk: string; ciphertext: string; target: AnySecretDropTarget }, over: Partial<ApprovalPayload> = {}, bind?: string) {
  const now = Date.now();
  const payload: ApprovalPayload = {
    typ: APPROVAL_DOMAIN, id: DROP, user: "usr_1", trust: trustRecordHash(record), trustSeq: 1, device: DEVICE, deviceKey: "thumb", authz: null,
    grant: { kind: "secret_drop", resource: DROP, mode: "once" },
    bind: { tool: "secret_drop_apply", cmdHash: bind ?? secretDropBinding({ dropId: DROP, target: args.target, epk: args.epk, ciphertext: args.ciphertext }) },
    iat: new Date(now).toISOString(), nbf: new Date(now).toISOString(), exp: new Date(now + 600_000).toISOString(), ...over,
  };
  return { payload, sig: assertion(APPROVAL_DOMAIN, payload) };
}

async function withDevice(run: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "frely-drop-"));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  try {
    setObserveIdentity({ device: DEVICE, deviceKey: "thumb", relayUrl: "https://r.test", userId: "usr_1" });
    await pinTrustChain([{ record, sig: assertion(TRUST_DOMAIN, record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    forgetSecretDropKeys();
    await run(root);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved;
    await rm(root, { recursive: true, force: true });
  }
}

const refusal = async (work: Promise<unknown>): Promise<string> => { try { await work; return "ok"; } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } };

test("a signed drop is decrypted in memory and written through the fixed template; the value is only on stdin and not in the receipt", async () => {
  await withDevice(async () => {
    const t = target();
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const ciphertext = await browserEncrypt(epk, DROP, SECRET);
    const calls: { command: string; args: string[]; stdin: string }[] = [];
    const run = async (command: string, args: string[], stdin: Buffer) => { calls.push({ command, args, stdin: stdin.toString("utf8") }); return { code: 0, stdout: "replaced=0\n", stderr: "" }; };
    const receipt = await applySecretDrop({ dropId: DROP, target: t, epk, ciphertext, approval: approval({ epk, ciphertext, target: t }) }, { run });
    assert.deepEqual(receipt, { status: "written", target: { kind: "file", path: t.path }, bytes: SECRET.length, owner: "root", group: "root", mode: "0600", replaced: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.stdin, SECRET);
    assert.equal(JSON.stringify(calls[0]!.args).includes(SECRET), false);
    assert.equal(JSON.stringify(receipt).includes(SECRET.slice(0, 6)), false);
  });
});

test("the key is single use: the same drop cannot be applied twice, and a drop this computer never prepared is refused", async () => {
  await withDevice(async () => {
    const t = target();
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const ciphertext = await browserEncrypt(epk, DROP, SECRET);
    const run = async () => ({ code: 0, stdout: "replaced=1", stderr: "" });
    const args = { dropId: DROP, target: t, epk, ciphertext, approval: approval({ epk, ciphertext, target: t }) };
    assert.equal((await applySecretDrop(args, { run })).replaced, true);
    assert.equal(await refusal(applySecretDrop(args, { run })), "drop_unknown");
  });
});

test("a relay that changes the destination, the key, the ciphertext or the approval is refused and nothing is written", async () => {
  await withDevice(async () => {
    const t = target();
    let wrote = 0;
    const run = async () => { wrote += 1; return { code: 0, stdout: "", stderr: "" }; };
    const attempt = async (mutate: (a: Record<string, unknown>, ctx: { epk: string; ciphertext: string }) => void, sign?: { over?: Partial<ApprovalPayload>; bind?: string }) => {
      const { epk } = prepareSecretDrop({ dropId: DROP });
      const ciphertext = await browserEncrypt(epk, DROP, SECRET);
      const args: Record<string, unknown> = { dropId: DROP, target: t, epk, ciphertext, approval: approval({ epk, ciphertext, target: t }, sign?.over, sign?.bind) };
      mutate(args, { epk, ciphertext });
      return refusal(applySecretDrop(args, { run }));
    };
    assert.equal(await attempt((a) => { a.target = target({ path: "/etc/shadow" }); }), "bind_mismatch");
    assert.equal(await attempt((a) => { a.target = target({ owner: "nobody" }); }), "bind_mismatch");
    assert.equal(await attempt((a) => { a.epk = b64(Buffer.alloc(32, 1)); }), "key_mismatch");
    assert.equal(await attempt((a, c) => { a.ciphertext = c.ciphertext.slice(0, -4) + "AAAA"; }), "bind_mismatch");
    assert.equal(await attempt(() => undefined, { bind: "x" }), "bind_mismatch");
    assert.equal(await attempt(() => undefined, { over: { device: "drd_" + "b".repeat(32) } }), "device_mismatch");
    assert.equal(await attempt(() => undefined, { over: { grant: { kind: "path_grant", resource: DROP, mode: "once" } } }), "wrong_grant");
    assert.equal(await attempt(() => undefined, { over: { grant: { kind: "secret_drop", resource: "sdrop_other0000", mode: "once" } } }), "wrong_grant");
    assert.equal(await attempt(() => undefined, { over: { exp: new Date(Date.now() - 1000).toISOString() } }), "expired");
    assert.equal(await attempt((a) => { delete a.approval; }), "approval_missing");
    assert.equal(wrote, 0);
  });
});

test("an approval signed for another ciphertext key (a swapped recipient) cannot decrypt: tampered ciphertext is refused after the binding", async () => {
  await withDevice(async () => {
    const t = target();
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const other = prepareSecretDrop({ dropId: "sdrop_other00000" });
    const ciphertext = await browserEncrypt(other.epk, DROP, SECRET);
    const run = async () => ({ code: 0, stdout: "", stderr: "" });
    assert.equal(await refusal(applySecretDrop({ dropId: DROP, target: t, epk, ciphertext, approval: approval({ epk, ciphertext, target: t }) }, { run })), "ciphertext_invalid");
  });
});

test("fixed vector: the binding the owner signs is the one the relay builds (friday-relay pins the same value)", () => {
  const vector = { kind: "ssh_file", host: "contabo_sg_ts", path: "/etc/zen-quant/ghcr-token", owner: "root", group: "root", mode: "0600" } as const;
  assert.equal(secretDropBinding({ dropId: "sdrop_0123456789ab", target: vector, epk: b64(Buffer.alloc(32, 7)), ciphertext: "AAAA" }), "c9MiRR0BjxHOHKTKH992bE6OJcAGAsMo317stAD52ow");
});

test("destinations: only plain absolute paths, account names, safe modes and ssh aliases are accepted", () => {
  assert.equal(parseSecretDropTarget(target()).path, "/tmp/x/ghcr-token");
  assert.equal(parseSecretDropTarget(target({ kind: "ssh_file", host: "contabo_sg_ts", path: "/etc/zen-quant/ghcr-token" })).host, "contabo_sg_ts");
  const refused = (value: unknown) => assert.throws(() => parseSecretDropTarget(value), /not allowed/u);
  for (const path of ["relative/x", "/tmp/../etc/x", "/tmp/a b", "/tmp/a;rm", "/tmp/$(id)", "/tmp/x\n", "/tmp/x/", "/tmp//x", "/tmp/`id`", "/tmp/x'y"]) refused(target({ path }));
  for (const owner of ["Root", "root;id", "", "1root", "a".repeat(40)]) refused(target({ owner }));
  for (const mode of ["0666", "0602", "777", "06000", "rw", "0 600"]) refused(target({ mode }));
  for (const host of ["-oProxyCommand=x", "a b", "", "x;y"]) refused(target({ kind: "ssh_file", host, path: "/etc/x" }));
  refused(target({ host: "mbp" }));
  refused({ ...target(), kind: "folder" });
  refused(null);
});

test("the ssh writer quotes every parameter, uses sudo -n and carries no value in argv", () => {
  const { command, args } = writerCommand(target({ kind: "ssh_file", host: "contabo_sg_ts", path: "/etc/zen-quant/ghcr-token" }), "wyatt", false);
  assert.equal(command, "ssh");
  assert.deepEqual(args.slice(0, 5), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--"]);
  assert.equal(args[5 - 0 + 0], "contabo_sg_ts");
  assert.match(args[6]!, /^sudo -n sh -c '.*' sh '\/etc\/zen-quant\/ghcr-token' 'root' 'root' '0600'$/su);
  const local = writerCommand(target(), "wyatt", false);
  assert.deepEqual([local.command, local.args.slice(0, 2)], ["sudo", ["-n", "sh"]]);
  assert.equal(writerCommand(target({ owner: "wyatt", group: "wyatt" }), "wyatt", false).command, "sh");
});

test("the real writer script creates the file 0600 for this account, replaces it atomically and reports whether it replaced", { skip: process.platform === "win32" }, async () => {
  await withDevice(async (root) => {
    const me = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
    if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(me)) return;
    const group = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
    const path = join(root, "new-dir", "token");
    const t = target({ path, owner: me, group });
    const drop = async (id: string, value: string) => {
      const { epk } = prepareSecretDrop({ dropId: id });
      const ciphertext = await browserEncrypt(epk, id, value);
      const payload = approval({ epk, ciphertext, target: t }, { id, grant: { kind: "secret_drop", resource: id, mode: "once" } }, secretDropBinding({ dropId: id, target: t, epk, ciphertext }));
      return applySecretDrop({ dropId: id, target: t, epk, ciphertext, approval: payload });
    };
    assert.equal((await drop("sdrop_first00000", "one")).replaced, false);
    assert.equal(await readFile(path, "utf8"), "one");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await drop("sdrop_second0000", "two")).replaced, true);
    assert.equal(await readFile(path, "utf8"), "two");
    await writeFile(join(root, "keep"), "x");
  });
});

test("a failed write reports the exit and a scrubbed stderr, never the value", async () => {
  await withDevice(async () => {
    const t = target();
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const ciphertext = await browserEncrypt(epk, DROP, SECRET);
    const run = async () => ({ code: 1, stdout: "", stderr: `sudo: a password is required ${SECRET}` });
    const message = await refusal(applySecretDrop({ dropId: DROP, target: t, epk, ciphertext, approval: approval({ epk, ciphertext, target: t }) }, { run }));
    assert.match(message, /exit 1/u);
    assert.equal(message.includes(SECRET), false);
  });
});

test("prepare refuses a bad id and caps the number of open drops", () => {
  forgetSecretDropKeys();
  assert.throws(() => prepareSecretDrop({ dropId: "x" }), /invalid/u);
  for (let i = 0; i < 32; i += 1) prepareSecretDrop({ dropId: `sdrop_cap${String(i).padStart(6, "0")}` });
  assert.throws(() => prepareSecretDrop({ dropId: "sdrop_overflow00" }), /Too many/u);
  forgetSecretDropKeys();
});

test("a field list is checked against the decrypted values and rendered as env, json or raw", () => {
  const base = { kind: "file", path: "/etc/app/env", owner: "root", group: "root", mode: "0600" };
  const fields = [{ name: "USER", label: "User", type: "text", required: true }, { name: "PORT", label: "Port", type: "number", required: false, max: 5 }];
  const env = parseSecretDropTarget({ ...base, fields });
  assert.equal(env.format, "env");
  assert.equal(renderSecretFields(env, Buffer.from(JSON.stringify({ USER: "a", PORT: "80" }))).toString(), "USER=a\nPORT=80\n");
  const json = parseSecretDropTarget({ ...base, fields, format: "json" });
  assert.deepEqual(JSON.parse(renderSecretFields(json, Buffer.from(JSON.stringify({ USER: "a", PORT: "" }))).toString()), { USER: "a", PORT: "" });
  const raw = parseSecretDropTarget({ ...base, fields: [fields[0]] });
  assert.equal(renderSecretFields(raw, Buffer.from("tok")).toString(), "tok");
  const plain = Buffer.from("legacy");
  assert.equal(renderSecretFields(parseSecretDropTarget(base), plain), plain);
  for (const bad of [{ USER: "" }, { USER: "a", PORT: "x" }, { USER: "a", PORT: "123456" }, { USER: "a\nB=1" }, { USER: "a", OTHER: "1" }, { USER: 1 }]) {
    assert.throws(() => renderSecretFields(env, Buffer.from(JSON.stringify(bad))), /not accepted|did not match/u);
  }
  assert.throws(() => renderSecretFields(env, Buffer.from("not json")), /did not match/u);
  assert.throws(() => parseSecretDropTarget({ ...base, fields: [fields[0], fields[0]] }), /not allowed/u);
  assert.throws(() => parseSecretDropTarget({ ...base, fields: [{ ...fields[0], type: "checkbox" }] }), /not allowed/u);
});

const VAULT_TARGET = { kind: "vault_unlock" } as const;

test("vault_unlock target: only kind is accepted, and its signed binding is a fixed value the relay pins too", () => {
  assert.deepEqual(parseAnyTarget({ kind: "vault_unlock" }), VAULT_TARGET);
  for (const extra of [{ path: "/etc/x" }, { owner: "root" }, { host: "h" }, { fields: [] }, { format: "raw" }, { mode: "0600" }]) assert.throws(() => parseAnyTarget({ kind: "vault_unlock", ...extra }), /not allowed/u);
  assert.throws(() => parseAnyTarget({ kind: "vault" }), /not allowed/u);
  const epk = b64(Buffer.alloc(32, 7));
  assert.equal(secretDropBinding({ dropId: DROP, target: VAULT_TARGET, epk, ciphertext: "AAAA" }), "ch7_81y5TWvy1wKZAGg9hY8orLoxju02gNiLRYIq2RI");
});

test("vault_unlock: the decrypted value goes to the vault once, not to a writer; the receipt has only the lock time and the buffer is zeroed", async () => {
  await withDevice(async () => {
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const ciphertext = await browserEncrypt(epk, DROP, SECRET);
    let writes = 0;
    const seen: Buffer[] = [];
    const unlockVault = async (master: Buffer) => { assert.equal(master.toString("utf8"), SECRET); seen.push(master); return { locksAt: "2026-11-23T20:00:00.000Z" }; };
    const receipt = await applySecretDrop({ dropId: DROP, target: VAULT_TARGET, epk, ciphertext, approval: approval({ epk, ciphertext, target: VAULT_TARGET }) }, { run: async () => { writes += 1; return { code: 0, stdout: "", stderr: "" }; }, unlockVault });
    assert.deepEqual(receipt, { status: "unlocked", locksAt: "2026-11-23T20:00:00.000Z" });
    assert.equal(writes, 0);
    assert.equal(seen[0]!.every((byte) => byte === 0), true);
  });
});

test("vault_unlock: a failure never carries the value, and a signature for another destination is still refused", async () => {
  await withDevice(async () => {
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const ciphertext = await browserEncrypt(epk, DROP, SECRET);
    const unlockVault = async (): Promise<{ locksAt: string }> => { throw new Error(`bw said ${SECRET} is wrong`); };
    const message = await refusal(applySecretDrop({ dropId: DROP, target: VAULT_TARGET, epk, ciphertext, approval: approval({ epk, ciphertext, target: VAULT_TARGET }) }, { unlockVault }));
    assert.equal(message.includes(SECRET), false);
    assert.match(message, /\[hidden\]/u);
    const again = prepareSecretDrop({ dropId: DROP });
    const ct2 = await browserEncrypt(again.epk, DROP, SECRET);
    let called = 0;
    assert.equal(await refusal(applySecretDrop({ dropId: DROP, target: VAULT_TARGET, epk: again.epk, ciphertext: ct2, approval: approval({ epk: again.epk, ciphertext: ct2, target: target() }) }, { unlockVault: async () => { called += 1; return { locksAt: "x" }; } })), "bind_mismatch");
    assert.equal(called, 0);
  });
});

const ITEM_TARGET: AnySecretDropTarget = { kind: "vault_item", origin: "https://example.com", name: "Example", format: "json", fields: [...VAULT_ITEM_FIELDS] };
const ITEM_SECRET = JSON.stringify({ username: "wyatt@example.com", password: "hunter2-ITEM-PASSWORD", totp: "JBSWY3DPEHPK3PXP" });

test("vault_item target: only the exact signed form parses, and its binding is the value the relay pins", () => {
  assert.deepEqual(parseAnyTarget(ITEM_TARGET), ITEM_TARGET);
  for (const bad of [{ ...ITEM_TARGET, fields: VAULT_ITEM_FIELDS.slice(0, 2) }, { ...ITEM_TARGET, origin: "http://example.com" }, { ...ITEM_TARGET, origin: "https://example.com/login" }, { ...ITEM_TARGET, format: "env" }, { ...ITEM_TARGET, extra: 1 }, { ...ITEM_TARGET, name: "" }, { ...ITEM_TARGET, name: "a\nb" }]) {
    assert.throws(() => parseAnyTarget(bad), /not allowed/u);
  }
  assert.equal(secretDropBinding({ dropId: DROP, target: ITEM_TARGET, epk: b64(Buffer.alloc(32, 7)), ciphertext: "AAAA" }), "5bq1q605vr5fdHspedKuhu1A_uwWVrcDon5IllNUCrQ");
});

test("vault_item: prepare refuses a locked vault only for this kind", () => {
  const locked = () => ({ status: "locked" });
  assert.throws(() => prepareSecretDrop({ dropId: DROP, kind: "vault_item" }, Date.now(), locked), /vault is locked/u);
  assert.ok(prepareSecretDrop({ dropId: DROP, kind: "vault_item" }, Date.now(), () => ({ status: "unlocked" })).epk);
  assert.ok(prepareSecretDrop({ dropId: DROP, kind: "file" }, Date.now(), locked).epk);
  assert.ok(prepareSecretDrop({ dropId: DROP }, Date.now(), locked).epk);
});

test("vault_item: the typed values go to saveLogin once, the receipt carries none of them, and a duplicate is reported", async () => {
  await withDevice(async () => {
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const ciphertext = await browserEncrypt(epk, DROP, ITEM_SECRET);
    let writes = 0;
    const saved: unknown[] = [];
    const receipt = await applySecretDrop({ dropId: DROP, target: ITEM_TARGET, epk, ciphertext, approval: approval({ epk, ciphertext, target: ITEM_TARGET }) }, {
      run: async () => { writes += 1; return { code: 0, stdout: "", stderr: "" }; },
      saveLogin: async (origin, login) => { saved.push({ origin, login }); return { status: "saved", hasTotp: true }; },
    });
    assert.deepEqual(saved, [{ origin: "https://example.com", login: { name: "Example", username: "wyatt@example.com", password: "hunter2-ITEM-PASSWORD", totp: "JBSWY3DPEHPK3PXP" } }]);
    assert.deepEqual(receipt, { status: "saved", site: "https://example.com", name: "Example", hasTotp: true });
    assert.equal(JSON.stringify(receipt).includes("hunter2"), false);
    assert.equal(writes, 0);

    const again = prepareSecretDrop({ dropId: DROP });
    const ct2 = await browserEncrypt(again.epk, DROP, JSON.stringify({ username: "u", password: "p", totp: "" }));
    const seen: unknown[] = [];
    const exists = await applySecretDrop({ dropId: DROP, target: ITEM_TARGET, epk: again.epk, ciphertext: ct2, approval: approval({ epk: again.epk, ciphertext: ct2, target: ITEM_TARGET }) }, { saveLogin: async (_o, login) => { seen.push(login); return { status: "exists" }; } });
    assert.deepEqual(exists, { status: "exists", site: "https://example.com" });
    assert.deepEqual(seen, [{ name: "Example", username: "u", password: "p" }]);
  });
});

test("vault_item: a failure never carries the values, and values outside the signed field list are refused", async () => {
  await withDevice(async () => {
    const { epk } = prepareSecretDrop({ dropId: DROP });
    const ciphertext = await browserEncrypt(epk, DROP, ITEM_SECRET);
    const message = await refusal(applySecretDrop({ dropId: DROP, target: ITEM_TARGET, epk, ciphertext, approval: approval({ epk, ciphertext, target: ITEM_TARGET }) }, { saveLogin: async () => { throw new Error("bw said hunter2-ITEM-PASSWORD and wyatt@example.com"); } }));
    assert.equal(message.includes("hunter2"), false);
    const again = prepareSecretDrop({ dropId: DROP });
    const extra = await browserEncrypt(again.epk, DROP, JSON.stringify({ username: "u", password: "p", totp: "", notes: "x" }));
    let called = 0;
    assert.match(await refusal(applySecretDrop({ dropId: DROP, target: ITEM_TARGET, epk: again.epk, ciphertext: extra, approval: approval({ epk: again.epk, ciphertext: extra, target: ITEM_TARGET }) }, { saveLogin: async () => { called += 1; return { status: "saved", hasTotp: false }; } })), /did not match the requested fields/u);
    assert.equal(called, 0);
  });
});
