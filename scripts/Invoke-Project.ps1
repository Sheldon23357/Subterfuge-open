param([ValidateSet('ci','test','build','audit','test:reference','scenario:demo','fleet:demo','web:build','web:start','web:dev','lobby:start','ai:dev')][string]$Task = 'test',[Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$systemNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$selectedNode = $null
foreach ($candidate in @($systemNode, $bundledNode)) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
        $version = [version]((& $candidate --version).TrimStart('v'))
        if ($version -ge [version]'22.13.0') { $selectedNode = $candidate; break }
    }
}
if (-not $selectedNode) { throw 'Node.js 22.13 or newer is required. Install an LTS runtime and retry.' }
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$npmCli = Join-Path (Split-Path $npmCommand.Source -Parent) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path -LiteralPath $npmCli)) { throw "Cannot find npm CLI next to $($npmCommand.Source). Install Node.js with npm." }
$oldPath = $env:PATH
try {
    $env:PATH = (Split-Path $selectedNode -Parent) + [IO.Path]::PathSeparator + $oldPath
    Push-Location $projectRoot
    try {
        Write-Host "Runtime: $selectedNode"
        if ($Task -eq 'ci') { & $selectedNode $npmCli ci --no-audit --no-fund }
        elseif ($Arguments) { & $selectedNode $npmCli run $Task -- @Arguments }
        else { & $selectedNode $npmCli run $Task }
        if ($LASTEXITCODE -ne 0) { throw "Task failed: $Task ($LASTEXITCODE)" }
    } finally { Pop-Location }
} finally { $env:PATH = $oldPath }

