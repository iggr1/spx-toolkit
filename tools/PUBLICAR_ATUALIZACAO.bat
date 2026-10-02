@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Publicar-Atualizacao.ps1"
set ERR=%ERRORLEVEL%
echo.
if not "%ERR%"=="0" echo Falha ao publicar. Codigo: %ERR%
pause
exit /b %ERR%
