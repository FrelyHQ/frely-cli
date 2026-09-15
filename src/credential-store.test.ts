import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, link, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialStore, credentialStoreBackend, type CredentialStore } from "./credential-store.js";
import { createEncryptedCredentialStore } from "./credential-file.js";
import { createNativeCredentialStore } from "./credential-native.js";
import { createSystemCredentialStore } from "./credential-system.js";
import { runCredentialCommand, type CredentialCommand } from "./credential-command.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "frely-credentials-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "vault");
  const key = randomBytes(32).toString("hex");
  return { directory, root, key, store: createEncryptedCredentialStore(root, key) };
}
function entryPath(root: string, service: string, account: string) {
  return join(root, `${createHash("sha256").update(JSON.stringify(["frely.credentials.v1", service, account])).digest("hex")}.json`);
}
function memory() {
  const values = new Map<string, string>();
  const key = (service: string, account: string) => JSON.stringify([service, account]);
  const store: CredentialStore = {
    async getPassword(service, account) { return values.get(key(service, account)) ?? null; },
    async setPassword(service, account, value) { values.set(key(service, account), value); },
    async deletePassword(service, account) { return values.delete(key(service, account)); },
  };
  return { store, values };
}

test("backend selection is lazy, explicit, and rejects plaintext/invalid keys", async () => {
  const run: CredentialCommand = async () => { throw new Error("must not run"); };
  createCredentialStore({ env: {}, platform: "linux", run });
  assert.equal(credentialStoreBackend({}, "darwin"), "macOS Keychain");
  assert.equal(credentialStoreBackend({}, "win32"), "Windows Credential Manager");
  assert.equal(credentialStoreBackend({}, "linux"), "Linux Secret Service");
  assert.equal(credentialStoreBackend({ FRELY_CREDENTIAL_KEY: "bad" }, "linux"), "encrypted-file");
  assert.equal(credentialStoreBackend({ FRELY_CREDENTIAL_STORE: "system", FRELY_CREDENTIAL_KEY: "bad" }, "linux"), "Linux Secret Service");
  assert.throws(() => credentialStoreBackend({ FRELY_CREDENTIAL_STORE: "plaintext" }), /Plaintext/);
  const store = createCredentialStore({ env: { FRELY_CREDENTIAL_KEY: "bad" }, run });
  await assert.rejects(store.getPassword("service", "account"), /64 hexadecimal/);
  await assert.rejects(store.getPassword("service", "account\nother"), /control characters/);
});

test("encrypted vault preserves Unicode, multiline, large values and namespace boundaries", async (t) => {
  const { store, root, key } = await fixture(t);
  const value = `private-token-中文\n${"a".repeat(16_000)}\n`;
  assert.equal(await store.getPassword("service", "account"), null);
  await store.setPassword("service", "account", value);
  await store.setPassword("other", "account", "other-value");
  assert.equal(await store.getPassword("service", "account"), value);
  assert.equal(await createEncryptedCredentialStore(root, key).getPassword("service", "account"), value);
  assert.equal(await store.getPassword("service", "missing"), null);
  for (const name of await readdir(root)) {
    const raw = await readFile(join(root, name), "utf8");
    assert.equal(raw.includes("private-token"), false);
    assert.equal(raw.includes(key), false);
  }
  assert.equal(await store.deletePassword("service", "account"), true);
  assert.equal(await store.getPassword("service", "account"), null);
  assert.equal(await store.deletePassword("service", "account"), false);
  assert.equal(await store.getPassword("other", "account"), "other-value");
});

test("encrypted writes use new nonces and owner-only POSIX permissions", async (t) => {
  const { store, root } = await fixture(t);
  await store.setPassword("s", "a", "same-value");
  const path = entryPath(root, "s", "a");
  const before = JSON.parse(await readFile(path, "utf8")) as { iv: string };
  await store.setPassword("s", "a", "same-value");
  const after = JSON.parse(await readFile(path, "utf8")) as { iv: string };
  assert.notEqual(before.iv, after.iv);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
});

