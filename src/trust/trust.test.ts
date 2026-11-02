import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcs } from "./jcs.js";
import { APPROVAL_DOMAIN, pinTrustRecord, readTrust, TRUST_DOMAIN, trustRecordHash, verifyApproval, verifyTrustRecord, type ApprovalPayload, type SignedTrustRecord, type TrustRecord } from "./record.js";
import { challengeFor, TrustError, verifyAssertion, type CoseAlg, type Signer, type WebAuthnSignature } from "./webauthn.js";
import { observeApprovals, observed, setObserveIdentity } from "./observe.js";

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest();
const ORIGIN = "https://approve.frely.cloud";

interface Passkey { signer: Signer; privateKey: KeyObject }
function passkey(alg: CoseAlg, label = alg.toString()): Passkey {
  const pair = alg === -7 ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : alg === -8 ? generateKeyPairSync("ed25519") : generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credId = b64(`cred-${label}-${Math.random()}`);
  return { privateKey: pair.privateKey, signer: { id: `pk_${credId.slice(0, 8)}`, kind: "webauthn", credId, alg, spki: b64(pair.publicKey.export({ type: "spki", format: "der" })) } };
}
/** What a browser authenticator would return for `navigator.credentials.get` with challenge = SHA256(domain || JCS(payload)). */
function assert_(key: Passkey, domain: string, payload: unknown, o: { origin?: string; flags?: number; rpId?: string; crossOrigin?: boolean; type?: string } = {}): WebAuthnSignature {
  const clientData = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.get", challenge: challengeFor(domain, payload), origin: o.origin ?? ORIGIN, ...(o.crossOrigin !== undefined ? { crossOrigin: o.crossOrigin } : {}) }));
  const authData = Buffer.concat([sha(o.rpId ?? "frely.cloud"), Buffer.from([o.flags ?? 0x05]), Buffer.alloc(4)]);
  const message = Buffer.concat([authData, sha(clientData)]);
  const signature = key.signer.alg === -8 ? sign(null, message, key.privateKey) : sign("sha256", message, key.privateKey);
  return { kind: "webauthn", credId: key.signer.credId, authData: b64(authData), clientData: b64(clientData), signature: b64(signature) };
}
const rules = (signers: Signer[]) => ({ rpId: "frely.cloud", origins: [ORIGIN], domain: "t", signers });

test("JCS sorts keys, drops undefined, rejects floats (RFC 8785 fixed vectors)", () => {
  assert.equal(jcs({ b: 1, a: [true, null, "xé"], c: { z: 1, y: undefined } }), '{"a":[true,null,"xé"],"b":1,"c":{"z":1}}');
  assert.equal(jcs({ "é": 1, "e": 2, "😀": 3 }), '{"e":2,"é":1,"😀":3}');
  assert.throws(() => jcs({ n: 1.5 }));
});

for (const alg of [-7, -8, -257] as const) {
  test(`a passkey assertion over the payload verifies offline (alg ${alg})`, () => {
    const key = passkey(alg), payload = { a: 1, nonce: "n" };
    assert.equal(verifyAssertion(payload, assert_(key, "t", payload), rules([key.signer])).credId, key.signer.credId);
  });
}

test("assertions are refused for the wrong origin, framing, missing UV/UP, wrong rpId, wrong type, tampering and unknown signers", () => {
  const key = passkey(-7), payload = { a: 1 };
  const code = (signature: WebAuthnSignature, p: unknown = payload, signers = [key.signer]) => { try { verifyAssertion(p, signature, rules(signers)); return "ok"; } catch (error) { return (error as TrustError).code; } };
  assert.equal(code(assert_(key, "t", payload)), "ok");
  assert.equal(code(assert_(key, "t", payload, { origin: "https://frely.cloud" })), "origin_not_allowed");
  assert.equal(code(assert_(key, "t", payload, { crossOrigin: true })), "cross_origin");
  assert.equal(code(assert_(key, "t", payload, { flags: 0x01 })), "user_verification_missing");
  assert.equal(code(assert_(key, "t", payload, { flags: 0x04 })), "user_presence_missing");
  assert.equal(code(assert_(key, "t", payload, { rpId: "evil.example" })), "rp_id_mismatch");
  assert.equal(code(assert_(key, "t", payload, { type: "webauthn.create" })), "client_data_type");
  assert.equal(code(assert_(key, "t", payload), { a: 2 }), "challenge_mismatch");
  assert.equal(code(assert_(key, "other-domain", payload)), "challenge_mismatch");
  assert.equal(code(assert_(key, "t", payload), payload, [passkey(-7).signer]), "signer_unknown");
  const forged = assert_(passkey(-7), "t", payload);
  assert.equal(code({ ...forged, credId: key.signer.credId }), "signature_invalid");
});

function record(seq: number, prev: TrustRecord | null, signers: Signer[], user = "usr_1"): TrustRecord {
  return { typ: TRUST_DOMAIN, user, seq, prev: prev ? trustRecordHash(prev) : null, rpId: "frely.cloud", approvalOrigins: [ORIGIN], signers };
}
const sealed = (r: TrustRecord, key: Passkey): SignedTrustRecord => ({ record: r, sig: assert_(key, TRUST_DOMAIN, r) });

