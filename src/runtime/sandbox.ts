import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, sep } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { cliLaunchArguments } from "../cli-launch.js";
import { gitConfigGuardAvailable } from "./git-config-guard.js";
import { resolveUpstreamProxy, type UpstreamProxy } from "./sandbox-proxy.js";

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
 * srt requires `bubblewrap` + `socat` on Linux and `ripgrep` on macOS/Linux,
 * and its own README describes it as a beta research preview. The sandbox
 * fails closed: when the platform is unsupported (for example Windows), a
 * dependency is missing, initialization fails, or wrapping a command fails,
 * the command is refused with an error that says why and how to proceed. It
 * is never silently run unsandboxed. The only ways to run without the sandbox
 * are the two deliberate opt-outs: the device owner sets `FRELY_SANDBOX=off`,
 * or the owner approves the `unsandboxed` grant on the web (request_permission).
 * `FRELY_SANDBOX_STRICT` is still accepted but has no effect: strict is always on.
 *
 * `FRELY_SANDBOX=off` disables this layer entirely (no attempt, no
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
const neverWritablePaths = (): string[] => ["~/.config/frely", ...(process.env.FRELY_DATA_DIR ? [process.env.FRELY_DATA_DIR] : [])];
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
  if (neverWritablePaths().some((never) => within(path, expanded(never)))) return undefined;
  // Inside a protected path only that path itself can be named; the grant must spell it out in full.
  if (PROTECTED_PATHS.some((protectedPath) => path !== expanded(protectedPath) && within(path, expanded(protectedPath)))) return undefined;
  return path;
}

/** Paths a sandboxed command may never write: every protected path except those named exactly by an approved grant, plus Frely's own credentials. */
export function protectedWriteDenials(allowedGroups: readonly string[]): string[] {
  const granted = new Set(allowedGroups.flatMap((name) => customWritePath(name) ?? []));
  const adminOpen = allowedGroups.includes("friday-admin");
  return [...PROTECTED_PATHS.filter((protectedPath) => !granted.has(expanded(protectedPath))), ...(adminOpen ? [] : ADMIN_SESSION_PATHS), ...neverWritablePaths()];
}

/** Whether `name` is a grant name this CLI understands. */
export function isKnownGrantName(name: string): boolean {
  return Object.hasOwn(SENSITIVE_PATH_GROUPS, name) || Object.hasOwn(WRITABLE_PATH_GROUPS, name) || name === UNSANDBOXED_GROUP || customWritePath(name) !== undefined;
}

/** Never openable by a grant. Frely's own device credentials and local MCP list (which can hold headers and env values): a remote client running commands must not read them back. */
const alwaysDeniedReadPaths = (): string[] => ["~/.docker/config.json", "~/.config/frely", ...(process.env.FRELY_DATA_DIR ? [process.env.FRELY_DATA_DIR] : [])];

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
    ...alwaysDeniedReadPaths(),
  ];
}

let warned = false;

