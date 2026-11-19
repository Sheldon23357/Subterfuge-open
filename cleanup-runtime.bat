@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if /i "%~1"=="--dry-run" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cleanup-runtime.ps1" -DryRun
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cleanup-runtime.ps1" %*
)
set "cleanup_exit=%errorlevel%"
echo.
if not "%cleanup_exit%"=="0" echo 清理未完成，请查看上方提示。
pause
exit /b %cleanup_exit%
