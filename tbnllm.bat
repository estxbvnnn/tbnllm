@echo off
REM Lanza tbnllm (app de escritorio)
title tbnllm
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   No se encontro Node.js en este equipo.
  echo.
  echo   Este .bat es para correr tbnllm desde el codigo fuente y necesita
  echo   Node.js instalado ^(nodejs.org^).
  echo.
  echo   Si solo queres USAR la app en este PC, no hace falta instalar nada:
  echo   usa el .exe portable ^(tbnllm-portable\tbnllm.exe^) en su lugar.
  echo.
  pause
  exit /b 1
)

node loader.js