test("wrong keys cannot read, overwrite, add, or delete existing vault data", async (t) => {
  const { store, root } = await fixture(t);
  await store.setPassword("s", "a", "original");
  const path = entryPath(root, "s", "a");
  const before = await readFile(path, "utf8");
  const wrong = createEncryptedCredentialStore(root, randomBytes(32).toString("hex"));
  await assert.rejects(wrong.getPassword("s", "a"), /authentication failed/);
  await assert.rejects(wrong.setPassword("s", "a", "replacement"), /authentication failed/);
  await assert.rejects(wrong.setPassword("s", "new", "replacement"), /authentication failed/);
  await assert.rejects(wrong.deletePassword("s", "a"), /authentication failed/);
  assert.equal(await readFile(path, "utf8"), before);
  assert.equal(await store.getPassword("s", "a"), "original");
});

test("ciphertext tampering and cross-account substitution fail authentication", async (t) => {
  const { store, root } = await fixture(t);
  await store.setPassword("s", "a", "value-a");
  await store.setPassword("s", "b", "value-b");
  await copyFile(entryPath(root, "s", "a"), entryPath(root, "s", "b"));
  await assert.rejects(store.getPassword("s", "b"), /authentication failed/);
  const path = entryPath(root, "s", "a");
  const value = JSON.parse(await readFile(path, "utf8")) as { tag: string };
  value.tag = randomBytes(16).toString("base64");
  await writeFile(path, JSON.stringify(value));
  await assert.rejects(store.getPassword("s", "a"), /authentication failed/);
  await assert.rejects(store.setPassword("s", "a", "new"), /authentication failed/);
  await assert.rejects(store.deletePassword("s", "a"), /authentication failed/);
});

test("missing vault header cannot silently initialize over encrypted entries", async (t) => {
  const { store, root } = await fixture(t);
  await store.setPassword("s", "a", "value");
  await unlink(join(root, "vault.json"));
  await assert.rejects(store.getPassword("s", "a"), /authentication failed/);
  await assert.rejects(store.setPassword("s", "b", "new"), /authentication failed/);
});

test("parallel initialization and independent entries retain all writes", async (t) => {
  const { root, key } = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => createEncryptedCredentialStore(root, key).setPassword("s", String(index), `value-${index}`)));
  const store = createEncryptedCredentialStore(root, key);
  for (let index = 0; index < 12; index++) assert.equal(await store.getPassword("s", String(index)), `value-${index}`);
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")), false);
});

test("vault rejects symbolic links, hard links and unsafe POSIX permissions", { skip: process.platform === "win32" }, async (t) => {
  const { root, key, store, directory } = await fixture(t);
  await store.setPassword("s", "a", "value");
  const path = entryPath(root, "s", "a");
  const backup = join(directory, "backup");
  await copyFile(path, backup);
  await unlink(path);
  await symlink(backup, path);
  await assert.rejects(store.getPassword("s", "a"), /not links/);
  await unlink(path);
  await link(backup, path);
  await assert.rejects(store.getPassword("s", "a"), /not links/);
  await unlink(path);
  await copyFile(backup, path);
  await chmod(path, 0o644);
  await assert.rejects(store.getPassword("s", "a"), /permissions are unsafe/);
  await chmod(path, 0o600);
  await chmod(root, 0o755);
  await assert.rejects(createEncryptedCredentialStore(root, key).getPassword("s", "a"), /permissions are unsafe/);
  await chmod(root, 0o700);
});

