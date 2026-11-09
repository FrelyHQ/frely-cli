param([switch]$Quiet, [string]$Email)
$ErrorActionPreference = 'Stop'
# -Quiet (agents): print only the one-line result, warnings and errors. -Email: after installing, send the sign-in code mail.
function Say([string]$text) { if (-not $Quiet) { Write-Output $text } }
if ($Email) {
  if ($Email.Length -gt 254 -or $Email -notmatch '^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$') { throw '-Email must be a plain address like name@example.com.' }
}
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -notin @('x64', 'arm64')) { throw 'This Windows CPU architecture has no Frely release artifact.' }
$asset = "frely-windows-$architecture.exe"
$version = if ($env:FRELY_CLI_VERSION) { $env:FRELY_CLI_VERSION } else { 'latest' }
if ($version -notmatch '^[0-9A-Za-z._-]+$') { throw 'Invalid release version.' }
$github = 'https://github.com/FrelyHQ/frely-cli/releases'
# GitHub first; mainland China and other networks without GitHub fall back to the same build published as an npm package,
# downloaded from npmmirror (China CDN) and then npmjs. FRELY_INSTALL_SOURCES narrows or reorders the list; unless it (or
# FRELY_RELEASE_DIR) is set, github and npmmirror are probed in parallel and the faster one goes first (Rank-Sources).
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
  # GitHub carries each executable gzip-compressed (<asset>.gz); the .sha256 beside it is the checksum of the decompressed file.
  # Releases published before gzip assets existed have only the plain executable, so a missing .gz falls back to it.
  function Get-FromGitHub {
    $base = if ($version -eq 'latest') { "$github/latest/download" } else { "$github/download/v$($version.TrimStart('v'))" }
    Get-File "$base/$asset.sha256" (Join-Path $stage "$asset.sha256")
    $target = Join-Path $stage $asset
    $archive = Join-Path $stage "$asset.gz"
    $compressed = $true
    try { Get-File "$base/$asset.gz" $archive } catch { $compressed = $false }
    if ($compressed) {
      $source = [IO.File]::OpenRead($archive)
      try {
        $gzip = New-Object IO.Compression.GzipStream($source, [IO.Compression.CompressionMode]::Decompress)
        $output = [IO.File]::Create($target)
        try {
          # Cap the decompressed size (200 MB); a truncated file fails the checksum below.
          $buffer = New-Object byte[] 1048576
          $total = 0
          while (($read = $gzip.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $total += $read
            if ($total -gt 209715200) { throw 'Decompressed release is too large.' }
            $output.Write($buffer, 0, $read)
          }
        } finally { $output.Dispose(); $gzip.Dispose() }
      } finally { $source.Dispose() }
      Remove-Item -LiteralPath $archive -Force
    } else { Get-File "$base/$asset" $target }
    return Test-Checksum $target (Join-Path $stage "$asset.sha256")
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
  # Start-Probe: curl.exe fetches the first ~2 MB of the real download for at most 4 s; the result is the bytes and bytes/second it reported.
  function Start-Probe([string]$url, [string]$name) {
    $curl = Get-Command curl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $curl) { return $null }
    $out = Join-Path $stage "probe.$name"
    $arguments = @('--silent', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--connect-timeout', '4', '--max-time', '4',
      '--range', '0-1999999', '-o', 'NUL', '-w', '%{size_download} %{speed_download}', $url)
    $process = Start-Process -FilePath $curl.Source -ArgumentList $arguments -NoNewWindow -PassThru -RedirectStandardOutput $out
    return @{ Process = $process; Out = $out; Start = Get-Date }
  }
  function Get-ProbeSpeed($probe) {
    if (-not $probe) { return 0 }
    if (-not $probe.Process.WaitForExit(4500)) { try { $probe.Process.Kill() } catch { } return 0 }
    try {
      $parts = (Get-Content -LiteralPath $probe.Out -Raw -ErrorAction Stop).Trim() -split '\s+'
      if ($parts.Count -lt 2 -or [double]$parts[0] -le 0) { return 0 }
      return [double]$parts[1]
    } catch { return 0 }
  }
  function Rank-Sources([string[]]$ordered) {
    $base = if ($version -eq 'latest') { "$github/latest/download" } else { "$github/download/v$($version.TrimStart('v'))" }
    $githubProbe = Start-Probe "$base/$asset.gz" 'github'
    $npmProbe = $null
    try {
      $wanted = $version.TrimStart('v')
      if ($version -eq 'latest') {
        $meta = Invoke-RestMethod -Uri "https://registry.npmmirror.com/$package/latest" -TimeoutSec 4 -UseBasicParsing
        $wanted = [string]$meta.version
      }
      if ($wanted -match '^[0-9.]+$') { $npmProbe = Start-Probe "https://registry.npmmirror.com/$package/-/$(($package -split '/')[-1])-$wanted.tgz" 'npmmirror' }
    } catch { }
    $githubSpeed = Get-ProbeSpeed $githubProbe
    $npmSpeed = Get-ProbeSpeed $npmProbe
    if ($npmSpeed -gt $githubSpeed) { return @('npmmirror', 'github', 'npmjs') }
    return $ordered
  }
  if (-not $env:FRELY_INSTALL_SOURCES -and -not $env:FRELY_RELEASE_DIR) { $sources = Rank-Sources $sources }
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
    if ($downloaded -eq $true) { $usedSource = $source; break }
    foreach ($leftover in @($asset, "$asset.gz", "$asset.sha256", 'npm', 'package.tgz', 'latest')) { Remove-Item -LiteralPath (Join-Path $stage $leftover) -Recurse -Force -ErrorAction SilentlyContinue }
    [Console]::Error.WriteLine("Frely: $source unavailable or failed verification; trying the next source.")
  }
  if ($downloaded -ne $true) { throw 'No source supplied a verified release (checksum mismatch or no connection); installation was not changed.' }
  [Console]::Error.WriteLine("Frely: using $usedSource")
  $download = Join-Path $stage $asset
  & $download --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The downloaded executable could not run.' }
  $target = Join-Path $directory 'frely.exe'
  # Windows cannot replace a running binary. Stop a running background service first (`mcp service stop` is accepted by every
  # released version; a failed stop, e.g. no service, is ignored) and resume it on whichever binary ends up installed.
  $serviceStopped = $false
  if (Test-Path -LiteralPath $target) {
    if (((Get-Item -LiteralPath $target -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Existing executable must not be a reparse point.' }
    try { & $target mcp service stop *> $null; $serviceStopped = ($LASTEXITCODE -eq 0) } catch { $serviceStopped = $false }
    $install = { [IO.File]::Replace($download, $target, $null) }
  } else { $install = { [IO.File]::Move($download, $target) } }
  # A just-written executable can stay locked for a moment (antivirus scan after the archive was decompressed): retry briefly.
  $installError = $null
  for ($attempt = 1; ; $attempt++) {
    try { & $install; break } catch { if ($attempt -ge 20) { $installError = $_; break }; Start-Sleep -Milliseconds 500 }
  }
  if ($installError) {
    # Keep the verified download instead of deleting it with the stage directory.
    $kept = Join-Path $directory ($asset -replace '\.exe$','.new.exe')
    $keptOk = $false
    try { Move-Item -LiteralPath $download -Destination $kept -Force; $keptOk = $true } catch { }
    if ($serviceStopped) { try { & $target mcp service start *> $null } catch { } }
    if ($keptOk) { throw "Could not replace $target ($($installError.Exception.Message)). It is probably still running: close every terminal or agent using frely, then run: Move-Item -Force `"$kept`" `"$target`"  (the verified download was kept at $kept)." }
    throw "Could not replace $target ($($installError.Exception.Message)). Close every program using frely and run the installer again."
  }
  if ($serviceStopped) { try { & $target mcp service start *> $null } catch { } }
  $pathPersisted = $true
  if ($env:FRELY_INSTALL_NO_PROFILE -ne '1') {
    try {
      # Edit the raw registry value so REG_EXPAND_SZ entries such as %USERPROFILE%\bin stay unexpanded, then broadcast the change.
      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
      try {
        $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $entries = @($raw -split ';' | Where-Object { $_ })
        if (($entries | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') }) -notcontains $directory.TrimEnd('\')) {
          $key.SetValue('Path', (@($directory) + $entries) -join ';', [Microsoft.Win32.RegistryValueKind]::ExpandString)
        }
      } finally { $key.Dispose() }
      # SetEnvironmentVariable broadcasts WM_SETTINGCHANGE so new Explorer-launched terminals pick the PATH up.
      [Environment]::SetEnvironmentVariable('FRELY_PATH_REFRESH', $null, 'User')
    } catch {
      $pathPersisted = $false
      Write-Warning "Frely was installed, but the user PATH could not be updated: $($_.Exception.Message)"
    }
  }
  # A long-running local agent (or IDE) keeps the PATH it started with, so the registry update above never reaches
  # the shells it spawns. When the install directory is missing from this process' PATH, also drop a tiny
  # frely.cmd forwarder into a user-writable directory that is already on it; it is removed by `frely uninstall`.
  $inheritedPath = $env:PATH
  $shim = $null
  if ($env:FRELY_INSTALL_NO_PROFILE -ne '1' -and (($inheritedPath -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $directory.TrimEnd('\'))) {
    $onPath = @($inheritedPath -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
    $candidates = @((Join-Path $env:APPDATA 'npm'), (Join-Path $env:USERPROFILE '.local\bin'), (Join-Path $env:USERPROFILE 'bin'), (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps'))
    foreach ($candidate in $candidates) {
      if (-not $candidate -or $onPath -notcontains $candidate.TrimEnd('\') -or -not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
      $file = Join-Path $candidate 'frely.cmd'
      try {
        if ((Test-Path -LiteralPath $file) -and -not ((Get-Content -LiteralPath $file -Raw) -match 'frely-shim')) { continue }
        [IO.File]::WriteAllText($file, "@echo off`r`nREM frely-shim: forwards to the Frely install directory; removed by frely uninstall`r`n`"$target`" %*`r`n")
        $shim = $file; break
      } catch { continue }
    }
  }
  # Verify from the outside: would a new login shell, and the shell this agent/process spawns, find `frely`?
  function Find-Frely([string]$path) {
    $saved = $env:PATH
    try { $env:PATH = $path; $found = & $env:ComSpec /d /c '%SystemRoot%\System32\where.exe frely 2>nul' | Select-Object -First 1 } finally { $env:PATH = $saved }
    return $found
  }
  $freshPath = ([Environment]::GetEnvironmentVariable('PATH', 'Machine'), [Environment]::GetEnvironmentVariable('PATH', 'User') | Where-Object { $_ }) -join ';'
  $freshOk = $pathPersisted -and [bool](Find-Frely $freshPath)
  $inheritedOk = [bool](Find-Frely $inheritedPath)
  if (($env:PATH -split ';') -notcontains $directory) { $env:PATH = "$directory;$env:PATH" }
  $installedVersion = & $target --version
  Write-Output "Installed Frely $installedVersion at $target"
  # Another frely earlier on PATH (an old install elsewhere) would still win; warn when it is older than what was just installed.
  $first = Find-Frely $env:PATH
  if ($first -and ($first.Trim() -ne $target)) {
    $firstVersion = try { & $first.Trim() --version } catch { $null }
    if ($firstVersion -and ([string]$firstVersion).Trim() -ne ([string]$installedVersion).Trim()) {
      Write-Warning "'frely' on PATH resolves to $($first.Trim()) (version $firstVersion), not the one just installed ($installedVersion). Remove it or put $directory first on PATH, or run: `"$target`" <command>"
    }
  }
  if ($env:FRELY_INSTALL_NO_PROFILE -ne '1') {
    if ($freshOk -and $inheritedOk) { Say "Verified: 'frely' resolves from a new terminal and from this process." }
    elseif ($freshOk -and $shim) { Say "Verified: 'frely' resolves from a new terminal; this process' PATH was stale, so a forwarder was added at $shim (open a new terminal if 'frely' is still not found)." }
    else {
      Write-Warning "'frely' does not resolve from every shell yet."
      Write-Output "Run it by full path: `"$target`" <command>  (agents: use this path, do not reinstall)."
      Write-Output "Or fix PATH in this terminal:  `$env:PATH = `"$directory;`$env:PATH`""
      if (-not $pathPersisted) { Write-Output "The user PATH was not updated; add $directory to PATH manually." }
    }
  }
  Say 'Basic commands require no keyring setup. MCP authorization begins with frely link on.'
  # Sign-in step 1: the mail goes out now so the user only has to read the 6 digits back (finish with: frely login --code <code> --host <host>).
  if ($Email) {
    $loginArgs = @('login', '--email', $Email, '--no-wait'); if ($Quiet) { $loginArgs += '--quiet' }
    & $target @loginArgs
    if ($LASTEXITCODE -ne 0) { throw "Frely was installed, but the sign-in code could not be sent. Run: `"$target`" login --email $Email --no-wait" }
  }
} finally { Remove-Item -LiteralPath $stage -Recurse -Force }
