import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialStore } from "./credential-store.js";

const HEADER = "vault.json";
const CHECK = "frely credential vault v1";
const MAX_FILE_SIZE = 2 * 1024 * 1024;
const invalid = () => new Error("Encrypted credential authentication failed. Check FRELY_CREDENTIAL_KEY and vault integrity. Existing credentials were not replaced.");

/** The encryption key is injected by the operator; this module never writes it to disk. */
export function createEncryptedCredentialStore(root: string, keyHex: string): CredentialStore {
  if (!/^[a-fA-F0-9]{64}$/u.test(keyHex)) throw new Error("FRELY_CREDENTIAL_KEY must be a 32-byte random key encoded as 64 hexadecimal characters. Provision it through a secret manager; do not store it next to the vault.");
  const key = Buffer.from(keyHex, "hex");
  const context = (service: string, account: string) => JSON.stringify(["frely.credentials.v1", service, account]);
  const entryPath = (service: string, account: string) => join(root, `${createHash("sha256").update(context(service, account)).digest("hex")}.json`);
  const headerContext = context("vault", "key-check");

  function encrypt(value: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }) + "\n";
  }
  function decrypt(raw: string, aad: string): string {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.version !== 1 || value.algorithm !== "aes-256-gcm") throw invalid();
      const decode = (input: unknown): Buffer => {
        if (typeof input !== "string") throw invalid();
        const result = Buffer.from(input, "base64");
        if (result.toString("base64") !== input) throw invalid();
        return result;
      };
      const iv = decode(value.iv), tag = decode(value.tag), data = decode(value.data);
      if (iv.length !== 12 || tag.length !== 16) throw invalid();
      const cipher = createDecipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad));
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
    } catch { throw invalid(); }
  }
  async function checkHeader(create: boolean): Promise<boolean> {
    if (!await ensureCredentialDirectory(root, create)) return false;
    const path = join(root, HEADER);
    const check = async (): Promise<boolean> => {
      const raw = await readPrivateFile(path);
      if (raw === null) return false;
      if (decrypt(raw, headerContext) !== CHECK) throw invalid();
      return true;
    };
    if (await check()) return true;
    if (!create) {
      if ((await readdir(root)).some((name) => name.endsWith(".json"))) throw invalid();
      return false;
    }
    // Serialize first-key initialization across processes. A stale lock fails closed.
    const lock = join(root, ".init.lock");
    let locked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); locked = true; break; }
      catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!locked) throw new Error("Credential vault initialization is locked. Check for another Frely process or a stale .init.lock directory before retrying.");
    try {
      if (!await check()) {
        if ((await readdir(root)).some((name) => name.endsWith(".json"))) throw invalid();
        await writePrivateFile(path, encrypt(CHECK, headerContext));
      }
    } finally { await rmdir(lock); }
    return true;
  }
  return {
    async getPassword(service, account) {
      if (!await checkHeader(false)) return null;
      const raw = await readPrivateFile(entryPath(service, account));
      return raw === null ? null : decrypt(raw, context(service, account));
    },
    async setPassword(service, account, password) {
      await checkHeader(true);
      const path = entryPath(service, account);
      const previous = await readPrivateFile(path);
      if (previous !== null) decrypt(previous, context(service, account));
      await writePrivateFile(path, encrypt(password, context(service, account)));
    },
    async deletePassword(service, account) {
      if (!await checkHeader(false)) return false;
      const path = entryPath(service, account);
      const raw = await readPrivateFile(path);
      if (raw === null) return false;
      decrypt(raw, context(service, account));
      try { await unlink(path); return true; }
      catch (error) { if (hasCode(error, "ENOENT")) return false; throw error; }
    },
  };
}

export async function ensureCredentialDirectory(path: string, create: boolean): Promise<boolean> {
  let info: Stats;
  try { info = await lstat(path); }
  catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    if (!create) return false;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const parent = await lstat(dirname(path));
    assertPrivate(parent, true);
    await mkdir(path, { mode: 0o700 }).catch((error: unknown) => { if (!hasCode(error, "EEXIST")) throw error; });
    info = await lstat(path);
  }
  assertPrivate(await lstat(dirname(path)), true);
  assertPrivate(info, true);
  return true;
}
function assertPrivate(info: Stats, directory: boolean): void {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1)) throw new Error("Credential vault paths must be regular owner-controlled files and directories, not links.");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) throw new Error("Credential vault permissions are unsafe. Use owner-only directories (0700) and files (0600).");
}
async function readPrivateFile(path: string): Promise<string | null> {
  let before: Stats;
  try { before = await lstat(path); }
  catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  assertPrivate(before, false);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    assertPrivate(info, false);
    if (info.ino !== before.ino || info.dev !== before.dev || info.size > MAX_FILE_SIZE) throw new Error("Credential vault file changed or exceeded the size limit.");
    const raw = await file.readFile("utf8");
    if (Buffer.byteLength(raw) > MAX_FILE_SIZE) throw new Error("Credential vault file exceeded the size limit.");
    return raw;
  } finally { await file.close(); }
}
async function writePrivateFile(path: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_FILE_SIZE) throw new Error("Credential exceeded the size limit.");
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
  }
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
