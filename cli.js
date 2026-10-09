#!/usr/bin/env node
// tbnllm — cliente de terminal (PowerShell / bash / zsh, lo mismo en Windows
// y Linux/macOS: es Node puro, sin dependencias). Habla directo con tu
// Ollama local, sin abrir la app de escritorio.
//
// Uso:
//   node cli.js               — elegís el modelo de una lista
//   node cli.js llama3.2       — arranca directo con ese modelo
//
// Dentro del chat: /help para ver los comandos.

'use strict';
const http = require('http');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const HOST_URL = new URL(OLLAMA_HOST);

// ── Paleta (la misma que --accent/--ok/--warn/--ink-3 de la app;
// nada de colores nuevos, para que se sienta parte del mismo producto) ──
const PAL = { red: [255, 59, 48], green: [63, 185, 80], amber: [210, 153, 34], gray: [130, 130, 130], dimmer: [90, 90, 90] };
const fg = (rgb, s) => `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m`;
const pill = (bgRgb, fgRgb, s) => `\x1b[48;2;${bgRgb[0]};${bgRgb[1]};${bgRgb[2]}m\x1b[38;2;${fgRgb[0]};${fgRgb[1]};${fgRgb[2]}m${s}\x1b[0m`;
const red = (s) => fg(PAL.red, s);
const green = (s) => fg(PAL.green, s);
const amber = (s) => fg(PAL.amber, s);
const dim = (s) => fg(PAL.gray, s);
const dimmer = (s) => fg(PAL.dimmer, s);
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const boldRed = (s) => bold(red(s));
const HIDE_CURSOR = '\x1b[?25l', SHOW_CURSOR = '\x1b[?25h';

function box(lines, width = 52) {
  return [
    dim('┌' + '─'.repeat(width) + '┐'),
    ...lines.map((l) => dim('│ ') + l + ' '.repeat(Math.max(0, width - 2 - visLen(l))) + dim(' │')),
    dim('└' + '─'.repeat(width) + '┘'),
  ].join('\n');
}
// Largo visible de un string con códigos ANSI adentro (para alinear el box).
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;

