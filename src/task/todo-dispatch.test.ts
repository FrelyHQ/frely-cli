import test from "node:test";
import { HOSTED_INSTANCE, trustAnchor } from "../instance.js";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setObserveIdentity } from "../trust/observe.js";
import { APPROVAL_DOMAIN, pinTrustChain, TRUST_DOMAIN, trustDirectory, trustRecordHash, type ApprovalPayload, type TrustRecord } from "../trust/record.js";
import { challengeFor, type Signer, type WebAuthnSignature } from "../trust/webauthn.js";
import { TODO_SCOPE_GRANT } from "../trust/todo-scope.js";
import { executeTaskRun } from "./worker.js";
import { runTodoDispatch, TODO_SCOPE_META_KEY } from "./todo-dispatch.js";
import { listDefinitions } from "./definition.js";
import { listTaskRuns } from "./run-store.js";

const ORIGIN = "https://approve.frely.cloud";
const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest();
const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const signer: Signer = { id: "pk_1", kind: "webauthn", credId: b64("cred-1"), alg: -7, spki: b64(pair.publicKey.export({ type: "spki", format: "der" })) };
const record: TrustRecord = { typ: TRUST_DOMAIN, user: "usr_1", seq: 1, prev: null, rpId: "frely.cloud", approvalOrigins: [ORIGIN], signers: [signer] };
const assertion = (payload: unknown): WebAuthnSignature => {
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeFor(APPROVAL_DOMAIN, payload), origin: ORIGIN }));
  const authData = Buffer.concat([sha("frely.cloud"), Buffer.from([0x05]), Buffer.alloc(4)]);
  return { kind: "webauthn", credId: signer.credId, authData: b64(authData), clientData: b64(clientData), signature: b64(sign("sha256", Buffer.concat([authData, sha(clientData)]), pair.privateKey)) };
};
const DEVICE = "drd_" + "a".repeat(32);

async function withDevice(run: (work: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "frely-dispatch-"));
  const saved = { xdg: process.env.XDG_CONFIG_HOME, sandbox: process.env.FRELY_SANDBOX };
  process.env.XDG_CONFIG_HOME = join(root, "config"); process.env.FRELY_SANDBOX = "off";
  try {
    const work = join(root, "work"); await mkdir(work);
    setObserveIdentity({ device: DEVICE, deviceKey: "thumb", relayUrl: "https://r.test", userId: "usr_1" });
    await run(work);
  } finally {
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
    if (saved.sandbox === undefined) delete process.env.FRELY_SANDBOX; else process.env.FRELY_SANDBOX = saved.sandbox;
    await rm(root, { recursive: true, force: true });
  }
}

const trustSig = (r: TrustRecord): WebAuthnSignature => {
  const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challengeFor(TRUST_DOMAIN, r), origin: ORIGIN }));
  const authData = Buffer.concat([sha("frely.cloud"), Buffer.from([0x05]), Buffer.alloc(4)]);
  return { kind: "webauthn", credId: signer.credId, authData: b64(authData), clientData: b64(clientData), signature: b64(sign("sha256", Buffer.concat([authData, sha(clientData)]), pair.privateKey)) };
};

function approval(workspace: string, maxSteps = 2, executors?: string[], scriptHashes?: string[], more: Partial<NonNullable<ApprovalPayload["scope"]>> = {}) {
  const now = Date.now();
  const payload: ApprovalPayload = {
    typ: APPROVAL_DOMAIN, id: "tdsc_1", user: "usr_1", trust: trustRecordHash(record), trustSeq: 1, device: DEVICE, deviceKey: "thumb", authz: null,
    grant: { kind: TODO_SCOPE_GRANT, resource: "td_1", mode: "authorization" }, scope: { todo: "td_1", deviceName: "mbp", workspace, sites: ["github.com"], ...(executors ? { executors } : {}), ...(scriptHashes ? { scriptHashes } : {}), ...more, maxSteps },
    iat: new Date(now).toISOString(), nbf: new Date(now).toISOString(), exp: new Date(now + 3600_000).toISOString(),
  };
  return { payload, sig: assertion(payload) };
}

