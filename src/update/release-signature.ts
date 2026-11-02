import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * Ed25519 public keys (base64url SPKI) whose signatures make a release trustworthy. The private key stays offline with the owner.
 * Empty until the owner generates the key (`node scripts/release-keygen.mjs`) and adds its public half here.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = [];
/** P1 (record only): an unsigned release still installs. P2 flips this so a missing signature fails the update. */
export const RELEASE_SIGNATURE_REQUIRED = false;

/** What the release script signs: version, asset name and the SHA-256 of the executable, so a signature cannot be moved to another version or platform. */
export function releaseSigningMessage(version: string, asset: string, sha256: string): Buffer {
  return Buffer.from(`frely.release.v1\n${version}\n${asset}\n${sha256.toLowerCase()}\n`);
}

export type SignatureOutcome = "verified" | "unsigned";

/**
 * Throws when a signature is present and does not verify against any trusted key, or when one is required and missing.
 * With no trusted keys configured nothing can be verified, so the outcome is "unsigned".
 */
export function checkReleaseSignature(options: { version: string; asset: string; checksumText: string; signature: string | undefined;
  keys?: readonly string[]; required?: boolean }): SignatureOutcome {
  const keys = options.keys ?? RELEASE_PUBLIC_KEYS, required = options.required ?? RELEASE_SIGNATURE_REQUIRED;
  const hash = /^([a-fA-F0-9]{64})(?:\s|$)/u.exec(options.checksumText)?.[1];
  if (!hash) throw new Error("Invalid release checksum.");
  if (keys.length === 0) {
    if (required) throw new Error("No release signing key is configured; the update was refused.");
    return "unsigned";
  }
  if (!options.signature?.trim()) {
    if (required) throw new Error("The release is not signed; the installed executable was not changed.");
    return "unsigned";
  }
  const message = releaseSigningMessage(options.version, options.asset, hash);
  const signature = Buffer.from(options.signature.trim(), "base64url");
  for (const key of keys) {
    try { if (verify(null, message, createPublicKey({ key: Buffer.from(key, "base64url"), format: "der", type: "spki" }), signature)) return "verified"; } catch { /* next key */ }
  }
  throw new Error("Release signature is invalid; the installed executable was not changed.");
}

export const keyId = (key: string): string => createHash("sha256").update(Buffer.from(key, "base64url")).digest("hex").slice(0, 16);
