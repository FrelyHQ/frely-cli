import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { createEncryptedCredentialStore, ensureCredentialDirectory } from "./credential-file.js";
import type { CredentialStore } from "./credential-store.js";

const MASTER_SERVICE = "frely-cli-vault";

/** The OS stores a 32-byte master key; authenticated files hold variable-size credentials. */
export function createSystemCredentialStore(root: string, native: CredentialStore): CredentialStore {
  const masterAccount = `v1:${createHash("sha256").update(root).digest("hex")}`;
  async function masterKey(create: boolean): Promise<string | null> {
    const read = async (): Promise<string | null> => {
      const key = await native.getPassword(MASTER_SERVICE, masterAccount);
      if (key !== null && !/^[a-f0-9]{64}$/u.test(key)) throw new Error("The OS credential vault master key is invalid. Existing credentials were not replaced.");
      return key;
    };
    const existing = await read();
    if (existing !== null) return existing;
    const directoryExists = await ensureCredentialDirectory(root, create);
    const hasData = async () => directoryExists && (await readdir(root)).some((name) => name.endsWith(".json"));
    if (await hasData()) throw new Error("The OS credential vault master key is missing or inaccessible. Restore OS credential access; Frely will not generate a replacement key over existing data.");
    if (!create) return null;
    const lock = join(root, ".system-init.lock");
    let locked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); locked = true; break; }
      catch (error) {
        if (!directoryLockBusy(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!locked) throw new Error("OS credential vault initialization is locked. Check other Frely processes or a stale .system-init.lock directory.");
    try {
      const current = await read();
      if (current !== null) return current;
      if (await hasData()) throw new Error("OS credential vault master key is missing. Existing encrypted data was not replaced.");
      const key = randomBytes(32).toString("hex");
      await native.setPassword(MASTER_SERVICE, masterAccount, key);
      if (await read() !== key) throw new Error("OS credential vault master-key readback failed.");
      return key;
    } finally { await rmdir(lock); }
  }
  return {
    async getPassword(service, account) {
      const key = await masterKey(false);
      if (key !== null) {
        const stored = await createEncryptedCredentialStore(root, key).getPassword(service, account);
        if (stored !== null) return stored;
      }
      // Preserve old keytar credentials, including enrolled device keys. An OS error
      // propagates instead of being interpreted as a missing device identity.
      return native.getPassword(service, account);
    },
    async setPassword(service, account, password) {
      const key = await masterKey(true);
      if (key === null) throw new Error("OS credential vault initialization failed.");
      const files = createEncryptedCredentialStore(root, key);
      await files.setPassword(service, account, password);
      if (await files.getPassword(service, account) !== password) throw new Error("Credential vault readback failed.");
      // Persist the replacement before removing a legacy entry. Deletion failures
      // remain errors, and logout retries both stores so old tokens cannot reappear.
      await native.deletePassword(service, account);
    },
    async deletePassword(service, account) {
      const key = await masterKey(false);
      const legacyDeleted = await native.deletePassword(service, account);
      const fileDeleted = key === null ? false : await createEncryptedCredentialStore(root, key).deletePassword(service, account);
      return legacyDeleted || fileDeleted;
    },
  };
}

function directoryLockBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  if (code === "EEXIST") return true;
  // Windows may surface directory-lock contention as a sharing/access error.
  // Retry only inside the bounded initialization window; no fallback is used.
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY");
}
