$ErrorActionPreference = 'Stop'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) { throw 'This Windows CPU architecture has no Frely release artifact.' }
$asset = "frely-windows-$architecture.exe"
$version = if ($env:FRELY_CLI_VERSION) { $env:FRELY_CLI_VERSION } else { 'latest' }
if ($version -notmatch '^[0-9A-Za-z._-]+$') { throw 'Invalid release version.' }
$github = 'https://github.com/FrelyHQ/frely-cli/releases'
# GitHub first; mainland China and other networks without GitHub fall back to the same build published as an npm package,
# downloaded from npmmirror (China CDN) and then npmjs. FRELY_INSTALL_SOURCES narrows or reorders the list.
$package = "@frelyhq/cli-windows-$architecture"
$sources = if ($env:FRELY_INSTALL_SOURCES) { $env:FRELY_INSTALL_SOURCES -split '\s+' | Where-Object { $_ } } else { @('github', 'npmmirror', 'npmjs') }
$directory = if ($env:FRELY_INSTALL_DIR) { $env:FRELY_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Frely\bin' }
if (![IO.Path]::IsPathRooted($directory)) { throw 'FRELY_INSTALL_DIR must be an absolute path.' }
New-Item -ItemType Directory -Path $directory -Force | Out-Null
if (((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Install directory must not be a reparse point.' }
$stage = Join-Path $directory ('.frely-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  # A stalled transfer (under 50 KB/s for 20 s) counts as unreachable. FRELY_RELEASE_DIR serves a local release directory for tests.
  function Get-File([string]$url, [string]$destination) {
    if ($env:FRELY_RELEASE_DIR) { Copy-Item -LiteralPath (Join-Path $env:FRELY_RELEASE_DIR ($url -split '/')[-1]) -Destination $destination; return }
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($curl) {
      & $curl.Source --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 8 --speed-limit 51200 --speed-time 20 $url -o $destination
      if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
    } else { Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing -TimeoutSec 300 }
  }
  function Test-Checksum([string]$file, [string]$checksumFile) {
    $expected = ((Get-Content -LiteralPath $checksumFile -TotalCount 1) -split '\s+')[0]
    if ($expected -notmatch '^[0-9a-fA-F]{64}$') { return $false }
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $stream = [IO.File]::OpenRead($file)
      try { $actualBytes = $sha256.ComputeHash($stream) }
      finally { $stream.Dispose() }
    } finally { $sha256.Dispose() }
    return $expected.ToLowerInvariant() -eq ([BitConverter]::ToString($actualBytes)).Replace('-', '').ToLowerInvariant()
  }
  function Get-FromGitHub {
    $base = if ($version -eq 'latest') { "$github/latest/download" } else { "$github/download/v$($version.TrimStart('v'))" }
    Get-File "$base/$asset" (Join-Path $stage $asset)
    Get-File "$base/$asset.sha256" (Join-Path $stage "$asset.sha256")
    return Test-Checksum (Join-Path $stage $asset) (Join-Path $stage "$asset.sha256")
  }
  # The package tarball holds package/frely.exe and package/frely.exe.sha256; Windows 10 1803+ ships tar.exe.
  function Get-FromNpm([string]$registry) {
    $wanted = $version.TrimStart('v')
    if ($version -eq 'latest') {
      Get-File "$registry/$package/latest" (Join-Path $stage 'latest')
      $wanted = [string]((Get-Content -LiteralPath (Join-Path $stage 'latest') -Raw | ConvertFrom-Json).version)
    }
    if ($wanted -notmatch '^[0-9.]+$') { return $false }
    $tarball = Join-Path $stage 'package.tgz'
    Get-File "$registry/$package/-/$(($package -split '/')[-1])-$wanted.tgz" $tarball
    $unpacked = Join-Path $stage 'npm'
    New-Item -ItemType Directory -Path $unpacked -Force | Out-Null
    & tar.exe -xzf $tarball -C $unpacked
    if ($LASTEXITCODE -ne 0) { return $false }
    $binary = Join-Path $unpacked 'package\frely.exe'
    if (-not (Test-Checksum $binary "$binary.sha256")) { return $false }
    Move-Item -LiteralPath $binary -Destination (Join-Path $stage $asset) -Force
    return $true
  }
  $downloaded = $false
  foreach ($source in $sources) {
    try {
      $downloaded = switch ($source) {
        'github' { Get-FromGitHub }
        'npmmirror' { Get-FromNpm 'https://registry.npmmirror.com' }
        'npmjs' { Get-FromNpm 'https://registry.npmjs.org' }
        default { throw "Unknown install source: $source (use github, npmmirror, npmjs)." }
      }
    } catch { if ($_.Exception.Message -like 'Unknown install source*') { throw }; $downloaded = $false }
    if ($downloaded -eq $true) { break }
    foreach ($leftover in @($asset, "$asset.sha256", 'npm', 'package.tgz', 'latest')) { Remove-Item -LiteralPath (Join-Path $stage $leftover) -Recurse -Force -ErrorAction SilentlyContinue }
    [Console]::Error.WriteLine("Frely: $source unavailable or failed verification; trying the next source.")
  }
  if ($downloaded -ne $true) { throw 'No source supplied a verified release (checksum mismatch or no connection); installation was not changed.' }
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
  Write-Output 'Basic commands require no keyring setup. MCP authorization begins with frely mcp start.'
} finally { Remove-Item -LiteralPath $stage -Recurse -Force }
