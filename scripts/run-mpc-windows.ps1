$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$rustExe = Join-Path $repoRoot "mpc\frost-signer\target\release\dflow-frost-signer.exe"
$javaDir = Join-Path $repoRoot "java-mcp"
$logDir = Join-Path $env:TEMP "dflow-mpc"
$summaryLog = Join-Path $logDir "summary.log"

$participants = @(
    @{ Id = "p1"; HttpPort = 9001; GrpcPort = 10001 },
    @{ Id = "p2"; HttpPort = 9002; GrpcPort = 10002 },
    @{ Id = "p3"; HttpPort = 9003; GrpcPort = 10003 }
)

function Write-SummaryLog {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    Add-Content -Path $summaryLog -Value $line
    Write-Host $line
}

function Initialize-Logs {
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }

    Get-ChildItem -Path $logDir -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like "*.log" -or $_.Name -like "*.err" -or $_.Name -eq "summary.log"
    } | Remove-Item -Force -ErrorAction SilentlyContinue
}

function Invoke-WithRetry {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [int]$MaxRetries = 3
    )

    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            Write-SummaryLog "[retry] $Label attempt $attempt/$MaxRetries"
            return & $Action
        }
        catch {
            if ($attempt -ge $MaxRetries) {
                throw
            }
            Write-SummaryLog "[retry] $Label failed: $($_.Exception.Message)"
            Start-Sleep -Seconds 2
        }
    }
}

function Wait-ForHealthyParticipants {
    param([array]$Targets)

    foreach ($participant in $Targets) {
        $healthy = $false
        for ($attempt = 1; $attempt -le 30; $attempt++) {
            $httpOk = $false
            $grpcOk = $false

            try {
                $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$($participant.HttpPort)/health" -TimeoutSec 3 -UseBasicParsing
                if ($resp.StatusCode -eq 200) { $httpOk = $true }
            } catch {
                $httpOk = $false
            }

            try {
                $socket = New-Object System.Net.Sockets.TcpClient
                $socket.Connect("127.0.0.1", [int]$participant.GrpcPort)
                $socket.Close()
                $grpcOk = $true
            } catch {
                $grpcOk = $false
            }

            if ($httpOk -and $grpcOk) {
                $healthy = $true
                break
            }

            Start-Sleep -Seconds 1
        }

        if (-not $healthy) {
            throw "participant health check failed for $($participant.Id) on http $($participant.HttpPort) / grpc $($participant.GrpcPort)"
        }

        Write-SummaryLog "[health] OK: $($participant.Id) http=$($participant.HttpPort) grpc=$($participant.GrpcPort)"
    }
}

function Ensure-Preflight {
    if (-not (Test-Path $rustExe)) {
        throw "Rust binary not found: $rustExe. Build it first with: cargo build --release --manifest-path mpc/frost-signer/Cargo.toml"
    }

    if (-not (Test-Path (Join-Path $javaDir "pom.xml"))) {
        throw "Java project not found: $javaDir"
    }

    Push-Location $javaDir
    try {
        Write-SummaryLog "[java] compiling simulator artifacts"
        Invoke-WithRetry -Label "java compile" -Action {
            mvn -q -DskipTests compile
            if ($LASTEXITCODE -ne 0) { throw "mvn compile exited with code $LASTEXITCODE" }
        }
    }
    finally {
        Pop-Location
    }
}

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force | Out-Null
Unblock-File -Path $rustExe -ErrorAction SilentlyContinue
Initialize-Logs
Clear-StaleListeners
Write-SummaryLog "[start] launching MPC participant stack"

Ensure-Preflight

$procs = @()
foreach ($participant in $participants) {
    $logPath = Join-Path $logDir ("dflow-" + $participant.Id + ".log")
    $errPath = Join-Path $logDir ("dflow-" + $participant.Id + ".err")
    $args = @(
        "participant",
        "--participant-id", $participant.Id,
        "--host", "127.0.0.1",
        "--port", [string]$participant.HttpPort,
        "--grpc-port", [string]$participant.GrpcPort,
        "--threshold", "2",
        "--total", "3"
    )

    $proc = Start-Process -FilePath $rustExe -ArgumentList $args -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError $errPath -PassThru
    $procs += $proc
    Write-SummaryLog "[launch] started $($participant.Id) http=$($participant.HttpPort) grpc=$($participant.GrpcPort)"
}

Write-SummaryLog "[health] waiting for participant ports and readiness"
Wait-ForHealthyParticipants -Targets $participants

Write-SummaryLog "[java] running RoundSequenceSimulator"
$simResult = $null
Push-Location $javaDir
try {
    $simResult = Invoke-WithRetry -Label "java simulator" -Action {
        & mvn.cmd -q -DskipTests org.codehaus.mojo:exec-maven-plugin:3.1.0:java '-Dexec.mainClass=com.dflow.mpc.flow.RoundSequenceSimulator'
        if ($LASTEXITCODE -ne 0) { throw "java simulator exited with code $LASTEXITCODE" }
    }
}
finally {
    Pop-Location
}

Write-SummaryLog "[cleanup] stopping participant processes"
foreach ($proc in $procs) {
    if (-not $proc.HasExited) {
        $proc | Stop-Process -Force
    }
}

Write-SummaryLog "[summary] MPC stack finished successfully. Logs are in $logDir"
Write-SummaryLog "[summary] summary file: $summaryLog"
