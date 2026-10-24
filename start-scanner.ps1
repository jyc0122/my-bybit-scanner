$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if ($nodeCommand) {
    $nodeExecutable = $nodeCommand.Source
} elseif (Test-Path -LiteralPath $bundledNode) {
    $nodeExecutable = $bundledNode
} else {
    throw 'Node.js 20+ was not found. Install Node.js or add node.exe to PATH.'
}
Write-Host 'Starting Bybit EMA Touch Scanner at http://127.0.0.1:8788'
Write-Host 'Keep this window open while using the scanner.'
& $nodeExecutable .\server.mjs
