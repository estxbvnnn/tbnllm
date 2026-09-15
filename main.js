// tbnllm — Electron main process
// Handles the window and all HTTP traffic to the local Ollama server,
// so the renderer never hits CORS and streaming stays smooth.

const { app, BrowserWindow, ipcMain, dialog, shell, screen, Menu } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

// En algunos equipos/drivers la composición por GPU se traba y la ventana
// nunca llega a pintar su primer frame (ready-to-show no dispara y la app
// se queda invisible aunque el proceso corra bien). La UI es simple —
// no vale la pena arriesgar eso por aceleración de hardware.
app.disableHardwareAcceleration();

// Alto de la barra de título propia (debe coincidir con --titlebar en styles.css).
const TITLEBAR_HEIGHT = 40;
// Colores de la barra de título nativa (min/max/cerrar) por tema, a juego con
// --bg-1 / --ink-2 en styles.css. titleBarOverlay no entiende variables CSS.
const TITLEBAR_COLORS = {
  dark: { color: '#111111', symbolColor: '#9a9a9a' },
  light: { color: '#f0f0f0', symbolColor: '#555555' },
};

// Track in-flight chat streams so the UI can abort them.
const activeStreams = new Map();

let mainWindow = null;

// ─────────────────────────────────────────────
// Recuerda tamaño/posición de la ventana entre sesiones, y evita el
// "zoom" que se ve en Windows con escalado de pantalla si la ventana
// arranca sin maximizar: si no hay estado guardado, arranca maximizada.
// ─────────────────────────────────────────────
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; }
}
function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isMaximized = mainWindow.isMaximized();
  const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  try { fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, isMaximized })); } catch { /* no molesta */ }
}

function createWindow() {
  const saved = loadWindowState();
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(saved?.width || 1280, work.width);
  const height = Math.min(saved?.height || 860, work.height);

  mainWindow = new BrowserWindow({
    width,
    height,
    x: saved?.x,
    y: saved?.y,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0a0a0a',
    title: 'tbnllm',
    autoHideMenuBar: true,
    show: false,
    // Sin marco nativo: la propia interfaz dibuja la barra de título (a
    // juego con el resto del diseño) y sólo se conservan los botones de
    // minimizar/maximizar/cerrar, superpuestos y coloreados por tema.
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLEBAR_COLORS.dark, height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Sin estado previo (primer arranque), abre maximizada: evita el efecto
  // de "zoom"/recorte que deja una ventana sin maximizar en pantallas con
  // escalado de Windows activado.
  if (saved?.isMaximized || !saved) mainWindow.maximize();

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const showOnce = () => {
    if (mainWindow.isVisible()) return;
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1); // sin pellizco-zoom
    mainWindow.webContents.setZoomFactor(1);
    mainWindow.show();
  };
  mainWindow.once('ready-to-show', showOnce);
  // Red de seguridad: si por lo que sea "ready-to-show" nunca llega
  // (se ha visto trabarse por la composición de GPU en algunos equipos),
  // igual mostramos la ventana a los pocos segundos en vez de dejarla
  // invisible para siempre.
  setTimeout(showOnce, 4000);

  let saveTimer;
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 400); };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('close', saveWindowState);

  // Bloquea el zoom por teclado (Ctrl +/-/0) y por rueda del ratón.
  mainWindow.webContents.on('before-input-event', (e, input) => {
    if ((input.control || input.meta) && ['+', '-', '=', '0'].includes(input.key)) e.preventDefault();
  });
  mainWindow.webContents.on('zoom-changed', (e) => e.preventDefault());

  // Open external links in the system browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    e.preventDefault();
    shell.openExternal(url);
  });
}

app.setAppUserModelId('com.maicol.tbnllm');

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null); // sin menú clásico: la barra de título es propia
  createWindow();
  // Si Ollama no responde, intentamos arrancarlo en segundo plano.
  try { await ollamaGet('/api/version'); } catch { spawnOllama(); }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─────────────────────────────────────────────
// Ollama REST helpers
// ─────────────────────────────────────────────

async function ollamaGet(pathname) {
  const res = await fetch(`${OLLAMA_HOST}${pathname}`);
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return res.json();
}

