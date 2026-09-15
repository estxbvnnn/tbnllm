@echo off
REM Lanza tbnllm (app de escritorio) desde el codigo fuente
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
  echo   ejecuta tbnllm.exe, en esta misma carpeta, en su lugar.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo   Primera vez por aqui: instalando dependencias con "npm install"...
  echo   Puede tardar unos minutos segun tu conexion.
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   "npm install" fallo — revisa el error de arriba ^(sin conexion a
    echo   internet? npm no encontrado?^) y volve a intentar.
    echo.
    pause
    exit /b 1
  )
  echo.
  echo   Listo. Abriendo tbnllm...
  echo.
)

node loader.js
