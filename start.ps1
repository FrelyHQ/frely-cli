# Install Frely, then `frely link on`: sign in through the browser when needed (the page also registers
# new accounts), approve device MCP and print the MCP URL. install.ps1 stays the install-only script.
# Safe to re-run: it updates to the latest version and restarts the MCP background service on the new binary.
$ErrorActionPreference = 'Stop'
# A pre-login install command sets FRELY_INSTALL_TOKEN (one-time). Only `frely link on` gets it;
# it is removed for the old binary and the installer.
$installToken = $env:FRELY_INSTALL_TOKEN
Remove-Item Env:FRELY_INSTALL_TOKEN -ErrorAction SilentlyContinue
$directory = if ($env:FRELY_INSTALL_DIR) { $env:FRELY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Frely\bin' }
# Stop a running background service before replacing frely.exe (Windows cannot replace a running binary).
# A failed stop (no service) is ignored; only a successful stop is remembered for resuming.
$old = Join-Path $directory 'frely.exe'
$stopped = $false
if (Test-Path -LiteralPath $old) {
  try { & $old link stop *> $null; $stopped = ($LASTEXITCODE -eq 0) } catch { $stopped = $false }
  # The installed binary may predate the rename of `frely mcp` to `frely link`.
  if (-not $stopped) { try { & $old mcp stop *> $null; $stopped = ($LASTEXITCODE -eq 0) } catch { $stopped = $false } }
}
$here = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
$installer = if ($here) { Join-Path $here 'install.ps1' } else { $null }
try {
  if ($installer -and (Test-Path -LiteralPath $installer)) { & $installer }
  else {
    $url = if ($env:FRELY_INSTALLER_URL) { $env:FRELY_INSTALLER_URL } else { 'https://frely.cloud/install.ps1' }
    if ($url -notmatch '^https://') { throw 'FRELY_INSTALLER_URL must be an https URL.' }
    $script = Join-Path ([IO.Path]::GetTempPath()) ('frely-install-' + [Guid]::NewGuid().ToString('N') + '.ps1')
    try {
      Invoke-WebRequest -Uri $url -OutFile $script -UseBasicParsing
      & $script
    } finally { Remove-Item -LiteralPath $script -Force -ErrorAction SilentlyContinue }
  }
} catch {
  # A failed update must not leave the service we stopped stopped.
  if ($stopped) { try { & $old link on --resume *> $null; if ($LASTEXITCODE -ne 0) { & $old mcp start --resume *> $null } } catch {} }
  throw
}
$frely = Join-Path $directory 'frely.exe'
if (!(Test-Path -LiteralPath $frely)) { throw "Frely was not installed at $frely." }
if ($installToken) { $env:FRELY_INSTALL_TOKEN = $installToken; Remove-Variable installToken }
# Default workspace: the home directory (credential and start-up files stay protected); FRELY_WORKSPACE picks another.
if ($env:FRELY_WORKSPACE) { & $frely link on --workspace $env:FRELY_WORKSPACE } else { & $frely link on }
# Run through `irm https://frely.cloud/w | iex` there is no script file; `exit` would close the user's PowerShell window.
if ($PSCommandPath) { exit $LASTEXITCODE }