export function isSandboxDisabled(): boolean {
  const value = (process.env.FRELY_SANDBOX ?? "").trim().toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

/** Kept for compatibility: the sandbox now always fails closed, so FRELY_SANDBOX_STRICT no longer changes anything. */
export function isSandboxStrict(): boolean {
  return true;
}

/**
 * Best-effort report of the sandbox backend for device capability frames (plan §4.3).
 * "unavailable" means commands are refused here (fail closed); older CLIs reported "none" and ran them unprotected.
 */
export function detectSandboxBackend(): "srt" | "off" | "unavailable" {
  if (isSandboxDisabled()) return "off";
  try {
    if (!SandboxManager.isSupportedPlatform()) return "unavailable";
    return SandboxManager.checkDependencies().errors.length > 0 ? "unavailable" : "srt";
  } catch {
    return "unavailable";
  }
}

/** Why commands are refused here, or undefined when the sandbox can run (or is turned off). Same checks as detectSandboxBackend. */
export function sandboxUnavailableReason(): string | undefined {
  if (isSandboxDisabled()) return undefined;
  try {
    if (!SandboxManager.isSupportedPlatform()) return `unsupported platform ${process.platform}`;
    const { errors } = SandboxManager.checkDependencies();
    return errors.length > 0 ? `missing dependencies: ${errors.join("; ")}` : undefined;
  } catch (error) {
    return `sandbox check failed: ${errorText(error)}`;
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

/** A directory `path` inside the workspace, or false when it is missing or only a link (a worktree's `.git` file). */
const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * `.git` paths of the workspace root that srt does not (or no longer) protect on its own. srt derives its `.git/hooks` and `.git/config`
 * denials from the CLI process's current directory, not from the workspace a command runs in, so they are named here as well.
 * `.git/hooks` is always denied (hooks run programs outside the sandbox). `.git/config` is denied unless the command may change it
 * (run_command with the guard in git-config-guard.ts).
 */
function gitWriteDenials(workspaceRoot: string, allowGitConfig: boolean): string[] {
  const dotGit = join(workspaceRoot, ".git");
  if (!isDirectory(dotGit)) return [];
  return [...(isDirectory(join(dotGit, "hooks")) ? [join(dotGit, "hooks")] : []), ...(allowGitConfig ? [] : [join(dotGit, "config")])];
}

export interface SandboxConfigOptions {
  /** run_command only: the command may write the workspace `.git/config`; the caller then runs the guard in git-config-guard.ts. */
  allowGitConfig?: boolean;
  /** The user's own proxy that srt forwards to. Read once when the sandbox starts. */
  parentProxy?: UpstreamProxy | undefined;
}

export function buildSandboxConfig(workspaceRoot: string, allowedGroups: readonly string[] = [], options: SandboxConfigOptions = {}): SandboxRuntimeConfig {
  const allowGitConfig = options.allowGitConfig === true;
  return {
    network: {
      // Left open by default: an empty allowlist would break ordinary
      // developer workflows (npm/pip/git/curl) for most existing users.
      // The resolved-address checks srt performs regardless of this list
      // (loopback, link-local, cloud metadata, this host's own interfaces)
      // still apply, so this is not a no-op.
      allowedDomains: ["*"],
      deniedDomains: [],
      // Local dev servers and tests need to listen on and reach loopback ports. srt reads this only when it initializes, so it cannot vary per call.
      allowLocalBinding: true,
      ...(options.parentProxy ? { parentProxy: options.parentProxy } : {}),
    },
    filesystem: {
      denyRead: sensitiveReadPaths(allowedGroups),
      allowWrite: [workspaceRoot, tmpdir(), ...writablePaths(allowedGroups)],
      denyWrite: [...protectedWriteDenials(allowedGroups), ...gitWriteDenials(workspaceRoot, allowGitConfig)],
      ...(allowGitConfig ? { allowGitConfig: true } : {}),
    },
  };
}

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`frely-cli: ${message}\n`);
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Plain-words refusal shown to the caller when the sandbox cannot run on this device. */
export function sandboxUnavailableMessage(reason: string): string {
  return `The command was not run: the command sandbox cannot run on this device (${reason}), and commands are only run inside the sandbox. `
    + "To proceed, install the missing sandbox dependencies (on Linux: bubblewrap, socat and ripgrep; Windows is not supported), "
    + 'or the device owner can turn the sandbox off for this connection (call request_permission with resource "unsandboxed", approved on the web) '
    + "or set FRELY_SANDBOX=off on the device.";
}

type Init = { ready: true } | { ready: false; reason: string };
let initialized: Promise<Init> | undefined;
/** The configuration srt was initialized with: what every command runs under, and what is put back after a git-config wrap. */
let baseConfig: SandboxRuntimeConfig | undefined;

async function ensureInitialized(workspaceRoot: string): Promise<Init> {
  initialized ??= (async (): Promise<Init> => {
    if (!SandboxManager.isSupportedPlatform()) {
      const reason = `unsupported platform ${process.platform}`;
      warnOnce(`sandboxing is not supported on this platform; run_command and start_process are refused. ${reason}.`);
      return { ready: false, reason };
    }
    const dependencies = SandboxManager.checkDependencies();
    if (dependencies.errors.length > 0) {
      const reason = `missing dependencies: ${dependencies.errors.join("; ")}`;
      warnOnce(`sandboxing dependencies are missing (${dependencies.errors.join("; ")}); run_command and start_process are refused.`);
      return { ready: false, reason };
    }
    for (const warning of dependencies.warnings) warnOnce(warning);
    try {
      // The proxy servers keep the upstream proxy they start with, so a changed proxy needs a restart of the service.
      baseConfig = buildSandboxConfig(workspaceRoot, [], { parentProxy: resolveUpstreamProxy() });
      await SandboxManager.initialize(structuredClone(baseConfig));
      return { ready: true };
    } catch (error) {
      const reason = `sandbox initialization failed: ${errorText(error)}`;
      warnOnce(`${reason}; run_command and start_process are refused.`);
      return { ready: false, reason };
    }
  })();
  return initialized;
}

/** What the sandbox needs to wrap one command: the parts of srt that `wrapSerialized` uses, so tests can stand in for it. */
export interface WrapManager {
  updateConfig(config: SandboxRuntimeConfig): void;
  wrapWithSandbox(command: string, binShell?: string, customConfig?: Partial<SandboxRuntimeConfig>, abortSignal?: AbortSignal, options?: { commandId?: string; commandText?: string }): Promise<string>;
}

let wrapQueue: Promise<unknown> = Promise.resolve();

/**
 * Wrap one command. Every wrap goes through this queue, one at a time, because a command that may change `.git/config` needs srt's
 * global `filesystem.allowGitConfig` switched on while it is wrapped. srt bakes that switch into the command's own sandbox profile
 * (the macOS seatbelt profile string, the Linux bubblewrap arguments) inside `wrapWithSandbox`, and reads it nowhere afterwards, so
 * switching it back right after the wrap leaves that command's sandbox as it was made and later commands without it. Only the wrap
 * (milliseconds) is queued; the commands themselves run concurrently.
 */
export function wrapSerialized(manager: WrapManager, base: SandboxRuntimeConfig, wrap: () => Promise<string>, allowGitConfig: boolean): Promise<string> {
  const task = async (): Promise<string> => {
    if (!allowGitConfig) return wrap();
    manager.updateConfig({ ...base, filesystem: { ...base.filesystem, allowGitConfig: true } as SandboxRuntimeConfig["filesystem"] });
    try {
      return await wrap();
    } finally {
      manager.updateConfig(base);
    }
  };
  const run = wrapQueue.then(task, task);
  wrapQueue = run.catch(() => undefined);
  return run;
}

export interface SandboxedCommand {
  /** The command to spawn with `shell: true`. */
  command: string;
  /** The key under which srt records this command's violations; undefined when the command is not sandboxed. */
  commandId?: string;
  /** The command may change `.git/config`: snapshot it before the spawn and run the guard after the exit. */
  gitConfig: boolean;
}

export interface SandboxCommandOptions {
  /** run_command only: allow writing the workspace `.git/config` (the caller must run the guard). start_process never sets this. */
  allowGitConfig?: boolean;
}

/**
 * Wrap a shell command with sandbox restrictions before it is spawned with
 * `shell: true`. Fails closed: when the sandbox cannot run (unsupported
 * platform, missing dependencies, failed initialization or a failed per-call
 * wrap) this throws instead of running the command unsandboxed. The command
 * is returned unchanged only when the owner turned the sandbox off
 * (`FRELY_SANDBOX=off`) or approved the `unsandboxed` grant for this call.
 */
export async function sandboxCommandDetailed(command: string, workspaceRoot: string, allowedGroups: readonly string[] = [], options: SandboxCommandOptions = {}): Promise<SandboxedCommand> {
  if (isSandboxDisabled()) return { command, gitConfig: false };
  // The owner opened raw outbound connections for this call, which the sandbox cannot offer without losing its other limits.
  if (allowedGroups.includes(UNSANDBOXED_GROUP)) return { command, gitConfig: false };
  const denied = deniedReadReference(command, allowedGroups);
  if (denied) throw new Error(deniedReadMessage(denied));
  const init = await ensureInitialized(workspaceRoot);
  if (!init.ready || !baseConfig) throw new Error(sandboxUnavailableMessage(init.ready ? "sandbox configuration missing" : init.reason));
  // Without git the guard cannot check the file afterwards, so `.git/config` then stays read-only.
  const gitConfig = options.allowGitConfig === true && await gitConfigGuardAvailable();
  const commandId = randomUUID();
  // initialize() fixed allowWrite to the first workspace that ran a command; give every call its own workspace.
  const { allowGitConfig: _unused, ...filesystem } = buildSandboxConfig(workspaceRoot, allowedGroups, { allowGitConfig: gitConfig }).filesystem ?? {};
  try {
    const wrapped = await wrapSerialized(SandboxManager, baseConfig, () => SandboxManager.wrapWithSandbox(sshProxyPrefix() + command, undefined, { filesystem }, undefined, { commandId, commandText: command }), gitConfig);
    return { command: wrapped, commandId, gitConfig };
  } catch (error) {
    throw new Error(sandboxUnavailableMessage(`wrapping the command failed: ${errorText(error)}`));
  }
}

export async function sandboxCommand(command: string, workspaceRoot: string, allowedGroups: readonly string[] = []): Promise<string> {
  return (await sandboxCommandDetailed(command, workspaceRoot, allowedGroups)).command;
}

/** The violations srt recorded for one wrapped command (proxy denials always; file and socket denials where srt's log monitor runs). */
export function sandboxViolationLines(commandId: string | undefined): string[] {
  if (!commandId) return [];
  try {
    return SandboxManager.getSandboxViolationStore().getViolationsForCommand(commandId).map((violation) => violation.line);
  } catch {
    return [];
  }
}

/** The group whose unapproved credential path a command names, or `null` for a path no grant can open. */
type DeniedRead = { path: string; group: string | null };

/**
 * A credential path the command names in its text without an approved grant. The sandbox would only show such a folder as empty
 * (Linux) or fail with a bare "Operation not permitted" (macOS), and a remote client would read that as "the file does not exist".
 * Text matching only: a script that reads the path itself is still confined by the sandbox, just without this explanation.
 */
export function deniedReadReference(command: string, allowedGroups: readonly string[] = []): DeniedRead | undefined {
  const allowed = new Set(allowedGroups);
  const candidates: DeniedRead[] = [
    ...Object.entries(SENSITIVE_PATH_GROUPS).filter(([name]) => !allowed.has(name)).flatMap(([group, paths]) => paths.map((path) => ({ path, group }))),
    ...(allowed.has("friday-admin") ? [] : ADMIN_SESSION_PATHS.map((path) => ({ path, group: "friday-admin" }))),
    ...alwaysDeniedReadPaths().map((path) => ({ path, group: null })),
  ];
  return candidates.find(({ path }) => commandNamesPath(command, path));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whether `command` spells out `path` (a `~/` path) as `~/`, `$HOME/`, `${HOME}/` or the absolute home path, followed by a path boundary. */
function commandNamesPath(command: string, path: string): boolean {
  const rest = escapeRegExp(path.slice(2));
  const home = ["~", "\\$HOME", "\\$\\{HOME\\}", escapeRegExp(homedir())].join("|");
  return new RegExp(`(?:${home})/${rest}(?=$|[/\\s"'\`;&|)<>])`, "u").test(command);
}

function deniedReadMessage({ path, group }: DeniedRead): string {
  if (group === null) return `The command was not run: Frely's command sandbox never lets commands read ${path}, and no approval can open it.`;
  return `The command was not run: no permission to read ${path}. Frely's command sandbox hides credential folders until the device owner approves access. `
    + `Call request_permission with resource "${group}", the reason and this exact command; it returns a link where the owner approves it with a passkey or authenticator code. Then run the same command again.`;
}

/** What the caller knows about a failed command beyond its stderr: srt's recorded violations and the workspace it ran in. */
export interface DenialContext { violations?: readonly string[]; workspaceRoot?: string }

const DENIAL_TEXT = /operation not permitted|permission denied|read-only file system|sandbox/iu;
const DOCKER_SOCKET = /docker\.sock|cannot connect to the docker daemon|docker daemon socket/iu;
const RAW_TCP_CLIENT = /(?:^|[\s;&|(])(?:psql|pg_dump|pg_restore|mysql|mysqldump|mariadb|redis-cli|mongosh?|nc|ncat|netcat|telnet|sqlcmd|cqlsh|clickhouse-client)(?=\s|$)/u;
const CONNECTION_FAILURE = /connection refused|econnrefused|network is unreachable|no route to host|could not connect|can't connect|connection timed out|operation not permitted/iu;
const XPC_DENIAL = /mach-lookup|\bxpc\b|connection invalid|bootstrap_look_up/iu;
const SEATBELT_NETWORK_DENIAL = /deny(?:\(\d+\))? network-outbound/u;

/** `~/x` for paths below the home directory, the plain path otherwise. */
const shortPath = (path: string): string => path === homedir() ? "~" : path.startsWith(homedir() + sep) ? `~/${path.slice(homedir().length + 1)}` : path;

/** Absolute paths named on the lines of `text` that look like a refused operation. */
function deniedPaths(lines: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    if (!/operation not permitted|permission denied|read-only file system|deny(?:\(\d+\))? file-write/iu.test(line)) continue;
    for (const match of line.matchAll(/(?<![\w.~-])(\/[^\s'"`:;,)<>|]+)/gu)) found.push(match[1]!);
  }
  return [...new Set(found)];
}

/** The `path:` resource that would open the write `path` for a command, or undefined when no grant can. */
function writeGrantFor(path: string, workspaceRoot: string | undefined): string | undefined {
  const target = normalize(path);
  if (workspaceRoot && within(target, normalize(workspaceRoot))) return undefined;
  if (within(target, normalize(tmpdir())) || /^\/(?:dev|proc|sys)(?:\/|$)/u.test(target)) return undefined;
  // A protected path (a shell start-up file, a credential folder) can only be opened by naming it exactly.
  const protectedPath = PROTECTED_PATHS.map(expanded).find((item) => within(target, item));
  const dir = protectedPath ?? dirname(target);
  // Grant names always use forward slashes, whatever the platform separator is.
  const grant = `path:${shortPath(dir)}`.replace(/\\/gu, "/");
  return customWritePath(grant) === undefined ? undefined : grant;
}

/**
 * Hint for a failed sandboxed command whose output looks like a sandbox denial, so the caller asks for the narrowest approval
 * (request_permission) instead of giving up on a bare "Operation not permitted" or reaching for `unsandboxed`. It reads srt's
 * recorded violations, then stderr and the command text. Nothing is guessed beyond that: a denial it cannot place gets the generic hint.
 */
export function sandboxDenialHint(stderr: string, command?: string, exitCode?: number | null, sshConfigReadable?: boolean, context: DenialContext = {}): string | undefined {
  const ssh = command !== undefined ? sshHint(stderr, command, exitCode, sshConfigReadable) : undefined;
  if (ssh) return ssh;
  const violations = context.violations ?? [];
  const lines = [...stderr.split(/\r?\n/u), ...violations];
  const text = lines.join("\n");
  const rawTcp = command !== undefined && RAW_TCP_CLIENT.test(command) && CONNECTION_FAILURE.test(stderr) || violations.some((line) => SEATBELT_NETWORK_DENIAL.test(line));
  if (!(DENIAL_TEXT.test(text) || DOCKER_SOCKET.test(text) || XPC_DENIAL.test(text) || rawTcp || violations.length > 0)) return undefined;
  const UNSANDBOXED_ASK = `Call request_permission with resource "${UNSANDBOXED_GROUP}", the reason and this exact command; the owner approves it once by default, for just this command. Then run the same command again.`;
  // The Docker socket is the whole story: nothing narrower opens it, and the config.json / socket directory that show up in the same
  // output are not something a path: grant can or should open (~/.docker is never opened; /var/run is far too broad).
  if (DOCKER_SOCKET.test(text)) {
    return `The Docker socket cannot be opened from the Frely command sandbox, and nothing narrower than ${UNSANDBOXED_GROUP} reaches it (a container can mount the whole home directory). ${UNSANDBOXED_ASK}`;
  }
  const hints: string[] = [];

  if (/\.git[\\/]hooks\b/u.test(text)) {
    hints.push("Writing to .git/hooks stays blocked in the Frely command sandbox: hooks run programs outside it, so no approval opens it and request_permission will not help. Ask the user to add or change the hook themselves.");
  }
  if (/\.git[\\/]config\b/u.test(text) && DENIAL_TEXT.test(text)) {
    hints.push("Writing .git/config is allowed in run_command for a .git directory inside the workspace, and never in start_process (run it with run_command instead).");
  }
  const groups = [...Object.entries(SENSITIVE_PATH_GROUPS), ["friday-admin", ADMIN_SESSION_PATHS] as const]
    .filter(([, paths]) => paths.some((path) => commandNamesPath(text, path))).map(([group]) => group);
  for (const group of groups) {
    hints.push(`The Frely command sandbox hides these credential folders until the device owner approves them. Call request_permission with resource "${group}", the reason and this exact command; the owner approves it on the web. Then run the same command again.`);
  }
  if (groups.length === 0) {
    const grants = [...new Set(deniedPaths(lines).flatMap((path) => writeGrantFor(path, context.workspaceRoot) ?? []))];
    if (grants.length > 0 && !/\.git[\\/]hooks\b/u.test(text)) {
      hints.push(`The command tried to write outside the workspace and temp directory, which the Frely command sandbox blocks. Call request_permission with ${grants.map((grant) => `resource "${grant}"`).join(" and ")}, the reason and this exact command; the owner approves it on the web. Then run the same command again.`);
    }
  }
  if (rawTcp) {
    hints.push("The Frely command sandbox only routes HTTP(S) and SOCKS traffic, so a direct TCP connection (database and redis clients, nc) is blocked. "
      + "Stay in the sandbox: start `frely tunnel <host>:<port>` in the same command and point the client at 127.0.0.1:<port>, for example `frely tunnel db.example.com:5432 & sleep 1; psql -h 127.0.0.1 -p 5432 ...`. "
      + `If a tunnel cannot work for this client, ${UNSANDBOXED_ASK.replace(/^Call/u, "call")}`);
  } else if (XPC_DENIAL.test(text)) {
    hints.push(`The command needs a macOS system service (XPC) that the Frely command sandbox does not open, and only ${UNSANDBOXED_GROUP} reaches it. ${UNSANDBOXED_ASK}`);
  }
  if (hints.length > 0) return hints.join(" ");

  if (!DENIAL_TEXT.test(text)) return undefined;
  return "This command may have been blocked by the Frely command sandbox (writes only to the workspace and temp directory; credential folders unreadable; only HTTP(S) and ssh reach the network). "
    + `Name what was blocked and ask for the narrowest approval: call request_permission with the reason and the exact command (a credential group, cache directories or a specific path:<dir> first, ${UNSANDBOXED_GROUP} only when nothing narrower fits); the owner approves it on the web with a passkey or authenticator code. Then run the same command again.`;
}

const SSH_COMMAND = /(?:^|[\s;&|(])(?:ssh|scp|sftp|git)\s/u;
const SSH_FAILURE = /proxy refused the tunnel|could not resolve hostname|kex_exchange_identification/iu;

/** ssh-family failures that never say "permission": the sandbox hides ~/.ssh, so aliases and keys are silently missing. */
function sshHint(stderr: string, command: string, exitCode: number | null | undefined, sshConfigReadable: boolean | undefined): string | undefined {
  if (!SSH_COMMAND.test(command) || !(SSH_FAILURE.test(stderr) || exitCode === 255)) return undefined;
  const alias = /(?:ssh|scp|sftp)\s+(?:-\S+\s+)*(?:[\w.-]+@)?([\w-]+)(?::|\s|$)/u.exec(command)?.[1];
  const aliasNote = alias && !alias.includes(".") ? ` The target "${alias}" has no dot, so it may be an alias from ~/.ssh/config, which the sandbox cannot read.` : "";
  const readNote = sshConfigReadable === false ? " Reading ~/.ssh/config from the CLI process failed too, so the file is missing or unreadable even outside the sandbox; check it exists." : "";
  return `This ssh/scp/sftp/git command probably failed because the Frely command sandbox hides ~/.ssh (config and keys), not because of the network; ssh skips an unreadable config silently.${aliasNote}${readNote} `
    + "Call request_permission with resource=ssh, the reason and the exact command; the owner approves it on the web. Then run the same command again.";
}

/** Whether ~/.ssh/config can be read by the CLI process itself (outside the sandbox). */
export function sshConfigReadable(): boolean {
  try {
    readFileSync(join(homedir(), ".ssh", "config"));
    return true;
  } catch {
    return false;
  }
}

/** Exposed for tests: resets the module-level init state and the underlying manager. */
export async function resetSandboxForTests(): Promise<void> {
  initialized = undefined;
  baseConfig = undefined;
  wrapQueue = Promise.resolve();
  warned = false;
  await SandboxManager.reset().catch(() => undefined);
}
