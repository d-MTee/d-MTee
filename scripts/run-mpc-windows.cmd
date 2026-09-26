@echo off
setlocal

set ROOT=%~dp0..
set POWERSHELL_EXE=powershell.exe
set BOOTSTRAP=%ROOT%\scripts\run-mpc-bootstrap.ps1

where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo [mpc] PowerShell not found on PATH
    exit /b 1
)

%POWERSHELL_EXE% -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%BOOTSTRAP%"
exit /b %ERRORLEVEL%
