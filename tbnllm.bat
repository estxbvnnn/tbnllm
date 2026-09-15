@echo off
REM Lanza tbnllm (app de escritorio)
title tbnllm
cd /d "%~dp0"

REM Arranca Ollama si no responde
curl -s http://127.0.0.1:11434/ >nul 2>&1
if errorlevel 1 (
  echo [*] Iniciando Ollama...
  start "" /min ollama serve
  timeout /t 3 >nul
)

echo [*] Abriendo tbnllm...
call npm start
