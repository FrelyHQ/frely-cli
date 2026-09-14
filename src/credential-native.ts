import { win32 } from "node:path";
import type { CredentialStore } from "./credential-store.js";
import { runCredentialCommand, type CredentialCommand, type CommandResult } from "./credential-command.js";

const unavailable = () => new Error("OS credential store access failed. Unlock the store and run `frely doctor`; headless hosts can configure FRELY_CREDENTIAL_STORE=encrypted-file with FRELY_CREDENTIAL_KEY. No plaintext fallback was used.");
const stripNewline = (value: string): string => value.replace(/\r?\n$/u, "");

export function createNativeCredentialStore(platform = process.platform, run: CredentialCommand = runCredentialCommand): CredentialStore {
  if (platform === "darwin") {
    const read = async (service: string, account: string): Promise<string | null> => {
      const result = await run("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-g"]);
      if (result.code === 44) return null; // errSecItemNotFound; other failures must not become missing credentials.
      if (result.code !== 0) throw unavailable();
      const output = stripNewline(result.stderr);
      if (!output.startsWith("password: ")) throw unavailable();
      const value = output.slice("password: ".length);
      const hex = /^0x([a-fA-F0-9]+)(?:\s.*)?$/su.exec(value)?.[1];
      if (hex && hex.length % 2 === 0) return Buffer.from(hex, "hex").toString("utf8");
      if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
      if (value === "") return "";
      throw unavailable();
    };
    return {
      getPassword: read,
      async setPassword(service, account, password) {
        // security's interactive parser is not a shell. Restrict its identifiers and send
        // password bytes as hex over stdin; -A and shell/argv secrets are prohibited.
        if ([service, account].some((value) => /[\x00-\x20\x7f"'\\]/u.test(value))) throw new Error("Invalid macOS credential identifier.");
        const line = `add-generic-password -U -s "${service}" -a "${account}" -X ${Buffer.from(password, "utf8").toString("hex")}\n`;
        if (Buffer.byteLength(line, "utf8") >= 4096) throw new Error("macOS credential command exceeds its input limit.");
        const result = await run("/usr/bin/security", ["-i"], line);
        // Interactive security can exit 0 after a command error; require readback.
        if (result.code !== 0 || await read(service, account) !== password) throw unavailable();
      },
      async deletePassword(service, account) {
        const result = await run("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account]);
        if (result.code === 44) return false;
        if (result.code !== 0) throw unavailable();
        return true;
      },
    };
  }
  if (platform === "linux") {
    const missing = (result: CommandResult): boolean => result.code === 1 && result.stdout.length === 0 && result.stderr.trim().length === 0;
    const attributes = (service: string, account: string) => ["service", service, "account", account];
    const read = async (service: string, account: string): Promise<string | null> => {
      const result = await run("secret-tool", ["lookup", ...attributes(service, account)]);
      if (missing(result)) return null;
      if (result.code !== 0) throw unavailable();
      return stripNewline(result.stdout);
    };
    return {
      getPassword: read,
      async setPassword(service, account, password) {
        const result = await run("secret-tool", ["store", "--label=Frely CLI", ...attributes(service, account)], password);
        if (result.code !== 0 || await read(service, account) !== password) throw unavailable();
      },
      async deletePassword(service, account) {
        if (await read(service, account) === null) return false;
        const result = await run("secret-tool", ["clear", ...attributes(service, account)]);
        if (result.code !== 0) throw unavailable();
        return true;
      },
    };
  }
  if (platform === "win32") {
    const execute = async (operation: string, service: string, account: string, password?: string): Promise<string | boolean | null> => {
      const file = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = await run(file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], JSON.stringify({ operation, target: `${service}/${account}`, account, ...(password !== undefined ? { data: Buffer.from(password, "utf8").toString("base64") } : {}) }));
      if (result.code !== 0) throw unavailable();
      try {
        const value = JSON.parse(result.stdout.trim()) as { ok?: boolean; data?: string | null; deleted?: boolean };
        if (value.ok !== true) throw unavailable();
        if (operation === "get") {
          if (value.data === null) return null;
          if (typeof value.data !== "string") throw unavailable();
          return Buffer.from(value.data, "base64").toString("utf8");
        }
        return value.deleted ?? true;
      } catch { throw unavailable(); }
    };
    return {
      async getPassword(service, account) { return await execute("get", service, account) as string | null; },
      async setPassword(service, account, password) {
        if (Buffer.byteLength(password, "utf8") > 2560) throw new Error("Windows Credential Manager limits a credential to 2560 bytes. Use FRELY_CREDENTIAL_STORE=encrypted-file with an injected FRELY_CREDENTIAL_KEY for larger credentials.");
        await execute("set", service, account, password);
      },
      async deletePassword(service, account) { return await execute("delete", service, account) as boolean; },
    };
  }
  throw new Error("Unsupported OS credential store. Configure FRELY_CREDENTIAL_STORE=encrypted-file with FRELY_CREDENTIAL_KEY.");
}

// Static source only. Request values enter through stdin JSON, not PowerShell source.
// CredentialBlob is UTF-8 and TargetName is service/account, matching legacy keytar.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class FrelyCredentials {
  [StructLayout(LayoutKind.Sequential)]
  struct Credential {
    public uint Flags, Type;
    public IntPtr TargetName, Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist, AttributeCount;
    public IntPtr Attributes, TargetAlias, UserName;
  }
  [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Write(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool Delete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr credential);
  public static string Get(string target) {
    IntPtr ptr;
    if (!Read(target, 1, 0, out ptr)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      Credential value = (Credential)Marshal.PtrToStructure(ptr, typeof(Credential));
      byte[] data = new byte[value.CredentialBlobSize];
      if (data.Length > 0) Marshal.Copy(value.CredentialBlob, data, 0, data.Length);
      return Convert.ToBase64String(data);
    } finally { CredFree(ptr); }
  }
  public static void Set(string target, string account, string encoded) {
    byte[] data = Convert.FromBase64String(encoded);
    Credential value = new Credential();
    value.Type = 1; value.Persist = 2;
    try {
      value.TargetName = Marshal.StringToCoTaskMemUni(target);
      value.UserName = Marshal.StringToCoTaskMemUni(account);
      value.CredentialBlobSize = (uint)data.Length;
      value.CredentialBlob = Marshal.AllocCoTaskMem(data.Length);
      if (data.Length > 0) Marshal.Copy(data, 0, value.CredentialBlob, data.Length);
      if (!Write(ref value, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      if (value.CredentialBlob != IntPtr.Zero) {
        for (int i = 0; i < data.Length; i++) Marshal.WriteByte(value.CredentialBlob, i, 0);
        Marshal.FreeCoTaskMem(value.CredentialBlob);
      }
      Marshal.FreeCoTaskMem(value.TargetName); Marshal.FreeCoTaskMem(value.UserName);
      Array.Clear(data, 0, data.Length);
    }
  }
  public static bool Remove(string target) {
    if (Delete(target, 1, 0)) return true;
    int error = Marshal.GetLastWin32Error();
    if (error == 1168) return false;
    throw new Win32Exception(error);
  }
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
switch ($request.operation) {
  'get' { $data = [FrelyCredentials]::Get($request.target); [Console]::Out.Write((@{ok=$true;data=$data} | ConvertTo-Json -Compress)) }
  'set' { [FrelyCredentials]::Set($request.target,$request.account,$request.data); [Console]::Out.Write('{"ok":true}') }
  'delete' { $deleted = [FrelyCredentials]::Remove($request.target); [Console]::Out.Write((@{ok=$true;deleted=$deleted} | ConvertTo-Json -Compress)) }
  default { exit 1 }
}
} catch { [Console]::Error.Write('Windows credential operation failed.'); exit 1 }
`;
