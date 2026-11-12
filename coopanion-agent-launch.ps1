param([string]$Runner, [string]$Agent, [string]$Hint)
$ErrorActionPreference = 'Stop'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:NODE_OPTIONS = ''
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$marker = '__COOPANION_RUNTIME_OK__'
$probe = "if (process.versions.electron || Number(process.versions.node.split('.')[0]) < 22 || typeof fetch !== 'function') process.exit(1); console.log('$marker')"
$candidates = [System.Collections.Generic.List[string]]::new()
$seen = @{}
$attempted = @{}
function Join-RuntimePath([string]$Base, [string]$Suffix) {
  try { [System.IO.Path]::Combine($Base, $Suffix) } catch { return '' }
}
function Add-Candidate([string]$Path) {
  if ($Path -and -not $seen.ContainsKey($Path)) { $seen[$Path] = $true; $candidates.Add($Path) }
}
function Invoke-Candidate([string]$Path) {
  if (-not $Path) { return }
  try { $leaf = [System.IO.Path]::GetFileName($Path) } catch { return }
  if ($leaf -notin @('node.exe', 'nodejs.exe') -or $attempted.ContainsKey($Path)) { return }
  $attempted[$Path] = $true
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction SilentlyContinue)) { return }
  if ($clock.ElapsedMilliseconds -ge 2000) { return }
  $process = [System.Diagnostics.Process]::new()
  try {
    $process.StartInfo.FileName = $Path
    $process.StartInfo.Arguments = '-e "' + $probe.Replace('"', '\"') + '"'
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    [void]$process.Start()
    $process.StandardInput.Close()
    $remaining = [Math]::Min(700, [Math]::Max(1, 2000 - $clock.ElapsedMilliseconds))
    if (-not $process.WaitForExit([int]$remaining)) { $process.Kill(); [void]$process.WaitForExit(100); return }
    $valid = $process.ExitCode -eq 0 -and $process.StandardOutput.ReadToEnd().Trim() -eq $marker
  } catch { $valid = $false } finally { $process.Dispose() }
  if (-not $valid) { return }
  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  ([System.IO.StreamReader]::new([Console]::OpenStandardInput(), $OutputEncoding)).ReadToEnd() | & $Path $Runner $Agent
  exit $LASTEXITCODE
}

foreach ($path in @($env:COOPANION_HOOK_NODE, $env:CODEBUDDY_NODE_BIN, $env:CODEBUDDY_CODE_NODE_PATH, $env:NODE_BINARY, $env:npm_node_execpath)) {
  Invoke-Candidate $path
}
if ($Agent -eq 'workbuddy') {
  $config = $env:WORKBUDDY_CONFIG_DIR
  if (-not $config) { $config = $env:CODEBUDDY_CONFIG_DIR }
  if (-not $config) { $config = Join-RuntimePath $env:USERPROFILE '.workbuddy' }
  $versions = Join-RuntimePath $config 'binaries/node/versions'
  $current = Get-Content -LiteralPath (Join-RuntimePath $versions 'current') -Raw -ErrorAction SilentlyContinue
  if ($current -and $current.Trim() -match '^\d+\.\d+\.\d+$') { Invoke-Candidate (Join-RuntimePath $versions ($current.Trim() + '/node.exe')) }
  Get-ChildItem -LiteralPath $versions -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Invoke-Candidate (Join-RuntimePath $_.FullName 'node.exe') }
  if ($env:WORKBUDDY_RESOURCES_PATH) { Invoke-Candidate (Join-RuntimePath $env:WORKBUDDY_RESOURCES_PATH 'runtime/node/node.exe') }
}

# Prefer an available PATH runtime before querying desktop process metadata.
foreach ($dir in ($env:PATH -split ';')) { if ($dir) { Invoke-Candidate (Join-RuntimePath $dir 'node.exe') } }

$agentPaths = @(Get-Command $Agent -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
foreach ($hive in @('HKCU:', 'HKLM:')) {
  $entry = Get-ItemProperty -LiteralPath "$hive\Software\Microsoft\Windows\CurrentVersion\App Paths\$Agent.exe" -ErrorAction SilentlyContinue
  if ($entry -and $entry.'(default)') { $agentPaths += $entry.'(default)' }
}
foreach ($agentPath in $agentPaths) {
  $bin = Split-Path -Parent $agentPath
  foreach ($root in @($bin, (Join-RuntimePath $bin '..'), (Join-RuntimePath $bin '../..'))) {
    foreach ($suffix in @('node.exe', 'bin/node.exe', 'resources/node.exe', 'resources/node/node.exe', 'resources/runtime/node/node.exe')) { Add-Candidate (Join-RuntimePath $root $suffix) }
  }
}
if ($env:NVM_HOME) { Get-ChildItem -LiteralPath $env:NVM_HOME -Directory -ErrorAction SilentlyContinue | ForEach-Object { Add-Candidate (Join-RuntimePath $_.FullName 'node.exe') } }
if ($env:FNM_MULTISHELL_PATH) { Add-Candidate (Join-RuntimePath $env:FNM_MULTISHELL_PATH 'node.exe') }
if ($env:VOLTA_HOME) { Add-Candidate (Join-RuntimePath $env:VOLTA_HOME 'bin/node.exe') }
if ($env:LOCALAPPDATA) { Add-Candidate (Join-RuntimePath $env:LOCALAPPDATA 'Volta/bin/node.exe') }
Add-Candidate $Hint
foreach ($candidate in $candidates) { Invoke-Candidate $candidate; if ($clock.ElapsedMilliseconds -ge 2000) { break } }
# Inspect only node.exe ancestors; desktop executables can disable Node mode.
$parent = $PID
for ($hop = 0; $hop -lt 4 -and $clock.ElapsedMilliseconds -lt 2000; $hop++) {
  try {
    $parentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $parent" -OperationTimeoutSec 1 -ErrorAction Stop
    if (-not $parentProcess -or $parentProcess.ParentProcessId -le 0) { break }
    $parent = $parentProcess.ParentProcessId
    if ($parentProcess.ExecutablePath -and [System.IO.Path]::GetFileName($parentProcess.ExecutablePath) -ieq 'node.exe') { Invoke-Candidate $parentProcess.ExecutablePath }
  } catch { break }
}
[Console]::Error.WriteLine("Coopanion $Agent hook: no compatible Node.js 22+ found in the agent environment, bundled runtime, PATH or installation hint (discovery budget: 2s).")
exit 127
