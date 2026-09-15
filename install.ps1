$ErrorActionPreference = 'Stop'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) { throw 'This Windows CPU architecture has no Frely release artifact.' }
$asset = "frely-windows-$architecture.exe"
$version = if ($env:FRELY_CLI_VERSION) { $env:FRELY_CLI_VERSION } else { 'latest' }
if ($version -notmatch '^[0-9A-Za-z._-]+$') { throw 'Invalid release version.' }
$base = if ($version -eq 'latest') { 'https://github.com/FrelyHQ/frely-cli/releases/latest/download' } else { "https://github.com/FrelyHQ/frely-cli/releases/download/v$($version.TrimStart('v'))" }
$directory = if ($env:FRELY_INSTALL_DIR) { $env:FRELY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Frely\bin' }
if (![IO.Path]::IsPathRooted($directory)) { throw 'FRELY_INSTALL_DIR must be an absolute path.' }
New-Item -ItemType Directory -Path $directory -Force | Out-Null
if (((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Install directory must not be a reparse point.' }
$stage = Join-Path $directory ('.frely-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($file in @($asset, "$asset.sha256")) {
    $destination = Join-Path $stage $file
    if ($env:FRELY_RELEASE_DIR) { Copy-Item -LiteralPath (Join-Path $env:FRELY_RELEASE_DIR $file) -Destination $destination }
    else { Invoke-WebRequest -Uri "$base/$file" -OutFile $destination -UseBasicParsing }
  }
  $expected = ((Get-Content -LiteralPath (Join-Path $stage "$asset.sha256") -TotalCount 1) -split '\s+')[0]
  if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw 'Invalid release checksum.' }
  $download = Join-Path $stage $asset
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($download)
    try { $actualBytes = $sha256.ComputeHash($stream) }
    finally { $stream.Dispose() }
  } finally { $sha256.Dispose() }
  $actual = ([BitConverter]::ToString($actualBytes)).Replace('-', '').ToLowerInvariant()
  if ($expected.ToLowerInvariant() -ne $actual) { throw 'Release checksum mismatch; installation was not changed.' }
  & $download --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The downloaded executable could not run.' }
  $target = Join-Path $directory 'frely.exe'
  if (Test-Path -LiteralPath $target) {
    if (((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Existing executable must not be a reparse point.' }
    [IO.File]::Replace($download, $target, $null)
  } else { [IO.File]::Move($download, $target) }
  if ($env:FRELY_INSTALL_NO_PROFILE -ne '1') {
    try {
      $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
      if (($userPath -split ';') -notcontains $directory) {
        [Environment]::SetEnvironmentVariable('PATH', "$directory;$userPath", 'User')
      }
    } catch {
      Write-Warning "Frely was installed, but the user PATH could not be updated: $($_.Exception.Message)"
    }
  }
  if (($env:PATH -split ';') -notcontains $directory) { $env:PATH = "$directory;$env:PATH" }
  $installedVersion = & $target --version
  Write-Output "Installed Frely $installedVersion at $target"
  Write-Output 'Basic commands require no keyring setup. MCP authorization begins with frely mcp.'
} finally { Remove-Item -LiteralPath $stage -Recurse -Force }
