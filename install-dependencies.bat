@echo off
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"
if not defined GWRM_CONFIG set "GWRM_CONFIG=%SCRIPT_DIR%gwrm.config.json"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install-dependencies.ps1" -ConfigPath "%GWRM_CONFIG%"
exit /b %ERRORLEVEL%
