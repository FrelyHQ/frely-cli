import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createCredentialStore } from "../dist/credential-store.js";
import { createNativeCredentialStore } from "../dist/credential-native.js";

// All OS entries belong to this test's random namespace. Never inspect real accounts.
const directory = await mkdtemp(join(tmpdir(), "frely-credential-smoke-"));
const service = `frely-cli-test-${randomUUID()}`;
const account = "smoke";
const root = resolve(join(directory, "frely", "system-credentials-v1"));
const masterAccount = `v1:${createHash("sha256").update(root).digest("hex")}`;
const env = { ...process.env, XDG_CONFIG_HOME: directory, FRELY_CREDENTIAL_STORE: "system" };
delete env.FRELY_CREDENTIAL_KEY;
const native = createNativeCredentialStore();
const store = createCredentialStore({ env });
let cleanupFailed = false;
try {
  assert.equal(await store.getPassword(service, account), null);
  for (const value of [
    JSON.stringify({ version: 1, type: "oauth", accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: 2_000_000_000_000 }),
    "0x0123456789abcdef",
    "-----BEGIN PRIVATE KEY-----\nsynthetic-key-中文\n-----END PRIVATE KEY-----\n",
  ]) {
    await native.setPassword(service, account, value);
    assert.ok(await store.getPassword(service, account) === value, "legacy credential bytes must survive decoding");
  }
  const value = JSON.stringify({ token: "synthetic-token-" + "x".repeat(16_000), label: "测试", privateKey: "line-one\nline-two\n" });
  await store.setPassword(service, account, value);
  assert.ok(await store.getPassword(service, account) === value, "large encrypted credential must round-trip");
  assert.equal(await native.getPassword(service, account), null, "legacy entry must be removed after verified persistence");
  const code = `import {createHash} from 'node:crypto'; import {credentialStore} from './dist/credential-store.js'; const value=await credentialStore.getPassword(process.argv[1],process.argv[2]); if(value===null) process.exit(2); console.log(createHash('sha256').update(value).digest('hex'));`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code, service, account], { env, timeout: 30_000 });
  assert.equal(result.stdout.trim(), createHash("sha256").update(value).digest("hex"), "another process must read the same persisted credential");
  assert.equal(await store.deletePassword(service, account), true);
  assert.equal(await store.getPassword(service, account), null);
  assert.equal(await store.deletePassword(service, account), false);
  console.log(`Native credential smoke passed (${process.platform}): legacy migration, Unicode/multiline, 16 KiB value, process restart, deletion.`);
} finally {
  for (const [name, user] of [[service, account], ["frely-cli-vault", masterAccount]]) {
    await native.deletePassword(name, user).catch(() => { cleanupFailed = true; });
  }
  await rm(directory, { recursive: true, force: true });
  if (cleanupFailed) throw new Error("Synthetic credential cleanup failed. Check the test-specific OS entries.");
}