// Comprobación rápida (milisegundos) de si el binario está en el PATH, para no
// hacer esperar 15s a quien directamente no tiene Ollama instalado.
function ollamaInstalled() {
  try {
    execFileSync('where', ['ollama'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Lanza `ollama serve` desprendido del proceso; si el binario no está, falla en silencio.
function spawnOllama() {
  try {
    const p = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForOllama(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { await ollamaGet('/api/version'); return true; } catch { /* aún no */ }
    await new Promise(r => setTimeout(r, 700));
  }
  return false;
}

ipcMain.handle('ollama:start', async () => {
  if (!ollamaInstalled()) {
    return {
      ok: false,
      notInstalled: true,
      error: 'No se encontró Ollama en este equipo. Instálalo desde ollama.com/download y volvé a intentar.',
    };
  }
  if (!spawnOllama()) return { ok: false, error: 'No se pudo lanzar ollama.' };
  const ok = await waitForOllama(15000);
  return ok ? { ok: true } : { ok: false, error: 'Ollama no respondió. ¿Está instalado y en el PATH?' };
});

ipcMain.handle('ollama:installed', () => ollamaInstalled());

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('ollama:version', async () => {
  try {
    const data = await ollamaGet('/api/version');
    return { ok: true, version: data.version };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ollama:tags', async () => {
  try {
    const data = await ollamaGet('/api/tags');
    return { ok: true, models: data.models || [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ollama:ps', async () => {
  try {
    const data = await ollamaGet('/api/ps');
    return { ok: true, models: data.models || [] };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ollama:show', async (_e, name) => {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    return { ok: true, info: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('ollama:delete', async (_e, name) => {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ─────────────────────────────────────────────
// Streaming: pull a model, forwarding progress
// ─────────────────────────────────────────────

ipcMain.handle('ollama:pull', async (event, name) => {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          event.sender.send('ollama:pull-progress', { name, ...obj });
        } catch { /* partial line, ignore */ }
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ─────────────────────────────────────────────
// Streaming: chat, token by token, with abort support
// ─────────────────────────────────────────────

ipcMain.handle('ollama:chat', async (event, { streamId, model, messages, options }) => {
  const controller = new AbortController();
  activeStreams.set(streamId, controller);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, options: options || {} }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const token = obj.message?.content || '';
          if (token) event.sender.send('ollama:chat-token', { streamId, token });
          if (obj.done) {
            event.sender.send('ollama:chat-done', {
              streamId,
              stats: {
                total_duration: obj.total_duration,
                eval_count: obj.eval_count,
                eval_duration: obj.eval_duration,
                prompt_eval_count: obj.prompt_eval_count,
              },
            });
          }
        } catch { /* partial line */ }
      }
    }
    return { ok: true };
  } catch (e) {
    if (e.name === 'AbortError') {
      event.sender.send('ollama:chat-done', { streamId, aborted: true });
      return { ok: true, aborted: true };
    }
    event.sender.send('ollama:chat-error', { streamId, error: String(e.message || e) });
    return { ok: false, error: String(e.message || e) };
  } finally {
    activeStreams.delete(streamId);
  }
});

ipcMain.handle('ollama:stop', async (_e, streamId) => {
  const controller = activeStreams.get(streamId);
  if (controller) controller.abort();
  return { ok: true };
});

// ─────────────────────────────────────────────
// System performance stats (CPU / RAM / GPU)
// ─────────────────────────────────────────────

let prevCpu = null;
function cpuSnapshot() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  }
  return { idle, total };
}
function cpuPercent() {
  const cur = cpuSnapshot();
  if (!prevCpu) { prevCpu = cur; return 0; }
  const idleDiff = cur.idle - prevCpu.idle;
  const totalDiff = cur.total - prevCpu.total;
  prevCpu = cur;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
}

// Query NVIDIA GPU via nvidia-smi if available. Resolves to null otherwise.
function gpuStats() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
       '--format=csv,noheader,nounits'],
      { timeout: 2500, windowsHide: true }, // si no, Windows abre una consola visible cada vez
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const line = stdout.trim().split('\n')[0];
        const [name, util, memUsed, memTotal, temp] = line.split(',').map(s => s.trim());
        resolve({
          name,
          util: Number(util),
          memUsed: Number(memUsed) * 1024 * 1024,
          memTotal: Number(memTotal) * 1024 * 1024,
          temp: Number(temp),
        });
      }
    );
  });
}

ipcMain.handle('sys:stats', async () => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const gpu = await gpuStats();
  return {
    cpu: cpuPercent(),
    cores: os.cpus().length,
    cpuModel: (os.cpus()[0] && os.cpus()[0].model || '').trim(),
    ram: { total: totalMem, used: totalMem - freeMem, free: freeMem },
    gpu,
    platform: `${(() => { try { return os.version(); } catch { return os.type(); } })()} · ${os.arch()}`,
  };
});

ipcMain.handle('ui:titlebar-theme', (_e, theme) => {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.setTitleBarOverlay) return;
  const colors = TITLEBAR_COLORS[theme] || TITLEBAR_COLORS.dark;
  mainWindow.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT });
});

ipcMain.handle('ui:confirm', async (_e, { title, message, detail }) => {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancelar', 'Confirmar'],
    defaultId: 0,
    cancelId: 0,
    title: title || 'Confirmar',
    message: message || '¿Estás seguro?',
    detail: detail || '',
  });
  return response === 1;
});
