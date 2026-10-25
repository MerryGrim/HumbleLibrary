@echo off
setlocal
cd /d "%~dp0source"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File BUILD.ps1
pause
