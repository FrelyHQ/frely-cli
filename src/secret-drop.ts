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
import { LOCKED_HINT, saveLogin, unlockVault, upsertNote, vaultStatus, type NewLogin, type NoteField, type SaveLoginResult, type UpsertNoteResult } from "./vault/bitwarden.js";

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

export const SECRET_DROP_FIELD_TYPES = ["password", "text", "number", "textarea"] as const;
export const SECRET_DROP_FORMATS = ["raw", "env", "json"] as const;
export interface SecretDropField { name: string; label: string; type: (typeof SECRET_DROP_FIELD_TYPES)[number]; required: boolean; max?: number }
export interface SecretDropFileTarget { kind: "file" | "ssh_file"; path: string; owner: string; group: string; mode: string; host?: string; fields?: SecretDropField[]; format?: (typeof SECRET_DROP_FORMATS)[number] }
/** Unlocks the Bitwarden vault on this computer; the value is its master password and goes to `unlockVault`, never to a file. */
export interface SecretDropVaultUnlockTarget { kind: "vault_unlock" }
/**
 * Saves into the Bitwarden vault on this computer. With `origin`: a new website login, its field list fixed here and in the relay. Without:
 * a secure note named `name` whose fields (environment variable names, password = hidden) the AI chose and the owner signed.
 */
export interface SecretDropVaultItemTarget { kind: "vault_item"; origin?: string; name: string; fields: SecretDropField[]; format: "json" }
export type SecretDropTarget = SecretDropFileTarget | SecretDropVaultUnlockTarget | SecretDropVaultItemTarget;
export const VAULT_ITEM_FIELDS: readonly SecretDropField[] = [
  { name: "username", label: "Username or email", type: "text", required: true, max: 256 },
  { name: "password", label: "Password", type: "password", required: true, max: 1024 },
  { name: "totp", label: "TOTP secret", type: "password", required: false, max: 256 },
];
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

/** Same rules as the relay's own check: the field list is part of what the owner signed, so it is rebuilt byte for byte or refused. */
function parseFields(t: Record<string, unknown>): { fields?: SecretDropField[]; format?: (typeof SECRET_DROP_FORMATS)[number] } {
  const bad = (reason: string): never => { throw new Error(`The destination is not allowed: ${reason}.`); };
  if (t.fields === undefined) { if (t.format !== undefined) bad("format needs fields"); return {}; }
  if (!Array.isArray(t.fields) || t.fields.length < 1 || t.fields.length > 8) return bad("fields must list 1 to 8 fields");
  const seen = new Set<string>();
  const fields = t.fields.map((raw: unknown): SecretDropField => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("a field is not an object");
    const f = raw as Record<string, unknown>;
    if (Object.keys(f).some((key) => !["name", "label", "type", "required", "max"].includes(key))) return bad("a field has an unknown property");
    if (typeof f.name !== "string" || !FIELD_NAME.test(f.name) || seen.has(f.name)) return bad("field names must be unique plain names");
    seen.add(f.name);
    if (typeof f.label !== "string" || f.label.trim().length < 1 || f.label.length > 80 || /[\r\n]/u.test(f.label)) return bad("a field label is not one short line");
    if (!(SECRET_DROP_FIELD_TYPES as readonly unknown[]).includes(f.type)) return bad("unknown field type");
    if (f.required !== undefined && typeof f.required !== "boolean") return bad("required must be true or false");
    if (f.max !== undefined && (!Number.isInteger(f.max) || (f.max as number) < 1 || (f.max as number) > 4096)) return bad("max is out of range");
    return { name: f.name, label: f.label.trim(), type: f.type as SecretDropField["type"], required: f.required !== false, ...(f.max !== undefined ? { max: f.max as number } : {}) };
  });
  const format = t.format === undefined ? (fields.length === 1 ? "raw" : "env") : t.format;
  if (!(SECRET_DROP_FORMATS as readonly unknown[]).includes(format)) return bad("unknown format");
  if (format === "raw" && fields.length !== 1) return bad("raw needs exactly one field");
  if (format === "env" && fields.some((f) => f.type === "textarea")) return bad("env cannot hold a multi-line field");
  return { fields, format: format as (typeof SECRET_DROP_FORMATS)[number] };
}

