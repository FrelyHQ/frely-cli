import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureCredentialDirectory, readPrivateFile, writePrivateFile } from "../credential-file.js";

/**
 * Sealed scripts of a download-install item. The server encrypts every paid script with a key derived for the item
 * version and sends that key only as a lease wrapped to this device's X25519 key, with an expiry the server signs
 * into the wrapping. The installed folder holds ciphertext and a lease, so a copy of it opens on no other device.
 * This does not hide a script from the agent or the user on this device; it stops copying the folder.
 */

export interface SealedLease {
  readonly keyId: string;
  readonly expiresAt: string;
  readonly ephemeralPublicKey: string;
  readonly nonce: string;
  readonly wrappedKey: string;
}

export interface DeviceSealKey {
  /** Raw X25519 public key, base64url: what `skills.install` takes as `sealTo`. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

const WRAP_INFO = Buffer.from("frely.cloud-skill.seal.wrap.v1");
const FILE_INFO = "frely.cloud-skill.seal.file.v1|";
const KEY_FILE = "sealed-device-key-v1.json";

const keyFilePath = (env: NodeJS.ProcessEnv, home: string): string => join(resolve(env.XDG_CONFIG_HOME || join(home, ".config")), "frely", KEY_FILE);

/** This device's lease key, created on first use in the owner-only Frely config directory (which the command sandbox never opens). */
export async function loadOrCreateDeviceSealKey(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<DeviceSealKey> {
  const path = keyFilePath(env, home);
  const existing = await readPrivateFile(path);
  if (existing !== null) {
    const stored = JSON.parse(existing) as { version?: unknown; privateKeyPem?: unknown };
    if (stored.version !== 1 || typeof stored.privateKeyPem !== "string") throw new Error("The sealed-item key file is invalid.");
    return fromPrivate(createPrivateKey(stored.privateKeyPem));
  }
  const pair = generateKeyPairSync("x25519");
  await ensureCredentialDirectory(dirname(path), true);
  await writePrivateFile(path, JSON.stringify({ version: 1, privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }) + "\n");
  return fromPrivate(pair.privateKey);
}

function fromPrivate(privateKey: KeyObject): DeviceSealKey {
  return { privateKey, publicKey: String(createPublicKey(privateKey).export({ format: "jwk" }).x) };
}

/** The version key a lease carries; throws when the lease is not for this device or its expiry was changed. */
export function unwrapLease(device: DeviceSealKey, lease: SealedLease, skillId: string, version: number): Buffer {
  const shared = diffieHellman({ privateKey: device.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: lease.ephemeralPublicKey }, format: "jwk" }) });
  const salt = Buffer.concat([Buffer.from(lease.ephemeralPublicKey, "base64url"), Buffer.from(device.publicKey, "base64url")]);
  const wrapKey = Buffer.from(hkdfSync("sha256", shared, salt, WRAP_INFO, 32));
  const body = Buffer.from(lease.wrappedKey, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(lease.nonce, "base64url"));
  decipher.setAAD(Buffer.from(`${lease.keyId}|${skillId}|${version}|${lease.expiresAt}`));
  decipher.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
}

/** Decrypts one sealed file (`nonce(12) | ciphertext | tag(16)`). */
export function openSealedFile(versionKey: Buffer, skillId: string, version: number, path: string, sealed: Buffer): Buffer {
  const fileKey = Buffer.from(hkdfSync("sha256", versionKey, Buffer.alloc(0), Buffer.from(FILE_INFO + path), 32));
  const decipher = createDecipheriv("aes-256-gcm", fileKey, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${skillId}|${version}|${path}`));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
}

export function parseLease(value: unknown): SealedLease | null {
  const record = value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!record) return null;
  const { keyId, expiresAt, ephemeralPublicKey, nonce, wrappedKey } = record;
  if (![keyId, expiresAt, ephemeralPublicKey, nonce, wrappedKey].every((field) => typeof field === "string" && field.length > 0 && field.length < 512) || Number.isNaN(Date.parse(expiresAt as string))) return null;
  return { keyId, expiresAt, ephemeralPublicKey, nonce, wrappedKey } as SealedLease;
}

const PYTHON = process.platform === "win32" ? "python" : "python3";
const INTERPRETERS: Readonly<Record<string, readonly string[]>> = {
  ".py": [PYTHON], ".sh": ["bash"], ".bash": ["bash"], ".js": ["node"], ".cjs": ["node"], ".mjs": ["node"], ".rb": ["ruby"], ".pl": ["perl"],
};

export function interpreterFor(path: string): readonly string[] | undefined {
  return INTERPRETERS[path.slice(path.lastIndexOf(".")).toLowerCase()];
}

/**
 * Plain placeholder written where a sealed script was, so `python scripts/run.py` keeps working unchanged: it hands over to
 * `frely item run`, which decrypts and runs the real script in the Frely sandbox. Undefined for script types without a placeholder.
 */
export function stubFor(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (extension === ".py") return 'import os, sys\nos.execvp("frely", ["frely", "item", "run", os.path.abspath(__file__), *sys.argv[1:]])\n';
  if (extension === ".sh" || extension === ".bash") return 'exec frely item run "$0" "$@"\n';
  if (extension === ".js" || extension === ".cjs") return 'const r = require("node:child_process").spawnSync("frely", ["item", "run", __filename, ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n';
  if (extension === ".mjs") return 'import { spawnSync } from "node:child_process";\nimport { fileURLToPath } from "node:url";\nconst r = spawnSync("frely", ["item", "run", fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n';
  if (extension === ".rb") return 'exec("frely", "item", "run", File.expand_path(__FILE__), *ARGV)\n';
  if (extension === ".pl") return 'exec("frely", "item", "run", $0, @ARGV) or die "frely: $!";\n';
  return undefined;
}
