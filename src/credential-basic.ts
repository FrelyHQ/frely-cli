import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { readPrivateFile, writePrivateFile, ensureCredentialDirectory } from "./credential-file.js";
import { runCredentialCommand } from "./credential-command.js";
import type { CredentialStore } from "./credential-store.js";

const SERVICES = new Set(["frely-cli-basic-v1", "frely-network", "frely-cli-provider-device-v1"]);
export const BASIC_CREDENTIAL_BACKEND = "private session files (not encrypted)";

/** Layer-one credentials have no OS keyring or operator-supplied key dependency. */
export function createBasicCredentialStore(rootInput?: string): CredentialStore {
  const root = () => rootInput ?? resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "frely", "basic-credentials-v1");
  const entry = (service: string, account: string) => {
    if (!SERVICES.has(service) || !account || /[\x00-\x1f\x7f]/u.test(account)) throw new Error("Credential is not eligible for basic storage.");
    return join(root(), createHash("sha256").update(JSON.stringify([service, account])).digest("hex") + ".json");
  };
  return {
    async getPassword(service, account) {
      const path = entry(service, account);
      if (!await ensureCredentialDirectory(root(), false)) return null;
      const raw = await readPrivateFile(path);
      if (raw === null) return null;
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("value" in value) || typeof value.value !== "string") throw new Error("Basic credential file is invalid.");
      return value.value;
    },
    async setPassword(service, account, password) {
      const path = entry(service, account);
      if (!password || Buffer.byteLength(password) > 1024 * 1024) throw new Error("Basic credential size is invalid.");
      await prepareBasicDirectory(root());
      await readPrivateFile(path); // Reject link replacement and unsafe existing entries.
      await writePrivateFile(path, JSON.stringify({ version: 1, value: password }) + "\n");
    },
    async deletePassword(service, account) {
      const path = entry(service, account);
      if (!await ensureCredentialDirectory(root(), false) || await readPrivateFile(path) === null) return false;
      await unlink(path);
      return true;
    },
  };
}

async function prepareBasicDirectory(root: string): Promise<void> {
  const parent = dirname(root);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error("Basic credential directory is not owned by this user.");
  if (process.platform !== "win32") await chmod(parent, 0o700);
  await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
  });
  if (process.platform === "win32") {
    const executable = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await runCredentialCommand(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL], root);
    if (result.code !== 0) throw new Error("Could not protect the basic credential directory ACL.");
  }
  await ensureCredentialDirectory(root, true);
}

// No keyring access, privilege elevation, profile script or execution-policy override.
const WINDOWS_ACL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $path = [Console]::In.ReadToEnd()
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'link' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  & $icacls $path '/reset' '/Q' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'reset' }
  & $icacls $path '/inheritance:r' '/grant:r' "*$($sid):(OI)(CI)(F)" '/Q' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'protect' }
} catch { exit 1 }
`;

export const basicCredentialStore: CredentialStore = createBasicCredentialStore();