test("trust record chain: genesis self-signs, later versions are signed by the previous signers, rollback and fork are refused", () => {
  const a = passkey(-7), b = passkey(-8);
  const v1 = record(1, null, [a.signer]);
  const pin1 = verifyTrustRecord(sealed(v1, a), undefined);
  const v2 = record(2, v1, [a.signer, b.signer]);
  assert.throws(() => verifyTrustRecord(sealed(v2, b), v1, pin1), /signer_unknown/u);
  const pin2 = verifyTrustRecord(sealed(v2, a), v1, pin1);
  assert.equal(pin2.seq, 2);
  const v3 = record(3, v2, [b.signer]);
  assert.equal(verifyTrustRecord(sealed(v3, b), v2, pin2).seq, 3);
  assert.throws(() => verifyTrustRecord(sealed(v1, a), undefined, pin2), /rollback/u);
  const fork = record(2, v1, [b.signer]);
  assert.throws(() => verifyTrustRecord(sealed(fork, a), v1, pin2), /fork/u);
  assert.throws(() => verifyTrustRecord(sealed(record(3, v1, [a.signer]), a), v1, pin2), /chain_broken/u);
  assert.throws(() => verifyTrustRecord(sealed(record(1, null, [a.signer], "usr_2"), a), undefined, pin1), /user_mismatch/u);
  assert.throws(() => verifyTrustRecord(sealed(record(1, null, [a.signer]), b), undefined), /signer_unknown/u);
});

test("pinTrustRecord stores the pin on first bind and keeps it across a rollback attempt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-trust-"));
  try {
    const a = passkey(-7);
    const v1 = record(1, null, [a.signer]), v2 = record(2, v1, [a.signer]);
    await pinTrustRecord(sealed(v1, a), dir);
    await pinTrustRecord(sealed(v2, a), dir);
    await assert.rejects(pinTrustRecord(sealed(v1, a), dir), /rollback/u);
    assert.equal((await readTrust(dir))?.pin.seq, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function approval(trust: TrustRecord, key: Passkey, over: Partial<ApprovalPayload> = {}, o: Parameters<typeof assert_>[3] = {}) {
  const now = Date.now();
  const payload: ApprovalPayload = { typ: APPROVAL_DOMAIN, id: "apv_0123456789abcdef", user: trust.user, trust: trustRecordHash(trust), trustSeq: trust.seq, device: "drd_" + "a".repeat(32), deviceKey: "thumb", authz: null,
    grant: { kind: "unsandboxed", mode: "once" }, iat: new Date(now).toISOString(), nbf: new Date(now).toISOString(), exp: new Date(now + 10 * 60_000).toISOString(), ...over };
  return { payload, sig: assert_(key, APPROVAL_DOMAIN, payload, o) };
}

test("verifyApproval binds to trust record, device, validity window and once-TTL", () => {
  const key = passkey(-7), rec = record(1, null, [key.signer]);
  const ctx = { record: rec, device: "drd_" + "a".repeat(32), deviceKey: "thumb" };
  const code = (a: ReturnType<typeof approval>, c = ctx) => { try { verifyApproval(a, c); return "ok"; } catch (error) { return (error as TrustError).code; } };
  assert.equal(code(approval(rec, key)), "ok");
  assert.equal(code(approval(rec, key), { ...ctx, device: "drd_" + "b".repeat(32) }), "device_mismatch");
  assert.equal(code(approval(rec, key), { ...ctx, deviceKey: "other" }), "device_mismatch");
  assert.equal(code(approval(rec, key, { trust: "x" })), "trust_mismatch");
  assert.equal(code(approval(rec, key), { ...ctx, now: Date.now() + 3600_000 } as typeof ctx), "expired");
  assert.equal(code(approval(rec, key, { exp: new Date(Date.now() + 3600_000).toISOString() })), "ttl_too_long");
  assert.equal(code(approval(rec, key, {}, { origin: "https://frely.cloud" })), "origin_not_allowed");
});

test("observation mode counts valid and invalid approvals and never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frely-observe-"));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const key = passkey(-7), rec = record(1, null, [key.signer]);
    const device = "drd_" + "a".repeat(32);
    setObserveIdentity({ device, deviceKey: "thumb" });
    const call = (list: unknown) => ({ params: { _meta: { "frely/approvals": list } } });
    assert.deepEqual(await observeApprovals(call([approval(rec, key)])), { seen: 1, valid: 0, failures: ["no_trust_record"] });
    await pinTrustRecord(sealed(rec, key));
    const before = { ...observed };
    const lines: string[] = [];
    const result = await observeApprovals(call([approval(rec, key), approval(rec, key, {}, { flags: 0x01 }), "junk"]), (line) => lines.push(line));
    assert.deepEqual(result, { seen: 3, valid: 1, failures: ["user_verification_missing", "approval_invalid"] });
    assert.equal(observed.valid - before.valid, 1);
    assert.match(lines[0]!, /trust.approval_unverified/u);
    assert.deepEqual(await observeApprovals({ params: {} }), { seen: 0, valid: 0, failures: [] });
  } finally { if (saved === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved; await rm(dir, { recursive: true, force: true }); }
});