test("system vault migrates legacy values and stores only a master key in the OS", async (t) => {
  const { root } = await fixture(t);
  const native = memory();
  await native.store.setPassword("s", "a", "legacy-private-key");
  const store = createSystemCredentialStore(root, native.store);
  assert.equal(await store.getPassword("s", "a"), "legacy-private-key");
  assert.equal(native.values.size, 1, "read must not mutate legacy credentials");
  const value = "updated-token-" + "x".repeat(16_000);
  await store.setPassword("s", "a", value);
  assert.equal(await store.getPassword("s", "a"), value);
  assert.equal(await native.store.getPassword("s", "a"), null);
  assert.equal(native.values.size, 1);
  assert.match([...native.values.values()][0]!, /^[a-f0-9]{64}$/u);
  assert.equal(await store.deletePassword("s", "a"), true);
  assert.equal(await store.getPassword("s", "a"), null);
});

test("system vault preserves data if the OS master key is lost", async (t) => {
  const { root } = await fixture(t);
  const native = memory();
  const store = createSystemCredentialStore(root, native.store);
  await store.setPassword("s", "a", "private-key");
  const before = await readFile(entryPath(root, "s", "a"), "utf8");
  native.values.clear();
  await assert.rejects(store.getPassword("s", "a"), /master key is missing/);
  await assert.rejects(store.setPassword("s", "a", "new-key"), /master key is missing/);
  assert.equal(native.values.size, 0);
  assert.equal(await readFile(entryPath(root, "s", "a"), "utf8"), before);
});

test("system vault serializes master creation across store instances", async (t) => {
  const { root } = await fixture(t);
  const native = memory();
  await Promise.all(Array.from({ length: 8 }, (_, index) => createSystemCredentialStore(root, native.store).setPassword("s", String(index), `value-${index}`)));
  assert.equal(native.values.size, 1);
  const store = createSystemCredentialStore(root, native.store);
  for (let index = 0; index < 8; index++) assert.equal(await store.getPassword("s", String(index)), `value-${index}`);
});

test("native access failure never falls back to a file or a replacement identity", async (t) => {
  const { directory, root } = await fixture(t);
  const native: CredentialStore = {
    async getPassword() { throw new Error("locked"); },
    async setPassword() { throw new Error("must not write"); },
    async deletePassword() { throw new Error("locked"); },
  };
  const store = createSystemCredentialStore(root, native);
  await assert.rejects(store.getPassword("s", "a"), /locked/);
  await assert.rejects(store.setPassword("s", "a", "value"), /locked/);
  assert.deepEqual(await readdir(directory), []);
});

test("legacy cleanup failure is reported after the replacement is persisted", async (t) => {
  const { root } = await fixture(t);
  const native = memory();
  await native.store.setPassword("s", "a", "old");
  const originalDelete = native.store.deletePassword;
  native.store.deletePassword = async () => { throw new Error("delete denied"); };
  const store = createSystemCredentialStore(root, native.store);
  await assert.rejects(store.setPassword("s", "a", "new"), /delete denied/);
  assert.equal(await store.getPassword("s", "a"), "new");
  await assert.rejects(store.deletePassword("s", "a"), /delete denied/);
  native.store.deletePassword = originalDelete;
  assert.equal(await store.deletePassword("s", "a"), true);
  assert.equal(await store.getPassword("s", "a"), null);
});

test("macOS decoder distinguishes literal hex from non-ASCII/PEM hex output", async () => {
  let stderr = 'password: "0x012345"\n';
  let code = 0;
  const native = createNativeCredentialStore("darwin", async (_file, args) => {
    assert.ok(args.includes("-g"));
    return { code, stdout: "keychain metadata", stderr };
  });
  assert.equal(await native.getPassword("s", "a"), "0x012345");
  const value = "-----BEGIN PRIVATE KEY-----\n测试\\line\n";
  stderr = `password: 0x${Buffer.from(value).toString("hex")}  "display"\n`;
  assert.equal(await native.getPassword("s", "a"), value);
  code = 44;
  assert.equal(await native.getPassword("s", "a"), null);
  code = 36;
  await assert.rejects(native.getPassword("s", "a"), /OS credential store access failed/);
});

