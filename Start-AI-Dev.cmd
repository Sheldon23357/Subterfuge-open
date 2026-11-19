@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& '.\scripts\Invoke-Project.ps1' -Task 'ai:dev' -Arguments @('--console', '4400', '--store-directory', 'runtime\independent-agent', '--local-game-directory', 'runtime', '--local-player-port', '4311')"
pause