function apiRequest(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: HOST_URL.hostname, port: HOST_URL.port, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Ollama ${res.statusCode}: ${buf}`));
        try { resolve(buf ? JSON.parse(buf) : {}); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Petición con streaming NDJSON (usada por /api/chat y /api/pull). Devuelve
// el request (para poder abortarlo) y llama onLine por cada objeto recibido.
function apiStream(pathname, body, onLine) {
  const data = JSON.stringify(body);
  const req = http.request({
    hostname: HOST_URL.hostname, port: HOST_URL.port, path: pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => {
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { onLine(JSON.parse(line)); } catch { /* línea parcial */ }
      }
    });
  });
  req.write(data);
  req.end();
  return req;
}

async function ollamaVersion() {
  try { return (await apiRequest('GET', '/api/version')).version; } catch { return null; }
}

const fmtSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
};

// ── Spinner (braille) mientras se espera el primer token ───────────────
const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
function startSpinner(label) {
  let i = 0;
  process.stdout.write(HIDE_CURSOR);
  const render = () => process.stdout.write(`\r${red(SPIN_FRAMES[i])} ${dim(label)}` + ' '.repeat(6));
  render();
  const timer = setInterval(() => { i = (i + 1) % SPIN_FRAMES.length; render(); }, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write('\r' + ' '.repeat(label.length + 8) + '\r' + SHOW_CURSOR);
  };
}

const HELP = `
${bold('Comandos')}
  ${red('/model')} <nombre>   cambiar de modelo
  ${red('/models')}           listar modelos instalados
  ${red('/pull')} <nombre>    descargar un modelo nuevo
  ${red('/system')} [texto]   fijar (o borrar, sin texto) el system prompt
  ${red('/temp')} <n>         temperatura (0-2, actual: {{temp}})
  ${red('/ctx')} <n>          num_ctx (actual: {{ctx}})
  ${red('/new')}              borrar el historial de esta sesión
  ${red('/save')} <archivo>   guardar la conversación como .md
  ${red('/help')}             esta ayuda
  ${red('/exit')}             salir (o Ctrl+D)
  ${dimmer('Ctrl+C mientras el modelo responde: lo corta, sin cerrar la sesión.')}
`;

async function pickModel(rl, preselected) {
  const tags = await apiRequest('GET', '/api/tags').catch(() => ({ models: [] }));
  const models = tags.models || [];
  if (!models.length) {
    console.log(red('No tenés modelos instalados todavía.'));
    console.log(dim('Descargá uno con, por ejemplo: ') + bold('node cli.js') + dim(' y luego ') + red('/pull llama3.2'));
    return null;
  }
  if (preselected) {
    const hit = models.find((m) => m.name === preselected || m.name.startsWith(preselected + ':'));
    if (hit) return hit.name;
    console.log(red(`No encontré "${preselected}" entre tus modelos instalados.`));
  }
  console.log(bold('Modelos instalados'));
  console.log(dim('─'.repeat(40)));
  models.forEach((m, i) => {
    console.log(`  ${pill(PAL.red, [10, 10, 10], ' ' + (i + 1) + ' ')} ${bold(m.name)}  ${dim(fmtSize(m.size))}`);
  });
  const answer = await new Promise((res) => rl.question('\n' + dim('Elegí un número ') + dimmer('(Enter = el primero) ') + red('❯ '), res));
  const idx = answer.trim() ? parseInt(answer, 10) - 1 : 0;
  return models[idx] ? models[idx].name : models[0].name;
}

async function pullModel(name) {
  console.log(dim(`Descargando ${bold(name)}…`));
  const WIDTH = 28;
  await new Promise((resolve, reject) => {
    let lastPct = -1;
    const req = apiStream('/api/pull', { model: name, stream: true }, (obj) => {
      if (obj.total && obj.completed != null) {
        const pct = Math.floor((obj.completed / obj.total) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          const filled = Math.round((pct / 100) * WIDTH);
          const bar = red('█'.repeat(filled)) + dimmer('░'.repeat(WIDTH - filled));
          process.stdout.write(`\r  [${bar}] ${String(pct).padStart(3)}%  ${dim(fmtSize(obj.completed) + ' / ' + fmtSize(obj.total))}   `);
        }
      } else if (obj.status) {
        process.stdout.write(`\r  ${dim(obj.status)}` + ' '.repeat(30));
      }
      if (obj.error) reject(new Error(obj.error));
    });
    req.on('close', () => { process.stdout.write('\n'); resolve(); });
    req.on('error', reject);
  });
  console.log(green('✓') + ` ${bold(name)} listo.\n`);
}

function printStatus(connected, version, model, state) {
  const dot = connected ? green('●') : red('●');
  const brand = pill(PAL.red, [10, 10, 10], bold(' tbnllm '));
  const conn = connected ? dim(`v${version}`) : red('sin conexión');
  console.log(`${brand} ${dot} ${conn}  ${dimmer('│')}  ${bold(dim(model))}  ${dimmer('·')} ${dim('ctx ' + state.num_ctx)} ${dimmer('·')} ${dim('temp ' + state.temperature)}${state.system ? '  ' + dimmer('·') + ' ' + amber('system ✓') : ''}`);
}

async function main() {
  console.log();
  console.log(box([
    bold(red('tbnllm')) + dim('  — cliente de terminal'),
    dimmer('PowerShell / bash / zsh — mismo binario, sin nada extra'),
  ]));
  console.log();

  const version = await ollamaVersion();
  if (!version) {
    console.log(red('✗ No hay conexión con Ollama.'));
    console.log(dim('  Arrancalo con ') + bold('ollama serve') + dim(' (o abrí la app tbnllm, que lo hace sola) y reintentá.'));
    process.exit(1);
  }
  console.log(green('✓') + dim(` conectado — Ollama v${version}`));
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: boldRed('tú') + ' ' + red('❯') + ' ' });
  // Si stdin no es una terminal interactiva (pipe, script, CI) puede cerrarse
  // sola en cualquier momento; con esta guarda no explota con un stack trace,
  // simplemente termina como si hubieras apretado Ctrl+D.
  let closed = false;
  rl.on('close', () => { closed = true; console.log(dim('\nChau.')); process.exit(0); });
  const safePrompt = () => {
    if (closed) return;
    console.log();
    printStatus(true, version, model, state);
    rl.prompt();
  };

  let model = await pickModel(rl, process.argv[2]);
  if (closed) return;
  if (!model) process.exit(1);

  const state = { system: '', temperature: 0.7, num_ctx: 4096 };
  /** @type {{role:string, content:string}[]} */
  let history = [];
  let currentReq = null;

  console.log(dim(`\nModelo activo: `) + bold(model) + dim(` — /help para ver los comandos.`));
  safePrompt();

  rl.on('SIGINT', () => {
    if (currentReq) { currentReq.destroy(); currentReq = null; process.stdout.write('\n' + dim('(cortado)') + '\n'); safePrompt(); }
    else { console.log(dim('\nChau.')); process.exit(0); }
  });

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) { safePrompt(); return; }

    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(' ');
      const arg = rest.join(' ').trim();
      switch (cmd) {
        case 'help':
          console.log(HELP.replace('{{temp}}', state.temperature).replace('{{ctx}}', state.num_ctx));
          break;
        case 'models': {
          const tags = await apiRequest('GET', '/api/tags').catch(() => ({ models: [] }));
          (tags.models || []).forEach((m) => console.log(`  ${m.name === model ? green('●') : dimmer('○')} ${bold(m.name)}  ${dim(fmtSize(m.size))}`));
          break;
        }
        case 'model':
          if (!arg) { console.log(dim('Modelo activo: ') + bold(model)); break; }
          { const picked = await pickModel(rl, arg); if (picked) { model = picked; console.log(green('✓') + ` ahora usás ${bold(model)}`); } }
          break;
        case 'pull':
          if (!arg) { console.log(dim('Uso: /pull <nombre>')); break; }
          await pullModel(arg).catch((e) => console.log(red('✗ Error: ') + e.message));
          break;
        case 'system':
          state.system = arg;
          console.log(arg ? green('✓') + ' system prompt actualizado' : dim('system prompt borrado'));
          break;
        case 'temp': {
          const n = Number(arg);
          if (!Number.isFinite(n)) { console.log(dim('Uso: /temp <número entre 0 y 2>')); break; }
          state.temperature = n; console.log(green('✓') + ` temperatura: ${n}`);
          break;
        }
        case 'ctx': {
          const n = parseInt(arg, 10);
          if (!Number.isFinite(n) || n < 1) { console.log(dim('Uso: /ctx <número>')); break; }
          state.num_ctx = n; console.log(green('✓') + ` num_ctx: ${n}`);
          break;
        }
        case 'new':
          history = []; console.log(dim('Historial borrado.'));
          break;
        case 'save': {
          if (!arg) { console.log(dim('Uso: /save <archivo.md>')); break; }
          const md = history.map((m) => `**${m.role === 'user' ? 'Tú' : model}:**\n\n${m.content}\n`).join('\n---\n\n');
          fs.writeFileSync(path.resolve(arg), md, 'utf8');
          console.log(green('✓') + ` guardado en ${arg}`);
          break;
        }
        case 'exit': case 'quit':
          console.log(dim('Chau.')); process.exit(0);
          break; // eslint-disable-line no-unreachable
        default:
          console.log(red(`Comando desconocido: /${cmd}`) + dim(' — probá /help'));
      }
      safePrompt();
      return;
    }

    history.push({ role: 'user', content: text });
    const msgs = state.system ? [{ role: 'system', content: state.system }, ...history] : history;

    console.log();
    const stopSpin = startSpinner('pensando…');
    let acc = '';
    let printedHeader = false;
    const t0 = Date.now();

    await new Promise((resolve) => {
      currentReq = apiStream('/api/chat', { model, messages: msgs, stream: true, options: { temperature: state.temperature, num_ctx: state.num_ctx } }, (obj) => {
        const token = obj.message?.content || '';
        if (token) {
          if (!printedHeader) { stopSpin(); console.log(dim(model)); printedHeader = true; }
          acc += token;
          process.stdout.write(token);
        }
        if (obj.done) {
          if (!printedHeader) { stopSpin(); console.log(dim(model)); }
          const secs = (Date.now() - t0) / 1000;
          const tps = obj.eval_count && obj.eval_duration ? (obj.eval_count / (obj.eval_duration / 1e9)).toFixed(1) : null;
          process.stdout.write('\n' + dimmer(`  ▸ ${obj.eval_count ?? '?'} tokens` + (tps ? ` · ${tps} tok/s` : '') + ` · ${secs.toFixed(1)}s`) + '\n');
          currentReq = null;
          resolve();
        }
      });
      currentReq.on('error', (e) => {
        stopSpin();
        process.stdout.write(red('✗ Error: ') + e.message + '\n');
        currentReq = null; resolve();
      });
      currentReq.on('close', () => { if (currentReq) { stopSpin(); currentReq = null; resolve(); } });
    });

    if (acc) history.push({ role: 'assistant', content: acc });
    safePrompt();
  });
}

main().catch((e) => { console.error(red('Error fatal: ') + e.message); process.exit(1); });
