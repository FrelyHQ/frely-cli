import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, normalize, parse, sep } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { cliLaunchArguments } from "../cli-launch.js";

/**
 * OS-level sandboxing for `run_command` / `start_process`.
 *
 * `run_command` and `start_process` run arbitrary shell commands as the
 * current OS user; unlike every other tool in this MCP runtime, they are not
 * confined to the workspace. This module wraps the command through
 * `@anthropic-ai/sandbox-runtime` (srt) so that, wherever the host platform
 * supports it, the process tree it spawns:
 *   - can only write inside the workspace root and the system temp directory
 *     (matching the containment every other tool in this runtime already has)
 *   - cannot read common credential stores (SSH keys, cloud CLI configs,
 *     package manager tokens, git credentials)
 *   - has its outbound connections checked against loopback / link-local /
 *     cloud-metadata addresses, closing a common SSRF-style exfiltration path,
 *     even though outbound domains are otherwise left open by default
 *
 * This is a best-effort layer, not a hard security boundary on every
 * platform: srt requires `bubblewrap` + `socat` on Linux and `ripgrep` on
 * macOS/Linux, and its own README describes it as a beta research preview.
 * By default, when the platform is unsupported or a dependency is missing,
 * we log a one-time warning to stderr and run the command unsandboxed rather
 * than break existing installs. Set `FRELY_SANDBOX_STRICT=1` to instead
 * refuse to run a command that cannot be sandboxed.
 *
 * Set `FRELY_SANDBOX=off` to disable this layer entirely (no attempt, no
 * warning) -- for environments that already provide their own containment,
 * or while diagnosing whether the sandbox itself is the cause of a failure.
 */

/**
 * Credential stores a remote client may be allowed to read after the owner approves it on the web
 * (relay `request_permission`). The group names are the relay's catalog; the paths stay on the device.
 */
export const SENSITIVE_PATH_GROUPS: Readonly<Record<string, readonly string[]>> = {
  ssh: ["~/.ssh"],
  aws: ["~/.aws"],
  gcloud: ["~/.config/gcloud", "~/Library/Application Support/gcloud"],
  kube: ["~/.kube"],
  gh: ["~/.config/gh"],
  gnupg: ["~/.gnupg"],
  "git-credentials": ["~/.git-credentials", "~/.netrc"],
  "npm-tokens": ["~/.npmrc", "~/.pypirc", "~/.cargo/credentials.toml"],
};

/**
 * Saved Admin API sessions and the Owner email profile (friday-relay scripts). Unlike the cache groups this is also unreadable until
 * the owner approves `friday-admin`, which opens it for reading and writing: the saved session works as a login for its lifetime.
 */
const ADMIN_SESSION_PATHS: readonly string[] = ["~/.config/friday-relay"];

/**
 * Build-tool cache directories a remote client may be allowed to write after the owner approves them on the web.
 * Caches only: nothing here holds credentials or start-up scripts.
 */
export const WRITABLE_PATH_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "pub-cache": ["~/.pub-cache"],
  gradle: ["~/.gradle"],
  "npm-cache": ["~/.npm"],
  "bun-cache": ["~/.bun"],
  "cargo-cache": ["~/.cargo/registry", "~/.cargo/git"],
  cocoapods: ["~/.cocoapods", "~/Library/Caches/CocoaPods"],
  "user-cache": ["~/.cache", "~/Library/Caches"],
  "friday-admin": [...ADMIN_SESSION_PATHS],
};

/**
 * Grant name for a command that must make raw outbound connections (ssh to a host, database clients, nc). The command then runs
 * without the sandbox at all, because the sandbox can only route HTTP(S) and SOCKS traffic. Opened only by the owner, for a limited time.
 */
export const UNSANDBOXED_GROUP = "unsandboxed";

/** Owner-chosen writable directory, sent as `path:<absolute or ~/ path>`. */
const CUSTOM_PATH_PREFIX = "path:";

