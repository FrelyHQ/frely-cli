$ErrorActionPreference = 'Stop'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) { throw 'This Windows CPU architecture has no Frely release artifact.' }
$asset = "frely-windows-$architecture.exe"
$version = if ($env:FRELY_CLI_VERSION) { $env:FRELY_CLI_VERSION } else { 'latest' }
if ($version -notmatch '^[0-9A-Za-z._-]+$') { throw 'Invalid release version.' }
$github = 'https://github.com/FrelyHQ/frely-cli/releases'
$mirror = if ($env:FRELY_RELEASE_MIRROR) { $env:FRELY_RELEASE_MIRROR.TrimEnd('/') } else { 'https://dl.frely.cloud/cli' }
if ($mirror -ne 'off' -and $mirror -notmatch '^https://') { throw 'FRELY_RELEASE_MIRROR must be an https URL or off.' }
$directory = if ($env:FRELY_INSTALL_DIR) { $env:FRELY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Frely\bin' }
if (![IO.Path]::IsPathRooted($directory)) { throw 'FRELY_INSTALL_DIR must be an absolute path.' }
New-Item -ItemType Directory -Path $directory -Force | Out-Null
if (((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Install directory must not be a reparse point.' }
$stage = Join-Path $directory ('.frely-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  function Get-Release([string]$base) {
    foreach ($file in @($asset, "$asset.sha256")) {
      $destination = Join-Path $stage $file
      if ($env:FRELY_RELEASE_DIR) { Copy-Item -LiteralPath (Join-Path $env:FRELY_RELEASE_DIR $file) -Destination $destination }
      else { Invoke-WebRequest -Uri "$base/$file" -OutFile $destination -UseBasicParsing -TimeoutSec 300 }
    }
  }
  function Test-Release {
    $expected = ((Get-Content -LiteralPath (Join-Path $stage "$asset.sha256") -TotalCount 1) -split '\s+')[0]
    if ($expected -notmatch '^[0-9a-fA-F]{64}$') { return $false }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $stream = [IO.File]::OpenRead((Join-Path $stage $asset))
      try { $actualBytes = $sha256.ComputeHash($stream) }
      finally { $stream.Dispose() }
    } finally { $sha256.Dispose() }
    return $expected.ToLowerInvariant() -eq ([BitConverter]::ToString($actualBytes)).Replace('-', '').ToLowerInvariant()
  }
  # The static mirror is reachable from mainland China; any mirror problem (lookup, download, checksum) falls back to GitHub as a whole.
  $downloaded = $false
  if ($mirror -ne 'off' -and -not $env:FRELY_RELEASE_DIR) {
    try {
      $mirrorVersion = $version.TrimStart('v')
      if ($version -eq 'latest') { $mirrorVersion = ([string](Invoke-WebRequest -Uri "$mirror/latest" -UseBasicParsing -TimeoutSec 8).Content).Trim() }
      if ($mirrorVersion -match '^[0-9.]+$') {
        Get-Release "$mirror/v$mirrorVersion"
        $downloaded = Test-Release
      }
    } catch { $downloaded = $false }
    if (-not $downloaded) { Remove-Item -LiteralPath (Join-Path $stage $asset), (Join-Path $stage "$asset.sha256") -Force -ErrorAction SilentlyContinue }
  }
  if (-not $downloaded) {
    $base = if ($version -eq 'latest') { "$github/latest/download" } else { "$github/download/v$($version.TrimStart('v'))" }
    Get-Release $base
    if (-not (Test-Release)) { throw 'Release checksum mismatch or invalid; installation was not changed.' }
  }
  $download = Join-Path $stage $asset
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
  Write-Output 'Basic commands require no keyring setup. MCP authorization begins with frely mcp url.'
} finally { Remove-Item -LiteralPath $stage -Recurse -Force }
