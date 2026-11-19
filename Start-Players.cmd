@echo off
cd /d "%~dp0"
set PLAYER_PORT=4311
set GAME_CLOCK=realtime
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Invoke-Project.ps1 web:start
pause
