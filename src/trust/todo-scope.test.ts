import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVAL_DOMAIN, TRUST_DOMAIN, trustRecordHash, type ApprovalPayload, type TrustRecord } from "./record.js";
import { authorizeTodoCheck, authorizeTodoStep, TODO_SCOPE_GRANT } from "./todo-scope.js";
import { challengeFor, TrustError, type Signer, type WebAuthnSignature } from "./webauthn.js";

const ORIGIN = "https://approve.frely.cloud";
const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest();
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signer: Signer = { id: "pk_1", kind: "webauthn", credId: b64("cred-1"), alg: -7, spki: b64(pair.publicKey.export({ type: "spki", format: "der" })) };
const record: TrustRecord = { typ: TRUST_DOMAIN, user: "usr_1", seq: 1, prev: null, rpId: "frely.cloud", approvalOrigins: [ORIGIN], signers: [signer] };
const DEVICE = "drd_" + "a".repeat(32);

function assertion(payload: unknown, origin = ORIGIN): WebAuthnSignature {
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeFor(APPROVAL_DOMAIN, payload), origin }));
  const authData = Buffer.concat([sha("frely.cloud"), Buffer.from([0x05]), Buffer.alloc(4)]);
  return { kind: "webauthn", credId: signer.credId, authData: b64(authData), clientData: b64(clientData), signature: b64(sign("sha256", Buffer.concat([authData, sha(clientData)]), pair.privateKey)) };
}

function approval(workspace: string, over: Partial<ApprovalPayload> = {}, scopeOver: Partial<NonNullable<ApprovalPayload["scope"]>> = {}) {
  const now = Date.now();
  const payload: ApprovalPayload = {
    typ: APPROVAL_DOMAIN, id: "tdsc_1", user: "usr_1", trust: trustRecordHash(record), trustSeq: 1, device: DEVICE, deviceKey: "thumb", authz: null,
    grant: { kind: TODO_SCOPE_GRANT, resource: "td_1", mode: "authorization" },
    scope: { todo: "td_1", deviceName: "mbp", workspace, sites: ["github.com"], maxSteps: 2, ...scopeOver },
    iat: new Date(now).toISOString(), nbf: new Date(now).toISOString(), exp: new Date(now + 3600_000).toISOString(), ...over,
  };
  return { payload, sig: assertion(payload) };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "frely-todo-scope-"));
  const work = join(root, "work"), sub = join(work, "sub"), outside = join(root, "other");
  await mkdir(sub, { recursive: true }); await mkdir(outside);
  await symlink(outside, join(work, "escape"));
  const ctx = { record, device: DEVICE, deviceKey: "thumb", counterDirectory: join(root, "state") };
  return { root, work, sub, outside, ctx };
}
const code = async (work: Promise<unknown>) => { try { await work; return "ok"; } catch (error) { return error instanceof TrustError ? error.code : `error:${(error as Error).message}`; } };

