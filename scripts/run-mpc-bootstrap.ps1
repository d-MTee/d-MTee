$ErrorActionPreference = "Stop"
throw "DISTRIBUTED_FROST_NOT_IMPLEMENTED: bootstrap for placeholder participant rounds is disabled."

$repoRoot = Split-Path -Parent $PSScriptRoot
$rustRoot = "C:\Users\User\.cargo\bin"
$rustExe = Join-Path $repoRoot "mpc\frost-signer\target\release\dflow-frost-signer.exe"
$javaDir = Join-Path $repoRoot "java-mcp"
$logDir = Join-Path $env:TEMP "dflow-mpc"
$summaryLog = Join-Path $logDir "summary.log"

if (-not (Test-Path $rustRoot)) {
    throw "Rust toolchain not found under $rustRoot. Install Rust first via winget or rustup."
}

if (-not ($env:Path -split ';' | Where-Object { $_ -eq $rustRoot })) {
    $env:Path = "$rustRoot;$env:Path"
}

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

function Clear-StaleListeners {
    $ports = @(9001, 9002, 9003, 9101, 9102, 9103, 10001, 10002, 10003, 9090)
    $pids = @()

    foreach ($port in $ports) {
        try {
            $connections = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue
            if ($connections) {
                $pids += $connections | Select-Object -ExpandProperty OwningProcess
            }
        } catch {
            # ignore missing network stack information
        }
    }

    foreach ($candidatePid in ($pids | Sort-Object -Unique)) {
        try {
            $process = Get-Process -Id $candidatePid -ErrorAction Stop
            if ($process) {
                Write-SummaryLog "[cleanup] stopping stale process $($process.ProcessName) (pid $candidatePid)"
                Stop-Process -Id $candidatePid -Force -ErrorAction SilentlyContinue
            }
        } catch {
            # ignore already-terminated processes
        }
    }
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

$participants = @(
    @{ Id = "p1"; HttpPort = 9001; GrpcPort = 10001 },
    @{ Id = "p2"; HttpPort = 9002; GrpcPort = 10002 },
    @{ Id = "p3"; HttpPort = 9003; GrpcPort = 10003 }
)

Initialize-Logs
Clear-StaleListeners
Write-SummaryLog "[bootstrap] PATH updated to include $rustRoot"
Write-SummaryLog "[bootstrap] repo root: $repoRoot"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw "cargo is still not available in PATH after bootstrap. Check Rust installation."
}

Write-SummaryLog "[cargo] Rust toolchain detected: $(cargo --version)"

if (-not (Test-Path $rustExe)) {
    Write-SummaryLog "[rust] building signer binary"
    Push-Location (Join-Path $repoRoot "mpc\frost-signer")
    try {
        Invoke-WithRetry -Label "cargo build" -Action {
            cargo build --release --manifest-path Cargo.toml
            if ($LASTEXITCODE -ne 0) { throw "cargo build exited with code $LASTEXITCODE" }
        }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path $rustExe)) {
    throw "Rust binary still missing after build: $rustExe"
}

Write-SummaryLog "[rust] signer ready: $rustExe"

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

Write-SummaryLog "[health] waiting for all participant endpoints"
Wait-ForHealthyParticipants -Targets $participants

Write-SummaryLog "[java] running RoundSequenceSimulator"
Push-Location $javaDir
try {
    Invoke-WithRetry -Label "java simulator" -Action {
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

Write-SummaryLog "[summary] success: all participants healthy, Java simulator completed"
Write-SummaryLog "[summary] logs directory: $logDir"
