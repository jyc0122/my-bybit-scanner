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
& $nodeExecutable --check .\server.mjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $nodeExecutable --check .\public\app.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $nodeExecutable --test .\test\scanner.test.mjs
exit $LASTEXITCODE
