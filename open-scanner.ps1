$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverPath = Join-Path $projectRoot 'server.mjs'
$scannerUrl = 'http://127.0.0.1:8788'
$healthUrl = "$scannerUrl/api/symbols"
$logRoot = Join-Path $projectRoot 'logs'

function Test-ScannerRunning {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        return ($null -ne $response.count)
    } catch {
        return $false
    }
}

function Find-NodeExecutable {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        return $nodeCommand.Source
    }

    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode) {
        return $bundledNode
    }

    throw 'Node.js 20+ was not found. Install Node.js or add node.exe to PATH.'
}

if (-not (Test-ScannerRunning)) {
    $nodeExecutable = Find-NodeExecutable
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $stdoutLog = Join-Path $logRoot "scanner-$timestamp.log"
    $stderrLog = Join-Path $logRoot "scanner-$timestamp-error.log"

    $scannerProcess = Start-Process `
        -FilePath $nodeExecutable `
        -ArgumentList $serverPath `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutLog `
        -RedirectStandardError $stderrLog `
        -PassThru

    $started = $false
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        Start-Sleep -Milliseconds 250
        if (Test-ScannerRunning) {
            $started = $true
            break
        }
        if ($scannerProcess.HasExited) {
            break
        }
    }

    if (-not $started) {
        $details = if (Test-Path -LiteralPath $stderrLog) {
            (Get-Content -LiteralPath $stderrLog -Tail 20) -join [Environment]::NewLine
        } else {
            'No error log was produced.'
        }
        throw "Bybit Scanner could not start.`n$details`nLog: $stderrLog"
    }
}

Start-Process $scannerUrl

