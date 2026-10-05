# Install Frely, sign in (the browser page also registers new accounts), then print the MCP URL.
# install.ps1 stays the install-only script; this one continues into the MCP flow.
$ErrorActionPreference = 'Stop'
$directory = if ($env:FRELY_INSTALL_DIR) { $env:FRELY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Frely\bin' }
$here = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
$installer = if ($here) { Join-Path $here 'install.ps1' } else { $null }
if ($installer -and (Test-Path -LiteralPath $installer)) { & $installer }
else {
  $url = if ($env:FRELY_INSTALLER_URL) { $env:FRELY_INSTALLER_URL } else { 'https://cli.frely.cloud/install.ps1' }
  if ($url -notmatch '^https://') { throw 'FRELY_INSTALLER_URL must be an https URL.' }
  & ([scriptblock]::Create((Invoke-WebRequest -Uri $url -UseBasicParsing).Content))
}
$frely = Join-Path $directory 'frely.exe'
if (!(Test-Path -LiteralPath $frely)) { throw "Frely was not installed at $frely." }
if (-not [Environment]::UserInteractive) {
  Write-Output "No interactive session is available here. Run these commands in a terminal:`n  $frely login`n  $frely mcp url"
  return
}
$doctor = (& $frely doctor --json 2>$null) -join ''
if ($doctor -match '"account":\s*"[^"]*[Nn]ot logged in') {
  [Console]::Error.WriteLine('Frely: opening the browser to sign in. New to Frely? The same page creates an account.')
  & $frely login
  if ($LASTEXITCODE -ne 0) { throw 'Frely login failed.' }
} else { [Console]::Error.WriteLine('Frely: already signed in.') }
$workspace = if ($env:FRELY_WORKSPACE) { $env:FRELY_WORKSPACE } else { (Get-Location).Path }
[Console]::Error.WriteLine("Frely: enabling device MCP for $workspace (add more later with: frely mcp workspace add <path>).")
& $frely mcp url --workspace $workspace