/**
 * Protected paths: credential stores, shell start-up files and launch agents (the latter would let a command outlive the call).
 * They are always denied for writing, even inside a granted parent such as `path:~/`. Only a grant naming one of them exactly
 * (`path:~/.ssh`) lifts the denial for that path; a parent or a sub-path does not.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "~/.ssh", "~/.gnupg", "~/.aws", "~/.kube", "~/.docker", "~/.config/gcloud", "~/.config/gh",
  "~/.zshrc", "~/.zshenv", "~/.zprofile", "~/.zlogin", "~/.bashrc", "~/.bash_profile", "~/.bash_login", "~/.profile", "~/.config/fish",
  "~/Library/LaunchAgents", "/Library/LaunchAgents", "/Library/LaunchDaemons", "~/.git-credentials", "~/.netrc", "~/.npmrc", "~/.pypirc",
  "~/.cargo/credentials.toml", "~/Library/Application Support/gcloud",
];
/** Frely's own device credentials: never writable by a grant, not even an exact one. */
const NEVER_WRITABLE_PATHS: readonly string[] = ["~/.config/frely"];
/** Longest path after `path:`. Keep equal to the relay's `PATH_GRANT_CUSTOM_PATH_MAX` (device-relay path-grants.ts) so both ends accept the same paths. */
const CUSTOM_PATH_MAX = 150;

const expandHome = (path: string): string => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const expanded = (path: string): string => normalize(expandHome(path));
const within = (path: string, base: string): boolean => path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);

/** The expanded path of a `path:` grant name, or undefined when it is not allowed. */
export function customWritePath(name: string): string | undefined {
  if (!name.startsWith(CUSTOM_PATH_PREFIX) || name.includes("\0")) return undefined;
  const raw = name.slice(CUSTOM_PATH_PREFIX.length);
  if (raw.length > CUSTOM_PATH_MAX || !(raw.startsWith("~/") || isAbsolute(raw)) || raw.split("/").includes("..")) return undefined;
  const normalized = expanded(raw);
  const { root } = parse(normalized);
  const isRoot = normalized === root;
  const path = isRoot ? root : normalized.replace(/[\\/]+$/u, "");
  // Any absolute directory, but never the filesystem root or the system drive root. The root of another Windows drive (`D:\`) is allowed.
  if (path === "") return undefined;
  if (isRoot && (!/^[A-Za-z]:[\\/]$/u.test(root) || root.toLowerCase() === `${process.env.SystemDrive ?? "C:"}\\`.toLowerCase())) return undefined;
  if (NEVER_WRITABLE_PATHS.some((never) => within(path, expanded(never)))) return undefined;
  // Inside a protected path only that path itself can be named; the grant must spell it out in full.
  if (PROTECTED_PATHS.some((protectedPath) => path !== expanded(protectedPath) && within(path, expanded(protectedPath)))) return undefined;
  return path;
}

/** Paths a sandboxed command may never write: every protected path except those named exactly by an approved grant, plus Frely's own credentials. */
export function protectedWriteDenials(allowedGroups: readonly string[]): string[] {
  const granted = new Set(allowedGroups.flatMap((name) => customWritePath(name) ?? []));
  const adminOpen = allowedGroups.includes("friday-admin");
  return [...PROTECTED_PATHS.filter((protectedPath) => !granted.has(expanded(protectedPath))), ...(adminOpen ? [] : ADMIN_SESSION_PATHS), ...NEVER_WRITABLE_PATHS];
}

/** Whether `name` is a grant name this CLI understands. */
export function isKnownGrantName(name: string): boolean {
  return Object.hasOwn(SENSITIVE_PATH_GROUPS, name) || Object.hasOwn(WRITABLE_PATH_GROUPS, name) || name === UNSANDBOXED_GROUP || customWritePath(name) !== undefined;
}

/** Never openable by a grant. Frely's own device credentials and local MCP list (which can hold headers and env values): a remote client running commands must not read them back. */
const ALWAYS_DENIED_READ_PATHS = ["~/.docker/config.json", "~/.config/frely"];

/** Request `_meta` key the relay sets on a tools/call with the approved group names; the relay overwrites anything a client sent. */
export const PATH_GRANTS_META_KEY = "frely/pathGrants";

/** Approved grant names from a tools/call `_meta`: credential groups to read, cache groups or `path:` directories to write, or `unsandboxed`. Unknown names are dropped. */
export function pathGrantsFromMeta(meta: unknown): string[] {
  const value = meta && typeof meta === "object" ? (meta as Record<string, unknown>)[PATH_GRANTS_META_KEY] : undefined;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && isKnownGrantName(name)))];
}

