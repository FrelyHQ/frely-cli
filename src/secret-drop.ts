import { createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { observeIdentity } from "./trust/observe.js";
import { jcs } from "./trust/jcs.js";
import { verifyApproval, type SignedApproval } from "./trust/record.js";
import { readTrustWithReason, type TrustRefresh } from "./trust/sync.js";
import { refreshAccountTrust } from "./device/control.js";
import { NO_TRUST_MESSAGE, TrustError } from "./trust/webauthn.js";

/**
 * Secret drop: the owner pastes a secret on the approval site, bound to one destination, and this device writes it there with a fixed
 * template. The AI that asked only ever gets a receipt. The relay's two hidden tools, never listed (the relay refuses client calls to them):
 *   secret_drop_prepare  makes a one-use X25519 key for one drop and returns its public half (the private half stays in this process's memory);
 *   secret_drop_apply    takes the ciphertext and the owner's passkey-signed approval, verifies both itself, decrypts in memory and writes.
 * The signed approval binds the drop id, destination, this device's key and the ciphertext, so a relay cannot change any of them.
 */
export const SECRET_DROP_PREPARE_TOOL = "secret_drop_prepare";
export const SECRET_DROP_APPLY_TOOL = "secret_drop_apply";
export const SECRET_DROP_GRANT = "secret_drop";
const KDF_INFO = "frely.secret-drop.v1";
const KEY_TTL_MS = 20 * 60_000;
const MAX_PENDING_KEYS = 32;
export const SECRET_DROP_MAX_BYTES = 4096;
const DROP_ID = /^[A-Za-z0-9_-]{8,64}$/u;
const ACCOUNT = /^[a-z_][a-z0-9_-]{0,31}$/u;
const PATH = /^\/[A-Za-z0-9._@%+=:,/-]{1,1000}$/u;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MODE = /^[0-7]{3,4}$/u;

export interface SecretDropTarget { kind: "file" | "ssh_file"; path: string; owner: string; group: string; mode: string; host?: string }

/** The destination exactly as the owner signs it; anything outside these shapes is refused (no shell syntax can ride in a path or name). */
export function parseSecretDropTarget(value: unknown): SecretDropTarget {
  const bad = (reason: string): never => { throw new Error(`The destination is not allowed: ${reason}.`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("it is not an object");
  const t = value as Record<string, unknown>;
  if (t.kind !== "file" && t.kind !== "ssh_file") return bad("kind must be file or ssh_file");
  if (typeof t.path !== "string" || !PATH.test(t.path) || !isAbsolute(t.path) || t.path.endsWith("/") || t.path.slice(1).split("/").some((part) => part === "." || part === ".." || part === "")) return bad("path must be an absolute file path without dot segments");
  if (typeof t.owner !== "string" || !ACCOUNT.test(t.owner) || typeof t.group !== "string" || !ACCOUNT.test(t.group)) return bad("owner and group must be plain account names");
  if (typeof t.mode !== "string" || !MODE.test(t.mode) || (Number.parseInt(t.mode, 8) & 0o022) !== 0) return bad("mode must be octal and not writable by group or others");
  if (t.kind === "ssh_file" && (typeof t.host !== "string" || !HOST.test(t.host))) return bad("host must be an ssh alias");
  if (t.kind === "file" && t.host !== undefined) return bad("a local file has no host");
  return { kind: t.kind, path: t.path, owner: t.owner, group: t.group, mode: t.mode, ...(t.kind === "ssh_file" ? { host: t.host as string } : {}) };
}

/** What the owner's passkey signature covers besides the drop itself: destination, this device's one-use key and the exact ciphertext. */
export function secretDropBinding(input: { dropId: string; target: SecretDropTarget; epk: string; ciphertext: string }): string {
  return createHash("sha256").update(jcs({ drop: input.dropId, target: input.target, epk: input.epk, ct: input.ciphertext })).digest("base64url");
}

interface PendingKey { privateKey: KeyObject; epk: string; exp: number }
const pending = new Map<string, PendingKey>();
const wipeExpired = (now: number): void => { for (const [id, key] of pending) if (key.exp <= now) pending.delete(id); };

/** Makes the one-use key for one drop. The private half is memory-only: a restart of this process cancels the drop. */
export function prepareSecretDrop(args: Record<string, unknown>, now = Date.now()): { dropId: string; epk: string; expiresAt: string } {
  const dropId = args.dropId;
  if (typeof dropId !== "string" || !DROP_ID.test(dropId)) throw new Error("dropId is invalid.");
  wipeExpired(now);
  if (!pending.has(dropId) && pending.size >= MAX_PENDING_KEYS) throw new Error("Too many secret drops are waiting on this computer.");
  const pair = generateKeyPairSync("x25519");
  const epk = String(pair.publicKey.export({ format: "jwk" }).x);
  pending.set(dropId, { privateKey: pair.privateKey, epk, exp: now + KEY_TTL_MS });
  return { dropId, epk, expiresAt: new Date(now + KEY_TTL_MS).toISOString() };
}

/** The browser side (apps/approve) builds this exact blob: sender public key (32) | iv (12) | AES-256-GCM ciphertext and tag, base64url. */
function decrypt(blob: string, key: PendingKey, dropId: string): Buffer {
  const raw = Buffer.from(blob, "base64url");
  if (raw.length < 32 + 12 + 16 + 1 || raw.length > 32 + 12 + 16 + SECRET_DROP_MAX_BYTES) throw new TrustError("ciphertext_invalid");
  const sender = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.subarray(0, 32).toString("base64url") }, format: "jwk" });
  const shared = diffieHellman({ privateKey: key.privateKey, publicKey: sender });
  const aes = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), `${KDF_INFO}\0${dropId}`, 32));
  try {
    const decipher = createDecipheriv("aes-256-gcm", aes, raw.subarray(32, 44));
    decipher.setAAD(Buffer.from(dropId, "utf8"));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(44, raw.length - 16)), decipher.final()]);
  } catch { throw new TrustError("ciphertext_invalid"); } finally { aes.fill(0); shared.fill(0); }
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
export type SecretDropRunner = (command: string, args: string[], stdin: Buffer) => Promise<RunResult>;

