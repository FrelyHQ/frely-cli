import { win32 } from "node:path";
import { runCredentialCommand, type CredentialCommand } from "./credential-command.js";

export type WindowsServiceAction = "install" | "start" | "stop" | "uninstall" | "status";
export interface WindowsServiceStatus { installed: boolean; active: boolean }

/** Task Scheduler receives an executable and its argument string, not a shell command. */
export function windowsArgument(value: string): string {
  if (/[\x00-\x1f\x7f]/u.test(value)) throw new Error("Service arguments must not contain control characters.");
  return '"' + value.replace(/(\\*)"/gu, (_match, slashes: string) => slashes + slashes + '\\"').replace(/\\+$/u, (slashes) => slashes + slashes) + '"';
}

export async function windowsService(action: WindowsServiceAction, command: string[] = [], run: CredentialCommand = runCredentialCommand): Promise<WindowsServiceStatus> {
  if (action === "install" && !command[0]) throw new Error("Windows service command is missing.");
  const executable = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await run(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], JSON.stringify({ action,
    executable: command[0] ?? "", arguments: command.slice(1).map(windowsArgument).join(" ") }));
  if (result.code !== 0) throw new Error("Windows user-level Device Relay task operation failed. No elevation or execution-policy override was attempted.");
  const status = JSON.parse(result.stdout.trim()) as WindowsServiceStatus;
  if (typeof status.installed !== "boolean" || typeof status.active !== "boolean") throw new Error("Windows service returned an invalid status.");
  return status;
}

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $name = 'Frely-DeviceRelay-' + $identity.User.Value
  function Find-FrelyTask {
    try { return Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop }
    catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return $null }; throw }
  }
  $task = Find-FrelyTask
  switch ($request.action) {
    'install' {
      $action = New-ScheduledTaskAction -Execute $request.executable -Argument $request.arguments
      $principal = New-ScheduledTaskPrincipal -UserId $identity.User.Value -LogonType Interactive -RunLevel Limited
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
      $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
      if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name -TaskPath '\' }
      Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Frely user-level Device Relay' -Force | Out-Null
      Start-ScheduledTask -TaskName $name -TaskPath '\'
    }
    'start' { if (!$task) { throw 'not installed' }; Start-ScheduledTask -TaskName $name -TaskPath '\' }
    'stop' { if ($task) { Stop-ScheduledTask -TaskName $name -TaskPath '\' } }
    'uninstall' { if ($task) { Stop-ScheduledTask -TaskName $name -TaskPath '\'; Unregister-ScheduledTask -TaskName $name -TaskPath '\' -Confirm:$false } }
    'status' {}
    default { throw 'invalid action' }
  }
  $task = Find-FrelyTask
  @{ installed = [bool]$task; active = [bool]($task -and $task.State -eq 'Running') } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('Frely user task operation failed.'); exit 1 }
`;