/** Checks the decrypted JSON against the signed field list and turns it into the bytes to write: the value itself, NAME=value lines, or JSON. */
export function renderSecretFields(target: Pick<SecretDropFileTarget, "fields" | "format">, plain: Buffer): Buffer {
  if (!target.fields) return plain;
  let values: unknown;
  try { values = JSON.parse(target.format === "raw" ? JSON.stringify({ [target.fields[0]!.name]: plain.toString("utf8") }) : plain.toString("utf8")); } catch { throw new TrustError("fields_invalid", "The values did not match the requested fields."); }
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new TrustError("fields_invalid", "The values did not match the requested fields.");
  const given = values as Record<string, unknown>;
  const names = new Set(target.fields.map((f) => f.name));
  if (Object.keys(given).some((key) => !names.has(key))) throw new TrustError("fields_invalid", "The values did not match the requested fields.");
  const out: Record<string, string> = {};
  for (const f of target.fields) {
    const v = given[f.name];
    if (typeof v !== "string" || (v === "" && f.required) || (f.max !== undefined && v.length > f.max) || (f.type === "number" && v !== "" && !/^-?[0-9]+(\.[0-9]+)?$/u.test(v)) || (f.type !== "textarea" && /[\r\n]/u.test(v))) throw new TrustError("fields_invalid", `The value for ${f.name} was not accepted.`);
    out[f.name] = v;
  }
  if (target.format === "raw") return Buffer.from(out[target.fields[0]!.name]!, "utf8");
  if (target.format === "json") return Buffer.from(`${JSON.stringify(out, null, 2)}\n`, "utf8");
  return Buffer.from(Object.entries(out).map(([k, v]) => `${k}=${v}\n`).join(""), "utf8");
}