const defaultRunner: SecretDropRunner = (command, args, stdin) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK ?? "" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8").slice(0, 4096); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8").slice(0, 4096); });
  child.on("error", (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
  child.on("close", (code) => resolve({ code, stdout, stderr }));
  child.stdin.on("error", () => undefined);
  child.stdin.end(stdin);
});

/** The one fixed write script. The path and names arrive as positional parameters; the value arrives only on stdin. */
export const WRITE_SCRIPT = [
  "set -eu", "umask 077",
  'p=$1; o=$2; g=$3; m=$4',
  'd=$(dirname -- "$p")',
  'if [ ! -d "$d" ]; then mkdir -p -- "$d"; chmod 0700 "$d"; chown "$o:$g" "$d"; fi',
  "r=0; if [ -e \"$p\" ]; then r=1; fi",
  't="$p.frely-drop.$$"',
  "trap 'rm -f -- \"$t\"' EXIT",
  'cat > "$t"', 'if [ "$(id -un):$(id -gn)" != "$o:$g" ]; then chown "$o:$g" "$t"; fi', 'chmod "$m" "$t"', 'mv -f "$t" "$p"', "trap - EXIT", 'echo "replaced=$r"',
].join("\n");

const shQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;

/** The argv of the writer: local (through `sudo -n` unless the file belongs to this very account) or over an ssh alias. */
export function writerCommand(target: SecretDropTarget, self = userInfo().username, root = process.getuid?.() === 0): { command: string; args: string[] } {
  const params = [target.path, target.owner, target.group, target.mode];
  if (target.kind === "ssh_file") {
    return { command: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", target.host!, ["sudo", "-n", "sh", "-c", shQuote(WRITE_SCRIPT), "sh", ...params.map(shQuote)].join(" ")] };
  }
  const plain = root || target.owner === self;
  return plain ? { command: "sh", args: ["-c", WRITE_SCRIPT, "sh", ...params] } : { command: "sudo", args: ["-n", "sh", "-c", WRITE_SCRIPT, "sh", ...params] };
}

export interface SecretDropDeps { run?: SecretDropRunner; now?: () => number; refreshTrust?: TrustRefresh }

/** Never returns anything that could carry the value; stderr is scrubbed again against the plaintext as a last guard. */
const scrub = (text: string, secret: Buffer): string => {
  const value = secret.toString("utf8");
  return (value.length > 0 ? text.split(value).join("[hidden]") : text).slice(0, 500);
};

export async function applySecretDrop(args: Record<string, unknown>, deps: SecretDropDeps = {}): Promise<Record<string, unknown>> {
  const now = deps.now?.() ?? Date.now();
  const identity = observeIdentity();
  if (!identity) throw new TrustError("device_not_bound");
  const { trust, problem } = await readTrustWithReason({ relayUrl: identity.relayUrl, userId: identity.userId }, deps.refreshTrust ?? refreshAccountTrust);
  if (!trust) throw new TrustError("no_trust_record", problem ?? NO_TRUST_MESSAGE);
  const dropId = args.dropId;
  if (typeof dropId !== "string" || !DROP_ID.test(dropId)) throw new Error("dropId is invalid.");
  // One use: the key leaves the map before anything is checked, so a failed or replayed apply cannot be retried with the same key.
  wipeExpired(now);
  const key = pending.get(dropId);
  pending.delete(dropId);
  if (!key) throw new TrustError("drop_unknown", "This computer has no open secret drop with that id (it expired or this computer restarted). Ask again.");
  const target = parseSecretDropTarget(args.target);
  const ciphertext = args.ciphertext;
  if (typeof ciphertext !== "string" || ciphertext.length < 1 || ciphertext.length > 12_000) throw new TrustError("ciphertext_invalid");
  if (args.epk !== key.epk) throw new TrustError("key_mismatch");
  const approval = args.approval as SignedApproval | undefined;
  if (!approval || typeof approval !== "object") throw new TrustError("approval_missing");
  const payload = verifyApproval(approval, { record: trust.record, device: identity.device, deviceKey: identity.deviceKey, now });
  if (payload.grant.kind !== SECRET_DROP_GRANT || payload.grant.mode !== "once" || payload.grant.resource !== dropId || payload.id !== dropId) throw new TrustError("wrong_grant");
  if (payload.ctl !== undefined || payload.scope !== undefined) throw new TrustError("approval_invalid");
  if (payload.bind?.tool !== SECRET_DROP_APPLY_TOOL || payload.bind.cmdHash !== secretDropBinding({ dropId, target, epk: key.epk, ciphertext })) throw new TrustError("bind_mismatch");
  const secret = decrypt(ciphertext, key, dropId);
  try {
    const { command, args: argv } = writerCommand(target);
    const result = await (deps.run ?? defaultRunner)(command, argv, secret);
    if (result.code !== 0) throw new Error(`The write failed on ${target.kind === "ssh_file" ? target.host : "this computer"} (exit ${result.code ?? "none"}): ${scrub(result.stderr.trim() || "no error text", secret)}`);
    return { status: "written", target: { kind: target.kind, ...(target.host ? { host: target.host } : {}), path: target.path }, bytes: secret.length, owner: target.owner, group: target.group, mode: target.mode, replaced: /replaced=1/u.test(result.stdout) };
  } finally { secret.fill(0); }
}

/** Test hook: forget every open drop key. */
export function forgetSecretDropKeys(): void { pending.clear(); }