test("a step inside the signed folder and sites is accepted and counted once per step key", async () => {
  const { root, work, sub, ctx } = await setup();
  try {
    const a = approval(work);
    assert.equal((await authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: "s1", cwd: sub, sites: ["github.com"] })).stepsUsed, 1);
    const again = await authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: "s1", cwd: sub, sites: [] });
    assert.deepEqual([again.stepsUsed, again.duplicate], [1, true]);
    assert.equal((await authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: "s2", cwd: work, sites: [] })).stepsUsed, 2);
    assert.equal(await code(authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: "s3", cwd: work, sites: [] })), "step_limit_reached");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the step limit is the device's own count: it survives a new process and one approval cannot serve another todo", async () => {
  const { root, work, ctx } = await setup();
  try {
    const a = approval(work, {}, { maxSteps: 1 });
    await authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: "s1", cwd: work, sites: [] });
    assert.equal(await code(authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: "s2", cwd: work, sites: [] })), "step_limit_reached");
    assert.equal(await code(authorizeTodoStep(a, ctx, { todoId: "td_2", stepKey: "s1", cwd: work, sites: [] })), "todo_mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("folder and site rules: outside, dot-dot, symlink escape, other sites and a sibling with the same prefix are refused", async () => {
  const { root, work, outside, ctx } = await setup();
  try {
    const a = approval(work, {}, { maxSteps: 50 });
    const run = (cwd: string, sites: string[] = []) => code(authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: `k${Math.random()}`, cwd, sites }));
    assert.equal(await run(outside), "outside_workspace");
    assert.equal(await run(join(work, "..", "other")), "outside_workspace");
    assert.equal(await run(join(work, "escape")), "outside_workspace");
    assert.equal(await run(`${work}-evil`), "outside_workspace");
    assert.equal(await run(join(work, "missing")), "outside_workspace");
    assert.equal(await run(work, ["evil.example"]), "site_not_allowed");
    assert.equal(await run(work, ["github.com"]), "ok");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("only a passkey todo_scope approval counts: other grants, bad signatures, expiry, TTL over 30 days, other devices and rewritten scopes are refused", async () => {
  const { root, work, ctx } = await setup();
  try {
    const req = { todoId: "td_1", stepKey: "s1", cwd: work, sites: [] };
    const run = (a: ReturnType<typeof approval>, c = ctx) => code(authorizeTodoStep(a, c, { ...req, stepKey: `k${Math.random()}` }));
    assert.equal(await run(approval(work, { grant: { kind: "unsandboxed", mode: "authorization", resource: "td_1" } })), "wrong_grant");
    assert.equal(await run(approval(work, { grant: { kind: TODO_SCOPE_GRANT, resource: "td_1", mode: "once" }, exp: new Date(Date.now() + 600_000).toISOString() })), "wrong_grant");
    const forged = approval(work); forged.payload.scope!.workspace = "/";
    assert.equal(await run(forged), "challenge_mismatch");
    const wrongOrigin = approval(work); wrongOrigin.sig = assertion(wrongOrigin.payload, "https://frely.cloud");
    assert.equal(await run(wrongOrigin), "origin_not_allowed");
    const old = Date.now() - 3 * 3600_000;
    assert.equal(await run(approval(work, { iat: new Date(old).toISOString(), nbf: new Date(old).toISOString(), exp: new Date(old + 3600_000).toISOString() })), "expired");
    assert.equal(await run(approval(work, { exp: new Date(Date.now() + 31 * 24 * 3600_000).toISOString() })), "ttl_too_long");
    assert.equal(await run(approval(work), { ...ctx, device: "drd_" + "b".repeat(32) }), "device_mismatch");
    assert.equal(await run(approval(work, { ctl: { kind: "key", id: "k" } })), "approval_invalid");
    assert.equal(await run(approval(work, {}, { maxSteps: 1000 })), "scope_invalid");
    assert.equal(await run(approval(work, {}, { sites: ["Bad Host"] })), "scope_invalid");
    assert.equal(await run(approval(work, {}, { workspace: "relative" })), "scope_invalid");
    assert.equal(await run(approval(work, { trust: "stale" })), "trust_mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("codex steps need a scope the owner signed for codex; a scope without executors allows pi only", async () => {
  const { root, work, ctx } = await setup();
  try {
    const run = (a: ReturnType<typeof approval>, executor?: string) => code(authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: `k${Math.random()}`, cwd: work, sites: [], ...(executor === undefined ? {} : { executor }) }));
    const plain = approval(work, {}, { maxSteps: 50 });
    assert.equal(await run(plain), "ok");
    assert.equal(await run(plain, "pi"), "ok");
    assert.equal(await run(plain, "codex"), "executor_not_allowed");
    const signed = approval(work, {}, { maxSteps: 50, executors: ["codex", "pi"] });
    assert.equal(await run(signed, "codex"), "ok");
    assert.equal(await run(approval(work, {}, { maxSteps: 50, executors: ["claude"] }), "pi"), "scope_invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the signed lifetime may be up to 30 days and no more", async () => {
  const { root, work, ctx } = await setup();
  try {
    const day = 24 * 3600_000, now = Date.now();
    const span = (ms: number) => ({ iat: new Date(now).toISOString(), nbf: new Date(now).toISOString(), exp: new Date(now + ms).toISOString() });
    const run = (ms: number, key: string) => code(authorizeTodoStep(approval(work, span(ms), { maxSteps: 5 }), ctx, { todoId: "td_1", stepKey: key, cwd: work, sites: [] }));
    assert.equal(await run(30 * day, "k1"), "ok");
    assert.equal(await run(30 * day + 60_000, "k2"), "ttl_too_long");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a script check needs its sha256 inside the signed scope and is not counted as a step", async () => {
  const { root, work, sub, outside, ctx } = await setup();
  try {
    const hash = "a".repeat(64);
    const a = approval(work, {}, { maxSteps: 1, scriptHashes: [hash] });
    const check = (scriptHash: string, cwd = sub) => code(authorizeTodoCheck(a, ctx, { todoId: "td_1", cwd, scriptHash }));
    assert.equal(await check(hash), "ok");
    assert.equal(await check(hash), "ok");
    assert.equal(await check("b".repeat(64)), "script_mismatch");
    assert.equal(await check(hash, outside), "outside_workspace");
    assert.equal((await authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: "s1", cwd: work, sites: [] })).stepsUsed, 1);
    assert.equal(await code(authorizeTodoCheck(approval(work), ctx, { todoId: "td_1", cwd: work, scriptHash: hash })), "script_mismatch");
    assert.equal(await code(authorizeTodoCheck(a, ctx, { todoId: "td_2", cwd: work, scriptHash: hash })), "todo_mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a script step runs only the signed command, only while its files keep the signed content, and only with signed credential groups", async () => {
  const { root, work, sub, ctx } = await setup();
  try {
    await writeFile(join(sub, "update.sh"), "echo hi\n");
    const fileHash = createHash("sha256").update("echo hi\n").digest("hex");
    const command = "./update.sh";
    const signed = { command: createHash("sha256").update(command).digest("hex"), files: [{ path: "update.sh", sha256: fileHash }] };
    const a = approval(work, {}, { executors: ["script"], stepScripts: [signed], credentials: ["gcloud"], maxSteps: 10 });
    const step = (key: string, over: Partial<Parameters<typeof authorizeTodoStep>[2]> = {}) => code(authorizeTodoStep(a, ctx, { todoId: "td_1", stepKey: key, cwd: sub, sites: [], executor: "script", script: { command }, credentials: ["gcloud"], ...over }));
    assert.equal(await step("s1"), "ok");
    assert.equal(await step("s2", { script: { command: "./other.sh" } }), "script_mismatch");
    assert.equal(await step("s3", { credentials: ["aws"] }), "credentials_not_allowed");
    assert.equal(await step("s4", { credentials: [] }), "ok");
    // A scope without `script` among its executors does not allow one, and agent steps never get credential groups.
    assert.equal(await code(authorizeTodoStep(approval(work, {}, { stepScripts: [signed] }), ctx, { todoId: "td_1", stepKey: "s5", cwd: sub, sites: [], executor: "script", script: { command } })), "executor_not_allowed");
    assert.equal(await code(authorizeTodoStep(approval(work, {}, { executors: ["pi"] }), ctx, { todoId: "td_1", stepKey: "s6", cwd: sub, sites: [], executor: "pi", credentials: ["gcloud"] })), "credentials_not_allowed");
    // One changed byte in a referenced file: refused until the owner signs again.
    await writeFile(join(sub, "update.sh"), "echo hi!\n");
    assert.equal(await step("s7"), "script_changed");
    await rm(join(sub, "update.sh"));
    assert.equal(await step("s8"), "script_changed");
    // A scope that names a credential group this CLI does not know is invalid.
    assert.equal(await code(authorizeTodoStep(approval(work, {}, { executors: ["script"], stepScripts: [signed], credentials: ["nope"] }), ctx, { todoId: "td_1", stepKey: "s9", cwd: sub, sites: [], executor: "script", script: { command } })), "scope_invalid");
  } finally { await rm(root, { recursive: true, force: true }); }
});