/** The destination exactly as the owner signs it; anything outside these shapes is refused (no shell syntax can ride in a path or name). */
export function parseSecretDropTarget(value: unknown): SecretDropTarget {
  const bad = (reason: string): never => { throw new Error(`The destination is not allowed: ${reason}.`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("it is not an object");
  const t = value as Record<string, unknown>;
  if (t.kind === "vault_unlock") return Object.keys(t).length === 1 ? { kind: "vault_unlock" } : bad("unknown property");
  if (t.kind === "vault_item" && t.origin === undefined) {
    // A secure note, exactly as the relay builds it: name, the field list (same rules as a file's fields) and format json, nothing more.
    if (Object.keys(t).length !== 4 || t.format !== "json" || typeof t.name !== "string" || t.name !== t.name.trim() || t.name.length < 1 || t.name.length > 100 || /[\r\n]/u.test(t.name)) return bad("not a valid vault_item");
    const { fields } = parseFields({ fields: t.fields });
    if (jcs(fields) !== jcs(t.fields)) return bad("not a valid vault_item");
    return { kind: "vault_item", name: t.name, fields: fields!, format: "json" };
  }
  if (t.kind === "vault_item") {
    // Exactly the form the relay builds: any other field list, format or extra key is refused, so what the owner typed into is what is saved.
    if (Object.keys(t).length !== 5 || typeof t.origin !== "string" || typeof t.name !== "string") return bad("not a valid vault_item");
    let origin: string;
    try { const url = new URL(t.origin); origin = url.protocol === "https:" && !url.username && !url.password ? url.origin : ""; } catch { origin = ""; }
    if (origin !== t.origin || t.name !== t.name.trim() || t.name.length < 1 || t.name.length > 100 || /[\r\n]/u.test(t.name)) return bad("not a valid vault_item");
    if (t.format !== "json" || jcs(t.fields) !== jcs(VAULT_ITEM_FIELDS)) return bad("not a valid vault_item");
    return { kind: "vault_item", origin, name: t.name, fields: VAULT_ITEM_FIELDS.map((f) => ({ ...f })), format: "json" };
  }
  if (t.kind !== "file" && t.kind !== "ssh_file") return bad("kind must be file, ssh_file, vault_unlock or vault_item");
  if (typeof t.path !== "string" || !PATH.test(t.path) || !isAbsolute(t.path) || t.path.endsWith("/") || t.path.slice(1).split("/").some((part) => part === "." || part === ".." || part === "")) return bad("path must be an absolute file path without dot segments");
  if (typeof t.owner !== "string" || !ACCOUNT.test(t.owner) || typeof t.group !== "string" || !ACCOUNT.test(t.group)) return bad("owner and group must be plain account names");
  if (typeof t.mode !== "string" || !MODE.test(t.mode) || (Number.parseInt(t.mode, 8) & 0o022) !== 0) return bad("mode must be octal and not writable by group or others");
  if (t.kind === "ssh_file" && (typeof t.host !== "string" || !HOST.test(t.host))) return bad("host must be an ssh alias");
  if (t.kind === "file" && t.host !== undefined) return bad("a local file has no host");
  if (Object.keys(t).some((key) => !["kind", "path", "owner", "group", "mode", "host", "fields", "format"].includes(key))) return bad("unknown property");
  return { kind: t.kind, path: t.path, owner: t.owner, group: t.group, mode: t.mode, ...(t.kind === "ssh_file" ? { host: t.host as string } : {}), ...parseFields(t) };
}

/** What the owner's passkey signature covers besides the drop itself: destination, this device's one-use key and the exact ciphertext. */
export function secretDropBinding(input: { dropId: string; target: SecretDropTarget; epk: string; ciphertext: string }): string {
  return createHash("sha256").update(jcs({ drop: input.dropId, target: input.target, epk: input.epk, ct: input.ciphertext })).digest("base64url");
}

interface PendingKey { privateKey: KeyObject; epk: string; exp: number }
const pending = new Map<string, PendingKey>();
const wipeExpired = (now: number): void => { for (const [id, key] of pending) if (key.exp <= now) pending.delete(id); };

/** Makes the one-use key for one drop. The private half is memory-only: a restart of this process cancels the drop. */
export function prepareSecretDrop(args: Record<string, unknown>, now = Date.now(), status: () => { status: string } = vaultStatus): { dropId: string; epk: string; expiresAt: string } {
  const dropId = args.dropId;
  if (typeof dropId !== "string" || !DROP_ID.test(dropId)) throw new Error("dropId is invalid.");
  // A vault item can only be saved into an unlocked vault; the owner's one-use key is spent at apply, so a locked vault must be found out before they type anything.
  if (args.kind === "vault_item" && status().status !== "unlocked") throw new Error(LOCKED_HINT);
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
export function writerCommand(target: SecretDropFileTarget, self = userInfo().username, root = process.getuid?.() === 0): { command: string; args: string[] } {
  const params = [target.path, target.owner, target.group, target.mode];
  if (target.kind === "ssh_file") {
    return { command: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "--", target.host!, ["sudo", "-n", "sh", "-c", shQuote(WRITE_SCRIPT), "sh", ...params.map(shQuote)].join(" ")] };
  }
  const plain = root || target.owner === self;
  return plain ? { command: "sh", args: ["-c", WRITE_SCRIPT, "sh", ...params] } : { command: "sudo", args: ["-n", "sh", "-c", WRITE_SCRIPT, "sh", ...params] };
}

export interface SecretDropDeps { run?: SecretDropRunner; now?: () => number; refreshTrust?: TrustRefresh; unlockVault?: (secret: Buffer) => Promise<{ locksAt: string }>; saveLogin?: (origin: string, login: NewLogin) => Promise<SaveLoginResult>; upsertNote?: (name: string, fields: readonly NoteField[]) => Promise<UpsertNoteResult> }

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
  const decrypted = decrypt(ciphertext, key, dropId);
  if (target.kind === "vault_unlock") {
    // Not a file: the value is the vault's master password. It goes to bw once and is zeroed here; the receipt carries only the lock time.
    try {
      const { locksAt } = await (deps.unlockVault ?? unlockVault)(decrypted);
      return { status: "unlocked", locksAt };
    } catch (error) {
      throw new Error(scrub(error instanceof Error ? error.message : "The vault could not be unlocked.", decrypted));
    } finally { decrypted.fill(0); }
  }
  if (target.kind === "vault_item" && target.origin === undefined) {
    // A secure note: the checked values become its custom fields (password fields hidden). The receipt names the fields, never their values.
    let rendered: Buffer | null = null;
    let values: Record<string, string> = {};
    try {
      rendered = renderSecretFields(target, decrypted);
      values = JSON.parse(rendered.toString("utf8")) as Record<string, string>;
      const fields = target.fields.map((f) => ({ name: f.name, value: values[f.name] ?? "", hidden: f.type === "password" }));
      const saved = await (deps.upsertNote ?? upsertNote)(target.name, fields);
      return { status: saved.status, name: target.name, fields: target.fields.map((f) => f.name) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "The note could not be saved.";
      throw new Error(error instanceof TrustError ? message : Object.values(values).reduce<string>((text, value) => value ? text.split(value).join("[hidden]") : text, message).slice(0, 500));
    } finally { decrypted.fill(0); rendered?.fill(0); }
  }
  if (target.kind === "vault_item") {
    // Not a file either: the field values are checked against the signed list, then handed to `bw create item`. The receipt never carries them.
    let rendered: Buffer | null = null;
    let values: { username: string; password: string; totp: string } | null = null;
    try {
      rendered = renderSecretFields(target, decrypted);
      values = JSON.parse(rendered.toString("utf8")) as { username: string; password: string; totp: string };
      const login: NewLogin = { name: target.name, username: values.username, password: values.password, ...(values.totp ? { totp: values.totp } : {}) };
      const saved = await (deps.saveLogin ?? saveLogin)(target.origin!, login);
      return saved.status === "saved" ? { status: "saved", site: target.origin, name: target.name, hasTotp: saved.hasTotp } : { status: "exists", site: target.origin };
    } catch (error) {
      // Each typed value is hidden on its own: an error that quotes only the password must not leak it because the whole JSON was not quoted.
      const message = error instanceof Error ? error.message : "The login could not be saved.";
      throw new Error(error instanceof TrustError ? message : [values?.password, values?.username, values?.totp].reduce<string>((text, value) => value ? text.split(value).join("[hidden]") : text, message).slice(0, 500));
    } finally { decrypted.fill(0); rendered?.fill(0); }
  }
  let secret: Buffer;
  try { secret = renderSecretFields(target, decrypted); } catch (error) { decrypted.fill(0); throw error; }
  if (secret !== decrypted) decrypted.fill(0);
  try {
    const { command, args: argv } = writerCommand(target);
    const result = await (deps.run ?? defaultRunner)(command, argv, secret);
    if (result.code !== 0) throw new Error(`The write failed on ${target.kind === "ssh_file" ? target.host : "this computer"} (exit ${result.code ?? "none"}): ${scrub(result.stderr.trim() || "no error text", secret)}`);
    return { status: "written", target: { kind: target.kind, ...(target.host ? { host: target.host } : {}), path: target.path }, bytes: secret.length, owner: target.owner, group: target.group, mode: target.mode, replaced: /replaced=1/u.test(result.stdout) };
  } finally { secret.fill(0); }
}

/** Test hook: forget every open drop key. */
export function forgetSecretDropKeys(): void { pending.clear(); }