test("start verifies the signed scope, runs one step as a remote pi task, and a retried start returns the same run", async () => {
  await withDevice(async (work) => {
    // Pin with a proper first-version signature.
    await pinTrustChain([{ record, sig: trustSig(record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    const spawned: string[] = [];
    const deps = { spawnWorker: (runId: string) => { spawned.push(runId); }, defaultAgent: async () => "pi" as const };
    const args = { action: "start", runKey: "run_abcdef01", todoId: "td_1", instruction: "Say hello", cwd: work, sites: ["github.com"] };
    const meta = { [TODO_SCOPE_META_KEY]: approval(work) };
    const first = await runTodoDispatch(args, meta, deps);
    assert.equal(first.status, "running");
    assert.equal(spawned.length, 1);
    const run = (await listTaskRuns())[0]!;
    assert.deepEqual([run.trigger, run.snapshot.runner, run.snapshot.command, run.snapshot.cwd, [...run.snapshot.sites]], ["remote", "pi", "Say hello", work, ["github.com"]]);
    assert.deepEqual(await listDefinitions(), [], "the one-off definition is removed once the run has its snapshot");
    const again = await runTodoDispatch(args, meta, deps);
    assert.equal(spawned.length, 1);
    assert.equal(again.status, "running");
    assert.equal((await runTodoDispatch({ action: "status", runKey: "run_abcdef01" }, undefined, deps)).status, "running");
    assert.equal((await runTodoDispatch({ action: "cancel", runKey: "run_abcdef01" }, undefined, deps)).status, "cancelled");
    assert.equal((await runTodoDispatch({ action: "status", runKey: "run_unknown1" }, undefined, deps)).status, "unknown");
  });
});

test("start without a valid passkey approval or outside the folder starts nothing", async () => {
  await withDevice(async (work) => {
    await pinTrustChain([{ record, sig: trustSig(record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    const spawned: string[] = [];
    const deps = { spawnWorker: (runId: string) => { spawned.push(runId); } };
    const base = { action: "start", todoId: "td_1", instruction: "x", cwd: work, sites: [] };
    await assert.rejects(runTodoDispatch({ ...base, runKey: "run_noapprv1" }, {}, deps), /approval_missing/u);
    await assert.rejects(runTodoDispatch({ ...base, runKey: "run_outside1", cwd: tmpdir() }, { [TODO_SCOPE_META_KEY]: approval(work) }, deps), /outside_workspace/u);
    const forged = approval(work, 99); forged.payload.scope!.workspace = tmpdir();
    await assert.rejects(runTodoDispatch({ ...base, runKey: "run_forged01", cwd: tmpdir() }, { [TODO_SCOPE_META_KEY]: forged }, deps), /challenge_mismatch/u);
    assert.equal(spawned.length, 0);
    assert.deepEqual(await listTaskRuns(), []);
  });
});

test("a codex step runs as a codex task only under a scope signed for codex; an unsigned scope refuses it", async () => {
  await withDevice(async (work) => {
    await pinTrustChain([{ record, sig: trustSig(record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    const spawned: string[] = [];
    const deps = { spawnWorker: (runId: string) => { spawned.push(runId); } };
    const args = { action: "start", todoId: "td_1", instruction: "Fix the typo", cwd: work, sites: [], executor: "codex" };
    await assert.rejects(runTodoDispatch({ ...args, runKey: "run_codex001" }, { [TODO_SCOPE_META_KEY]: approval(work) }, deps), /executor_not_allowed/u);
    await assert.rejects(runTodoDispatch({ ...args, runKey: "run_codex002", executor: "claude" }, { [TODO_SCOPE_META_KEY]: approval(work, 2, ["pi", "codex"]) }, deps), /executor must be/u);
    assert.equal(spawned.length, 0);
    const started = await runTodoDispatch({ ...args, runKey: "run_codex003" }, { [TODO_SCOPE_META_KEY]: approval(work, 2, ["codex", "pi"]) }, deps);
    assert.equal(started.status, "running");
    assert.equal((await listTaskRuns())[0]!.snapshot.runner, "codex");
  });
});

const hashOf = (script: string) => createHash("sha256").update(script, "utf8").digest("hex");

test("a condition script runs in the signed folder: exit 0 is met, any other exit is not, and only met and the code go back", async () => {
  await withDevice(async (work) => {
    await pinTrustChain([{ record, sig: trustSig(record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    const deps = { spawnWorker: (runId: string) => { void executeTaskRun(runId); } };
    const check = (script: string, key: string, hashes = [hashOf(script)]) => runTodoDispatch({ action: "check", runKey: key, todoId: "td_1", script, cwd: work }, { [TODO_SCOPE_META_KEY]: approval(work, 2, undefined, hashes) }, deps);
    assert.deepEqual(await check("echo secret-output; exit 0", "chk_met00001"), { status: "checked", met: true, exitCode: 0 });
    assert.deepEqual(await check("exit 3", "chk_not00001"), { status: "checked", met: false, exitCode: 3 });
    assert.deepEqual(await listDefinitions(), [], "the one-off definition is removed");
  });
});

test("a condition script that was edited after the owner signed is refused and never runs", async () => {
  await withDevice(async (work) => {
    await pinTrustChain([{ record, sig: trustSig(record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    const spawned: string[] = [];
    const deps = { spawnWorker: (runId: string) => { spawned.push(runId); } };
    const args = { action: "check", runKey: "chk_edited001", todoId: "td_1", script: "touch pwned", cwd: work };
    await assert.rejects(runTodoDispatch(args, { [TODO_SCOPE_META_KEY]: approval(work, 2, undefined, [hashOf("true")]) }, deps), /script_mismatch/u);
    await assert.rejects(runTodoDispatch({ ...args, runKey: "chk_nohash001" }, { [TODO_SCOPE_META_KEY]: approval(work) }, deps), /script_mismatch/u);
    await assert.rejects(runTodoDispatch({ ...args, runKey: "chk_outside01", cwd: tmpdir() }, { [TODO_SCOPE_META_KEY]: approval(work, 2, undefined, [hashOf("touch pwned")]) }, deps), /outside_workspace/u);
    assert.equal(spawned.length, 0);
  });
});

test("a condition script that does not end in time counts as not met", async () => {
  await withDevice(async (work) => {
    await pinTrustChain([{ record, sig: trustSig(record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    const script = "sleep 5";
    // The worker never starts, so the run stays queued past the (shortened) wait and is cancelled.
    const result = await runTodoDispatch({ action: "check", runKey: "chk_slow00001", todoId: "td_1", script, cwd: work }, { [TODO_SCOPE_META_KEY]: approval(work, 2, undefined, [hashOf(script)]) }, { spawnWorker: () => undefined, checkWaitMs: 200 });
    assert.deepEqual(result, { status: "checked", met: false, exitCode: null });
  });
});

test("a script step runs its signed command as a script task with the signed credential groups, and `hash` reports file hashes inside a workspace only", async () => {
  await withDevice(async (work) => {
    await pinTrustChain([{ record, sig: trustSig(record) }], "usr_1", trustDirectory({ relayUrl: "https://r.test", userId: "usr_1" }), trustAnchor(HOSTED_INSTANCE));
    await writeFile(join(work, "update.sh"), "echo hi\n");
    const hashed = await runTodoDispatch({ action: "hash", runKey: "run_hash0001", cwd: work, files: ["update.sh", "missing.sh", "../x"] }, undefined, undefined, [work]);
    const files = hashed.files as { path: string; sha256: string | null }[];
    assert.equal(files[0]!.sha256, createHash("sha256").update("echo hi\n").digest("hex"));
    assert.deepEqual([files[1]!.sha256, files[2]!.sha256], [null, null]);
    await assert.rejects(() => runTodoDispatch({ action: "hash", runKey: "run_hash0001", cwd: tmpdir(), files: ["a"] }, undefined, undefined, [work]), /outside_workspace|workspace/u);
    const command = "./update.sh";
    const signed = [{ command: createHash("sha256").update(command).digest("hex"), files: [{ path: "update.sh", sha256: files[0]!.sha256! }] }];
    const spawned: string[] = [];
    const deps = { spawnWorker: (runId: string) => { spawned.push(runId); } };
    const meta = { [TODO_SCOPE_META_KEY]: approval(work, 5, ["script"], undefined, { stepScripts: signed, credentials: ["gcloud"] }) };
    const args = { action: "start", runKey: "run_script01", todoId: "td_1", executor: "script", instruction: command, cwd: work, sites: ["github.com"], credentials: ["gcloud"] };
    await runTodoDispatch(args, meta, deps);
    const run = (await listTaskRuns())[0]!;
    assert.deepEqual([run.snapshot.runner, run.snapshot.command, [...(run.snapshot.credentials ?? [])]], ["script", command, ["gcloud"]]);
    await writeFile(join(work, "update.sh"), "echo changed\n");
    await assert.rejects(() => runTodoDispatch({ ...args, runKey: "run_script02" }, meta, deps), /script_changed|changed/u);
  });
});
