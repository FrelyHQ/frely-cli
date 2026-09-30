import { tmpdir } from "node:os";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

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

const SENSITIVE_READ_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.docker/config.json",
  "~/.kube",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.netrc",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  "~/.cargo/credentials.toml",
  "~/Library/Application Support/gcloud",
];

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

export function buildSandboxConfig(workspaceRoot: string): SandboxRuntimeConfig {
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
      denyRead: SENSITIVE_READ_PATHS,
      allowWrite: [workspaceRoot, tmpdir()],
      denyWrite: [],
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
export async function sandboxCommand(command: string, workspaceRoot: string): Promise<string> {
  if (isSandboxDisabled()) return command;
  const ready = await ensureInitialized(workspaceRoot);
  if (!ready) {
    if (isSandboxStrict()) throw new Error("Sandboxing is unavailable on this host and FRELY_SANDBOX_STRICT is set; refusing to run an unsandboxed command.");
    return command;
  }
  try {
    return await SandboxManager.wrapWithSandbox(command);
  } catch (error) {
    if (isSandboxStrict()) throw error instanceof Error ? error : new Error(String(error));
    warnOnce(`failed to sandbox a command (${error instanceof Error ? error.message : String(error)}); it ran unsandboxed this time. Set FRELY_SANDBOX_STRICT=1 to refuse instead.`);
    return command;
  }
}

/** Exposed for tests: resets the module-level init state and the underlying manager. */
export async function resetSandboxForTests(): Promise<void> {
  initialized = undefined;
  warned = false;
  await SandboxManager.reset().catch(() => undefined);
}