export function sensitiveReadPaths(allowedGroups: readonly string[] = []): string[] {
  const allowed = new Set(allowedGroups);
  return [
    ...Object.entries(SENSITIVE_PATH_GROUPS).filter(([name]) => !allowed.has(name)).flatMap(([, paths]) => paths),
    ...(allowed.has("friday-admin") ? [] : ADMIN_SESSION_PATHS),
    ...ALWAYS_DENIED_READ_PATHS,
  ];
}

let initialized: Promise<boolean> | undefined;
let warned = false;

export function isSandboxDisabled(): boolean {
  const value = (process.env.FRELY_SANDBOX ?? "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

export function isSandboxStrict(): boolean {
  const value = (process.env.FRELY_SANDBOX_STRICT ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

/** Best-effort report of the sandbox backend for device capability frames (plan §4.3). */
export function detectSandboxBackend(): "srt" | "off" | "none" {
  if (isSandboxDisabled()) return "off";
  try {
    if (!SandboxManager.isSupportedPlatform()) return "none";
    return SandboxManager.checkDependencies().errors.length > 0 ? "none" : "srt";
  } catch {
    return "none";
  }
}

/** Extra directories commands may write under, from the approved cache groups and custom `path:` grants. */
export function writablePaths(allowedGroups: readonly string[]): string[] {
  return allowedGroups.flatMap((name) => Object.hasOwn(WRITABLE_PATH_GROUPS, name) ? [...WRITABLE_PATH_GROUPS[name]!] : customWritePath(name) ?? []);
}

/**
 * Defines ssh, scp and sftp in front of a command so they reach the network through the sandbox's SOCKS or HTTP proxy.
 * srt already exports that wiring as GIT_SSH_COMMAND for git; plain ssh makes a direct connection, which the sandbox refuses.
 * Covers the command text itself; a script that starts ssh on its own should use `$GIT_SSH_COMMAND`.
 */
export const SSH_PROXY_PREFIX = [
  'if [ -n "$GIT_SSH_COMMAND" ]; then __frely_ssh_opts=${GIT_SSH_COMMAND#ssh };',
  ...["ssh", "scp", "sftp"].map((tool) => `${tool}() { eval "command ${tool} $__frely_ssh_opts \\"\\$@\\""; };`),
  "fi\n",
].join(" ");

/** Single-quotes a word for sh unless it is made of characters that never need quoting. */
const shellQuote = (value: string): string => /^[\w./:@%+=,-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;

/**
 * On macOS srt points GIT_SSH_COMMAND at `nc -X 5` (SOCKS5), which cannot send the sandbox proxy's credentials, so git over ssh fails
 * whenever the proxy requires authentication. When HTTP_PROXY carries credentials, this swaps in `frely ssh-proxy`, an HTTP CONNECT
 * relay that reads them from the environment. Other platforms keep srt's own setting (Linux uses socat with proxyauth).
 */
export function sshProxyPrefix(platform: string = process.platform, helper: readonly string[] = cliLaunchArguments(helperEntry(), ["ssh-proxy"])): string {
  if (platform !== "darwin") return SSH_PROXY_PREFIX;
  const proxyCommand = `${helper.map(shellQuote).join(" ")} %h %p`;
  const gitSshCommand = `ssh -o ControlMaster=no -o ControlPath=none -o ${shellQuote(`ProxyCommand=${proxyCommand}`)}`;
  return `case "$HTTP_PROXY" in *@*) if [ -n "$GIT_SSH_COMMAND" ]; then GIT_SSH_COMMAND=${shellQuote(gitSshCommand)}; export GIT_SSH_COMMAND; fi;; esac\n${SSH_PROXY_PREFIX}`;
}

function helperEntry(): string {
  try { return realpathSync(process.argv[1] ?? ""); } catch { return process.argv[1] ?? ""; }
}

export function buildSandboxConfig(workspaceRoot: string, allowedGroups: readonly string[] = []): SandboxRuntimeConfig {
  return {
    network: {
      // Left open by default: an empty allowlist would break ordinary
      // developer workflows (npm/pip/git/curl) for most existing users.
      // The resolved-address checks srt performs regardless of this list
      // (loopback, link-local, cloud metadata, this host's own interfaces)
      // still apply, so this is not a no-op.
      allowedDomains: ["*"],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: sensitiveReadPaths(allowedGroups),
      allowWrite: [workspaceRoot, tmpdir(), ...writablePaths(allowedGroups)],
      denyWrite: protectedWriteDenials(allowedGroups),
    },
  };
}

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`frely-cli: ${message}\n`);
}

async function ensureInitialized(workspaceRoot: string): Promise<boolean> {
  initialized ??= (async () => {
    if (!SandboxManager.isSupportedPlatform()) {
      warnOnce("sandboxing is not supported on this platform; run_command and start_process are running unsandboxed. Set FRELY_SANDBOX_STRICT=1 to refuse instead.");
      return false;
    }
    const dependencies = SandboxManager.checkDependencies();
    if (dependencies.errors.length > 0) {
      warnOnce(`sandboxing dependencies are missing (${dependencies.errors.join("; ")}); run_command and start_process are running unsandboxed. Set FRELY_SANDBOX_STRICT=1 to refuse instead.`);
      return false;
    }
    for (const warning of dependencies.warnings) warnOnce(warning);
    try {
      await SandboxManager.initialize(buildSandboxConfig(workspaceRoot));
      return true;
    } catch (error) {
      warnOnce(`sandbox initialization failed (${error instanceof Error ? error.message : String(error)}); run_command and start_process are running unsandboxed. Set FRELY_SANDBOX_STRICT=1 to refuse instead.`);
      return false;
    }
  })();
  return initialized;
}

/**
 * Wrap a shell command with sandbox restrictions before it is spawned with
 * `shell: true`. Returns the original command unchanged when sandboxing is
 * disabled, unsupported, or a per-call wrap fails and strict mode is off.
 * In strict mode (`FRELY_SANDBOX_STRICT=1`), any of those failures throws
 * instead of silently running the command unsandboxed.
 */
export async function sandboxCommand(command: string, workspaceRoot: string, allowedGroups: readonly string[] = []): Promise<string> {
  if (isSandboxDisabled()) return command;
  // The owner opened raw outbound connections for this call, which the sandbox cannot offer without losing its other limits.
  if (allowedGroups.includes(UNSANDBOXED_GROUP)) return command;
  const ready = await ensureInitialized(workspaceRoot);
  if (!ready) {
    if (isSandboxStrict()) throw new Error("Sandboxing is unavailable on this host and FRELY_SANDBOX_STRICT is set; refusing to run an unsandboxed command.");
    return command;
  }
  try {
    // initialize() fixed allowWrite to the first workspace that ran a command; give every call its own workspace.
    return await SandboxManager.wrapWithSandbox(sshProxyPrefix() + command, undefined, { filesystem: buildSandboxConfig(workspaceRoot, allowedGroups).filesystem });
  } catch (error) {
    if (isSandboxStrict()) throw error instanceof Error ? error : new Error(String(error));
    warnOnce(`failed to sandbox a command (${error instanceof Error ? error.message : String(error)}); it ran unsandboxed this time. Set FRELY_SANDBOX_STRICT=1 to refuse instead.`);
    return command;
  }
}

/**
 * Hint for a failed sandboxed command whose stderr looks like a sandbox denial, so the caller asks the owner for approval
 * (request_permission) instead of giving up on a bare "Operation not permitted".
 */
export function sandboxDenialHint(stderr: string): string | undefined {
  if (!/operation not permitted|permission denied|read-only file system|sandbox/iu.test(stderr)) return undefined;
  return "This command may have been blocked by the Frely command sandbox (writes only to the workspace and temp directory; credential folders unreadable; only HTTP(S) and ssh reach the network). "
    + "Call request_permission with the reason and the exact command (a credential group, cache directories, a specific path, or unsandboxed); the owner approves it on the web with a passkey or authenticator code. Then run the same command again.";
}

/** Exposed for tests: resets the module-level init state and the underlying manager. */
export async function resetSandboxForTests(): Promise<void> {
  initialized = undefined;
  warned = false;
  await SandboxManager.reset().catch(() => undefined);
}
