#!/usr/bin/env node
// tbnllm — loader de consola.
// Arranca Ollama si hace falta y abre la app, con una animación propia
// en vez de las líneas sueltas de antes. Sin dependencias: solo Node.

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { spawn } = require('child_process');

const ROOT = __dirname;
const OLLAMA_URL = 'http://127.0.0.1:11434/';
const BAR_WIDTH = 28;

// ── Colores (ANSI de 24 bits, a juego con --accent de la app) ──────────
const amber = (s) => `\x1b[38;2;226;160;74m${s}\x1b[0m`;
const amberBold = (s) => `\x1b[1m\x1b[38;2;226;160;74m${s}\x1b[0m`;
const dim = (s) => `\x1b[38;2;109;103;94m${s}\x1b[0m`;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

// Gato pequeño en ASCII puro (sin unicode: se ve igual en cualquier consola).
const CAT = [
  '    /\\_/\\',
  '   ( o.o )',
  '    > ^ <',
  '   /|   |\\',
  '  (_|   |_)',
];

function printMascot() {
  console.log();
  for (const line of CAT) console.log('   ' + amber(line));
  console.log('   ' + amberBold('t b n l l m'));
  console.log('   ' + dim('tu cliente local de Ollama'));
  console.log();
}

// ── Barra de progreso 0-100%, con avance suave hacia el objetivo ───────
function ProgressBar() {
  let current = 0;
  let target = 0;
  let label = '';
  let timer = null;

  function render() {
    const pct = Math.round(current);
    const filled = Math.round((current / 100) * BAR_WIDTH);
    const bar = '#'.repeat(filled) + '-'.repeat(BAR_WIDTH - filled);
    const line = `   ${amber('[' + bar + ']')} ${String(pct).padStart(3)}%  ${label}`;
    process.stdout.write('\r' + line + ' '.repeat(10));
  }

  return {
    pct() { return current; },
    start(initialLabel) {
      label = initialLabel;
      process.stdout.write(HIDE_CURSOR);
      render();
      timer = setInterval(() => {
        if (current < target) { current = Math.min(target, current + 3); render(); }
      }, 20);
    },
    to(pct, newLabel) {
      target = Math.max(target, pct);
      if (newLabel) label = newLabel;
    },
    jump(pct, newLabel) {
      target = pct; current = pct;
      if (newLabel) label = newLabel;
      render();
    },
    // Deja que la barra alcance el 100% animada (no salta de golpe) antes de cerrar.
    async finish(finalLabel) {
      target = 100; label = finalLabel;
      while (current < 100) await new Promise((r) => setTimeout(r, 20));
      clearInterval(timer);
      render();
      process.stdout.write('\n' + SHOW_CURSOR);
    },
    fail(message) {
      clearInterval(timer);
      process.stdout.write('\r' + ' '.repeat(BAR_WIDTH + 40) + '\r');
      console.log('   ' + dim('✗ ' + message));
      process.stdout.write(SHOW_CURSOR);
    },
  };
}

function ollamaUp(timeout = 1200) {
  return new Promise((resolve) => {
    const req = http.get(OLLAMA_URL, { timeout }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// `hideConsole` aplica CREATE_NO_WINDOW: sirve para binarios de consola como
// ollama.exe. Nunca usar al lanzar Electron — también le oculta la ventana
// gráfica de la app, no solo una consola (era el bug: la app no abría).
function spawnDetached(cmd, args, { hideConsole = false } = {}) {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: hideConsole });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

// Como spawnDetached, pero espera un poco a ver si el proceso sigue vivo
// antes de darlo por lanzado — así detectamos si algo lo mata al toque
// (crash, o un antivirus bloqueándolo) en vez de mentir con "iniciado".
function spawnAndVerify(cmd, args, verifyMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    let p;
    try {
      p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      finish({ ok: false, reason: e.message });
      return;
    }
    p.on('error', (e) => finish({ ok: false, reason: e.message }));
    p.on('exit', (code, signal) => finish({
      ok: false,
      reason: `el proceso terminó solo (código ${code}${signal ? ', señal ' + signal : ''}) — puede que el antivirus lo haya bloqueado`,
    }));
    setTimeout(() => {
      if (!settled) { p.unref(); finish({ ok: true, pid: p.pid }); }
    }, verifyMs);
  });
}

function waitKey(message) {
  return new Promise((resolve) => {
    process.stdout.write('\n   ' + dim(message));
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.once('data', () => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    });
  });
}

async function waitForOllama(bar, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await ollamaUp()) return true;
    const frac = (Date.now() - t0) / maxMs;
    bar.to(20 + Math.round(frac * 45)); // 20% → 65% mientras espera
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  printMascot();
  const bar = ProgressBar();
  bar.start('Comprobando Ollama…');
  bar.to(15);
  await new Promise((r) => setTimeout(r, 150));

  if (await ollamaUp()) {
    bar.to(65, 'Ollama ya estaba en marcha');
  } else {
    bar.to(20, 'Iniciando Ollama…');
    spawnDetached('ollama', ['serve'], { hideConsole: true }); // ollama.exe: sí es consola
    const up = await waitForOllama(bar, 12000);
    bar.to(65, up ? 'Ollama listo' : 'Ollama tardó — la app reintentará sola');
  }
  await new Promise((r) => setTimeout(r, 200));

  bar.to(75, 'Abriendo tbnllm…');
  await new Promise((r) => setTimeout(r, 300));

  const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronBin)) {
    bar.fail(`No está "${electronBin}" — corré "npm install" en esta carpeta.`);
    await waitKey('Presiona una tecla para cerrar…');
    process.exitCode = 1;
    return;
  }

  bar.to(85, 'Abriendo tbnllm… (comprobando que arranque)');
  const creep = setInterval(() => bar.to(Math.min(89, Math.round(bar.pct()) + 1)), 300);
  const result = await spawnAndVerify(electronBin, [ROOT]); // sin hideConsole: es una app gráfica
  clearInterval(creep);
  if (!result.ok) {
    bar.fail('tbnllm no arrancó: ' + result.reason);
    await waitKey('Presiona una tecla para cerrar…');
    process.exitCode = 1;
    return;
  }

  await bar.finish('tbnllm iniciado');
  console.log();
}

main().catch(async (e) => {
  console.error(dim('Error al iniciar: ' + (e && e.message || e)));
  await waitKey('Presiona una tecla para cerrar…');
  process.exitCode = 1;
});
