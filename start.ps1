# Install Frely, then `frely mcp start`: sign in through the browser when needed (the page also registers
# new accounts), approve device MCP and print the MCP URL. install.ps1 stays the install-only script.
$ErrorActionPreference = 'Stop'
$directory = if ($env:FRELY_INSTALL_DIR) { $env:FRELY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Frely\bin' }
$here = if ($PSCommandPath) { Split-Path -Parent $PSCommandPath } else { $null }
$installer = if ($here) { Join-Path $here 'install.ps1' } else { $null }
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
$frely = Join-Path $directory 'frely.exe'
if (!(Test-Path -LiteralPath $frely)) { throw "Frely was not installed at $frely." }
# Default workspace: the home directory (credential and start-up files stay protected); FRELY_WORKSPACE picks another.
if ($env:FRELY_WORKSPACE) { & $frely mcp start --workspace $env:FRELY_WORKSPACE } else { & $frely mcp start }
exit $LASTEXITCODE