test("macOS write uses stdin and never argv secrets or broad access permissions", async () => {
  const value = "synthetic-secret";
  const calls: { args: string[]; input?: string }[] = [];
  const native = createNativeCredentialStore("darwin", async (_file, args, input) => {
    calls.push({ args, ...(input !== undefined ? { input } : {}) });
    return { code: 0, stdout: "", stderr: args.includes("-g") ? `password: "${value}"\n` : "" };
  });
  await native.setPassword("s", "a", value);
  assert.deepEqual(calls[0]!.args, ["-i"]);
  assert.ok(calls[0]!.input?.includes(Buffer.from(value).toString("hex")));
  assert.equal(calls.some((call) => call.args.join(" ").includes(value)), false);
  assert.equal(calls[0]!.input?.includes("-A"), false);
  await assert.rejects(native.setPassword("s", "bad\nargument", value), /Invalid/);
  await assert.rejects(native.setPassword("s", "a", "x".repeat(3000)), /input limit/);
  assert.equal(calls.length, 2);
});

test("Windows native protocol preserves keytar target/blob with static PowerShell source", async () => {
  let stored: string | null = null;
  const value = "synthetic-win-秘密\n";
  const native = createNativeCredentialStore("win32", async (file, args, input) => {
    assert.ok(file.endsWith("powershell.exe"));
    assert.equal(args.join(" ").includes(value), false);
    assert.equal(args.join(" ").includes(Buffer.from(value).toString("base64")), false);
    assert.equal(args.join(" ").includes("Bypass"), false);
    const request = JSON.parse(input!) as { operation: string; target: string; account: string; data?: string };
    assert.equal(request.target, "service/account");
    assert.equal(request.account, "account");
    if (request.operation === "get") return { code: 0, stdout: JSON.stringify({ ok: true, data: stored }), stderr: "" };
    if (request.operation === "set") { stored = request.data!; return { code: 0, stdout: '{"ok":true}', stderr: "" }; }
    const deleted = stored !== null;
    stored = null;
    return { code: 0, stdout: JSON.stringify({ ok: true, deleted }), stderr: "" };
  });
  assert.equal(await native.getPassword("service", "account"), null);
  await native.setPassword("service", "account", value);
  assert.equal(await native.getPassword("service", "account"), value);
  assert.equal(await native.deletePassword("service", "account"), true);
  assert.equal(await native.getPassword("service", "account"), null);
});

test("Linux matches legacy attributes and distinguishes missing entries from locked service", async () => {
  let stored: string | null = null;
  let locked = false;
  const value = "synthetic-linux-秘密\n";
  const native = createNativeCredentialStore("linux", async (file, args, input) => {
    assert.equal(file, "secret-tool");
    assert.deepEqual(args.slice(-4), ["service", "s", "account", "a"]);
    assert.equal(args.includes(value), false);
    if (locked) return { code: 1, stdout: "", stderr: "Secret Service locked" };
    if (args[0] === "store") stored = input!;
    if (args[0] === "clear") stored = null;
    if (args[0] === "lookup") return stored === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: stored, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  assert.equal(await native.getPassword("s", "a"), null);
  await native.setPassword("s", "a", value);
  assert.equal(await native.getPassword("s", "a"), value);
  locked = true;
  await assert.rejects(native.getPassword("s", "a"), /OS credential store access failed/);
  await assert.rejects(native.deletePassword("s", "a"), /OS credential store access failed/);
  locked = false;
  assert.equal(await native.deletePassword("s", "a"), true);
});

test("command runner preserves split UTF-8 bytes and bounds output", async () => {
  const result = await runCredentialCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xe4])); setTimeout(()=>process.stdout.write(Buffer.from([0xb8,0xad])),10)"]);
  assert.equal(result.stdout, "中");
  await assert.rejects(runCredentialCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(3*1024*1024))"]), /size limit/);
  await assert.rejects(runCredentialCommand(join(tmpdir(), "frely-nonexistent-command"), []), /OS credential tool is unavailable/);
});
