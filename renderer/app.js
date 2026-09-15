/* tbnllm — lógica del renderer */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

marked.setOptions({ breaks: true, gfm: true });
const renderMd = (text) => DOMPurify.sanitize(marked.parse(text || ''));

// ── Estado ───────────────────────────────────────────────────
const store = {
  load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio */ } },
};

let chats = store.load('chats', []);          // [{id, title, messages:[{role, content, model?, stats?}]}]
let activeChatId = store.load('activeChat', null);
let currentModel = store.load('model', '');
let settings = Object.assign({ system: '', temperature: 0.7, num_ctx: 4096 }, store.load('settings', {}));
let lastGen = store.load('lastGen', null);
let view = 'chat';
let connected = false;
let streaming = false;
let currentStreamId = null;
let live = null;                               // {chat, assistant, contentEl, acc} durante una generación
let genStart = 0, genTokens = 0;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const activeChat = () => chats.find(c => c.id === activeChatId);
const persist = () => { store.save('chats', chats); store.save('activeChat', activeChatId); };
const shortModel = (n) => (n || '').replace(/:latest$/, '');

const fmtSize = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i >= 2 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
};
const fmtDate = (s) => {
  try { return new Date(s).toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return ''; }
};
const fmtTime = (s) => {
  try { return new Date(s).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
};

// ── Aviso ────────────────────────────────────────────────────
let toastTimer;
function toast(msg, isErr) {
  let t = $('#toast');
  if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (isErr ? ' toast--error' : '');
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Conexión ─────────────────────────────────────────────────
let connTimer;
let ollamaIsInstalled = true; // optimista hasta comprobar lo contrario
const DOWNLOAD_URL = 'https://ollama.com/download';

function updateOllamaCta() {
  const btn = $('#start-ollama');
  btn.hidden = connected;
  if (connected) return;
  btn.textContent = ollamaIsInstalled ? 'Iniciar Ollama' : 'Descargar Ollama';
}

async function checkConnection() {
  const res = await window.ollama.version();
  const was = connected;
  connected = !!res.ok;
  const c = $('#conn');
  c.className = 'conn ' + (connected ? 'is-ok' : 'is-bad');
  $('#conn-text').textContent = connected ? 'v' + res.version : 'sin conexión';
  if (!connected) ollamaIsInstalled = await window.ollama.installed();
  updateOllamaCta();
  $('#usage-live').classList.toggle('is-on', connected);
  if (connected && !was) { loadModels(); pollRunning(); }
  if (!connected && was) { runningModels = []; renderRunningEverywhere(); }
  if (connected !== was && !activeChat()?.messages.length) renderMessages();
  clearTimeout(connTimer);
  connTimer = setTimeout(checkConnection, connected ? 15000 : 4000);
}

async function startOllama() {
  if (!ollamaIsInstalled) { window.open(DOWNLOAD_URL); return; }
  const b = $('#start-ollama');
  b.disabled = true; b.textContent = 'Iniciando…';
  const res = await window.ollama.start();
  b.disabled = false;
  if (!res.ok) {
    if (res.notInstalled) ollamaIsInstalled = false;
    toast(res.error, true);
  }
  updateOllamaCta();
  checkConnection();
}

// ── Modelos disponibles ──────────────────────────────────────
let models = [];
async function loadModels() {
  const res = await window.ollama.tags();
  if (!res.ok) { toast('No se pudo listar modelos: ' + res.error, true); return []; }
  models = res.models;
  const sel = $('#model-select');
  sel.innerHTML = '';
  if (!models.length) {
    const o = el('option', null, 'sin modelos instalados'); o.value = ''; sel.appendChild(o);
  }
  for (const m of models) { const o = el('option', null, shortModel(m.name)); o.value = m.name; sel.appendChild(o); }
  if (currentModel && models.some(m => m.name === currentModel)) sel.value = currentModel;
  else { currentModel = models[0]?.name || ''; sel.value = currentModel; store.save('model', currentModel); }
  updateComposerMeta();
  if (!activeChat()?.messages.length) renderMessages();
  return models;
}

function setModel(name) {
  currentModel = name;
  store.save('model', name);
  $('#model-select').value = name;
  updateComposerMeta();
}

function updateComposerMeta() {
  const parts = [];
  parts.push(currentModel ? shortModel(currentModel) : 'sin modelo');
  parts.push('ctx ' + settings.num_ctx);
  parts.push('temp ' + Number(settings.temperature).toFixed(1));
  if (settings.system.trim()) parts.push('system ✓');
  $('#composer-meta').textContent = parts.join(' · ');
}

// ── Lista de conversaciones ──────────────────────────────────
function renderChatList() {
  const list = $('#chat-list');
  list.innerHTML = '';
  if (!chats.length) { list.appendChild(el('div', 'chat-empty', 'Todavía no hay conversaciones.')); return; }
  for (const c of chats) {
    const item = el('div', 'chat-item' + (c.id === activeChatId ? ' is-active' : ''));
    const title = el('span', 'title', c.title || 'Sin título');
    const del = el('button', 'del', '×');
    del.title = 'Eliminar';
    del.onclick = (e) => {
      e.stopPropagation();
      if (del.dataset.armed) { deleteChat(c.id); return; }
      del.dataset.armed = '1'; del.textContent = '¿borrar?';
      setTimeout(() => { delete del.dataset.armed; del.textContent = '×'; }, 2500);
    };
    title.ondblclick = (e) => { e.stopPropagation(); renameChat(c, item, title); };
    item.append(title, del);
    item.onclick = () => selectChat(c.id);
    list.appendChild(item);
  }
}

function renameChat(chat, item, titleEl) {
  const input = el('input', 'rename');
  input.value = chat.title || '';
  input.maxLength = 80;
  const finish = (save) => {
    if (save && input.value.trim()) chat.title = input.value.trim();
    persist(); renderChatList();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
  item.replaceChild(input, titleEl);
  input.focus(); input.select();
}

function selectChat(id) {
  activeChatId = id; persist();
  renderChatList(); renderMessages();
  if (view !== 'chat') switchView('chat');
}

function newChat() {
  const empty = chats.find(c => !c.messages.length);
  if (empty) { selectChat(empty.id); $('#input').focus(); return; }
  const c = { id: uid(), title: '', messages: [], created: Date.now() };
  chats.unshift(c); activeChatId = c.id; persist();
  renderChatList(); renderMessages();
  if (view !== 'chat') switchView('chat');
  $('#input').focus();
}

function deleteChat(id) {
  if (live && live.chat.id === id && currentStreamId) window.ollama.stop(currentStreamId);
  chats = chats.filter(c => c.id !== id);
  if (activeChatId === id) activeChatId = chats[0]?.id ?? null;
  persist(); renderChatList(); renderMessages();
}

// ── Mensajes ─────────────────────────────────────────────────
function renderMessages() {
  const box = $('#messages');
  box.innerHTML = '';
  const chat = activeChat();
  if (!chat || !chat.messages.length) { box.appendChild(renderEmpty()); return; }
  const thread = el('div', 'thread');
  chat.messages.forEach((m, i) => thread.appendChild(renderMessage(m, chat, i === chat.messages.length - 1)));
  box.appendChild(thread);
  scrollBottom();
}

function renderEmpty() {
  const e = el('div', 'empty');
  const h = el('h2', null, 'Habla con tus modelos.');
  const p = el('p', null, 'Todo se ejecuta en este equipo a través de Ollama; nada sale de aquí.');
  e.append(h, p);
  if (!connected) {
    const warn = el('div', 'warn');
    if (ollamaIsInstalled) {
      warn.textContent = 'No hay conexión con Ollama. Arráncalo desde el lateral o ejecutá «ollama serve» en una terminal.';
    } else {
      warn.append('No se encontró Ollama en este equipo. ');
      const a = el('a', null, 'Descargalo en ollama.com');
      a.href = DOWNLOAD_URL;
      warn.appendChild(a);
      warn.append(' — es gratis y corre todo en local.');
    }
    e.appendChild(warn);
  } else if (!models.length) {
    e.appendChild(el('div', 'warn', 'No hay modelos instalados. Descarga uno desde la pestaña Modelos, por ejemplo «llama3.2».'));
  }
  const keys = el('dl', 'keys');
  for (const [k, v] of [['Enter', 'enviar'], ['Shift + Enter', 'salto de línea'], ['Esc', 'detener la generación'], ['Ctrl + N', 'nueva conversación'], ['doble clic', 'renombrar una conversación']]) {
    keys.append(el('dt', null, k), el('dd', null, v));
  }
  e.appendChild(keys);
  return e;
}

function renderMessage(m, chat, isLast) {
  const wrap = el('div', 'msg msg--' + m.role);
  const who = el('div', 'who', m.role === 'user' ? 'tú' : shortModel(m.model) || 'modelo');
  who.title = m.role === 'user' ? '' : (m.model || '');
  const body = el('div', 'body');
  const content = el('div', 'content');
  if (m.role === 'user') content.textContent = m.content;
  else if (m.error) { content.classList.add('is-error'); content.textContent = m.content; }
  else content.innerHTML = renderMd(m.content);
  body.appendChild(content);

  const foot = el('div', 'msg-foot');
  if (m.stats) foot.appendChild(el('span', null, m.stats));
  const actions = el('span', 'actions');
  const copy = el('button', null, 'copiar');
  copy.onclick = () => { navigator.clipboard.writeText(m.content); copy.textContent = 'copiado'; setTimeout(() => copy.textContent = 'copiar', 1200); };
  actions.appendChild(copy);
  if (m.role === 'assistant' && isLast) {
    const regen = el('button', null, 'regenerar');
    regen.onclick = () => regenerate();
    actions.appendChild(regen);
  }
  foot.appendChild(actions);
  body.appendChild(foot);

  wrap.append(who, body);
  enhanceCodeBlocks(content);
  return wrap;
}

function enhanceCodeBlocks(container) {
  container.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.copy-code')) return;
    const btn = el('button', 'copy-code', 'copiar');
    btn.onclick = () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText((code ? code.innerText : pre.innerText).trim());
      btn.textContent = 'copiado'; setTimeout(() => btn.textContent = 'copiar', 1200);
    };
    pre.appendChild(btn);
  });
}

function scrollBottom() { const b = $('#messages'); b.scrollTop = b.scrollHeight; }

// ── Generación ───────────────────────────────────────────────
function sendMessage(text) {
  if (!connected) { toast('Ollama no está en marcha', true); return; }
  if (!currentModel) { toast('Instala o selecciona un modelo primero', true); return; }
  let chat = activeChat();
  if (!chat) { newChat(); chat = activeChat(); }
  chat.messages.push({ role: 'user', content: text });
  if (!chat.title) { chat.title = text.replace(/\s+/g, ' ').slice(0, 48); renderChatList(); }
  generate(chat);
}

function regenerate() {
  if (streaming) return;
  const chat = activeChat();
  if (!chat) return;
  const last = chat.messages[chat.messages.length - 1];
  if (last?.role === 'assistant') chat.messages.pop();
  if (!chat.messages.some(m => m.role === 'user')) return;
  generate(chat);
}

async function generate(chat) {
  const msgs = [];
  if (settings.system.trim()) msgs.push({ role: 'system', content: settings.system });
  for (const m of chat.messages) if (!m.error) msgs.push({ role: m.role, content: m.content });

  const assistant = { role: 'assistant', content: '', model: currentModel };
  chat.messages.push(assistant);
  persist();
  renderMessages();

  const nodes = $('#messages').querySelectorAll('.msg');
  const contentEl = nodes[nodes.length - 1].querySelector('.content');
  contentEl.classList.add('is-streaming', 'is-waiting');

  setStreaming(true);
  currentStreamId = uid();
  genStart = performance.now(); genTokens = 0;
  $('#live-speed').hidden = false; $('#live-tps').textContent = '0';
  live = { chat, assistant, contentEl, acc: '' };

  const res = await window.ollama.chat({
    streamId: currentStreamId,
    model: currentModel,
    messages: msgs,
    options: { temperature: Number(settings.temperature), num_ctx: Number(settings.num_ctx) },
  });
  // Los tokens y el cierre llegan por eventos; aquí solo cubrimos el fallo inmediato.
  if (res && res.ok === false && !res.aborted && live && live.assistant === assistant) {
    finishStream({ error: res.error });
  }
}

function setStreaming(on) {
  streaming = on;
  $('#send-btn').hidden = on;
  $('#stop-btn').hidden = !on;
  $('#usage-live').classList.toggle('is-busy', on);
}

function finishStream({ stats, aborted, error } = {}) {
  if (!live) return;
  const { chat, assistant, contentEl } = live;
  contentEl.classList.remove('is-streaming', 'is-waiting');
  if (error) {
    assistant.content = error; assistant.error = true;
    contentEl.classList.add('is-error'); contentEl.textContent = error;
    toast('Error: ' + error, true);
  } else if (aborted && !assistant.content) {
    assistant.content = '(detenido antes de responder)'; assistant.error = true;
    contentEl.classList.add('is-error'); contentEl.textContent = assistant.content;
  }
  if (stats && stats.eval_count && stats.eval_duration) {
    const tps = stats.eval_count / (stats.eval_duration / 1e9);
    assistant.stats = `${stats.eval_count} tokens · ${tps.toFixed(1)} tok/s`;
    lastGen = {
      tps: tps.toFixed(1),
      tokens: stats.eval_count,
      prompt: stats.prompt_eval_count ?? '–',
      time: stats.total_duration ? (stats.total_duration / 1e9).toFixed(1) + ' s' : '–',
      model: currentModel,
    };
    store.save('lastGen', lastGen);
    renderLastGen();
  }
  $('#live-speed').hidden = true;
  persist();
  setStreaming(false);
  live = null; currentStreamId = null;
  if (activeChat() === chat) renderMessages();
}

window.ollama.onChatToken(({ streamId, token }) => {
  if (streamId !== currentStreamId || !live) return;
  if (!live.contentEl.isConnected && activeChat() === live.chat) {
    // El usuario volvió a esta conversación: reengancharse al último nodo.
    const nodes = $('#messages').querySelectorAll('.msg .content');
    const n = nodes[nodes.length - 1];
    if (n) { live.contentEl = n; n.classList.add('is-streaming'); n.classList.toggle('is-waiting', !live.acc); }
  }
  live.acc += token;
  live.assistant.content = live.acc;
  live.contentEl.classList.remove('is-waiting');
  if (live.contentEl.isConnected) live.contentEl.innerHTML = renderMd(live.acc);
  genTokens++;
  const secs = (performance.now() - genStart) / 1000;
  if (secs > 0.3) $('#live-tps').textContent = (genTokens / secs).toFixed(1);
  if (live.contentEl.isConnected) scrollBottom();
});
window.ollama.onChatDone(({ streamId, stats, aborted }) => {
  if (streamId !== currentStreamId) return;
  finishStream({ stats, aborted });
});
window.ollama.onChatError(({ streamId, error }) => {
  if (streamId !== currentStreamId) return;
  finishStream({ error });
});

// ── Gestor de modelos ────────────────────────────────────────
async function renderModelsView() {
  const box = $('#models-table');
  if (!box.children.length) box.innerHTML = '<p class="none">Cargando…</p>';
  const [tagsRes] = await Promise.all([window.ollama.tags(), pollRunning()]);
  box.innerHTML = '';
  if (!tagsRes.ok) { box.appendChild(el('p', 'none', 'Error: ' + tagsRes.error)); return; }
  models = tagsRes.models;
  $('#models-count').textContent = models.length ? String(models.length) : '';
  if (!models.length) { box.appendChild(el('p', 'none', 'No hay modelos instalados todavía.')); return; }

  const table = el('table', 'table');
  table.innerHTML = '<thead><tr><th>Modelo</th><th class="num">Tamaño</th><th class="num">Parámetros</th><th class="num">Cuantización</th><th class="num">Modificado</th><th></th></tr></thead>';
  const tbody = el('tbody');
  for (const m of models) {
    const tr = el('tr', m.name === currentModel ? 'is-current' : '');
    tr.append(
      el('td', 'name', m.name),
      el('td', 'num', fmtSize(m.size)),
      el('td', 'num', m.details?.parameter_size || '–'),
      el('td', 'num', m.details?.quantization_level || '–'),
      el('td', 'num', fmtDate(m.modified_at)),
    );
    const actions = el('div', 'actions');
    const use = el('button', 'btn btn--quiet', 'Usar');
    use.onclick = () => { setModel(m.name); renderModelsView(); toast('Modelo activo: ' + shortModel(m.name)); };
    const info = el('button', 'btn btn--quiet', 'Detalles');
    info.onclick = () => toggleDetails(tr, m.name);
    const del = el('button', 'btn btn--quiet btn--danger', 'Eliminar');
    del.onclick = () => deleteModel(m.name);
    actions.append(use, info, del);
    const tdA = el('td'); tdA.appendChild(actions); tr.appendChild(tdA);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
}

async function toggleDetails(tr, name) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  const row = el('tr', 'detail');
  const td = el('td'); td.colSpan = 6;
  td.appendChild(el('span', 'loading', 'consultando…'));
  row.appendChild(td);
  tr.after(row);
  const res = await window.ollama.show(name);
  td.innerHTML = '';
  if (!res.ok) { td.appendChild(el('span', 'loading', 'Error: ' + res.error)); return; }
  const info = res.info || {};
  const mi = info.model_info || {};
  const arch = mi['general.architecture'] || info.details?.family || '';
  const ctx = mi[arch + '.context_length'];
  const emb = mi[arch + '.embedding_length'];
  const rows = [
    ['familia', info.details?.family],
    ['arquitectura', arch],
    ['formato', info.details?.format],
    ['contexto máx.', ctx ? ctx.toLocaleString('es') + ' tokens' : null],
    ['embedding', emb ? emb.toLocaleString('es') : null],
    ['capacidades', Array.isArray(info.capabilities) ? info.capabilities.join(', ') : null],
    ['parámetros', info.parameters],
    ['plantilla', info.template],
    ['licencia', info.license ? String(info.license).split('\n').find(l => l.trim()) : null],
  ].filter(([, v]) => v);
  const dl = el('dl', 'kv');
  for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, String(v).trim()));
  td.appendChild(dl);
}

async function deleteModel(name) {
  const ok = await window.ui.confirm({
    title: 'Eliminar modelo',
    message: `¿Eliminar «${name}»?`,
    detail: 'Se borra del disco. Para volver a usarlo habrá que descargarlo de nuevo.',
  });
  if (!ok) return;
  const res = await window.ollama.delete(name);
  if (!res.ok) { toast('No se pudo eliminar: ' + res.error, true); return; }
  toast('Eliminado ' + shortModel(name));
  if (currentModel === name) currentModel = '';
  await loadModels();
  renderModelsView();
}

async function pullModel() {
  const input = $('#pull-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const box = $('#pull-progress'), fill = $('#pull-bar-fill'), status = $('#pull-status');
  box.hidden = false; fill.style.width = '0%'; status.textContent = 'conectando con el registro…';
  $('#pull-btn').disabled = true; input.disabled = true;
  const res = await window.ollama.pull(name);
  $('#pull-btn').disabled = false; input.disabled = false;
  if (res.ok) {
    status.textContent = 'listo'; fill.style.width = '100%';
    toast('Descargado ' + name);
    input.value = '';
    await loadModels();
    if (!currentModel || models.length === 1) setModel(name);
    renderModelsView();
    setTimeout(() => { box.hidden = true; }, 2500);
  } else {
    status.textContent = 'error: ' + res.error;
    toast('No se pudo descargar: ' + res.error, true);
  }
}
window.ollama.onPullProgress(({ status, completed, total }) => {
  const fill = $('#pull-bar-fill'), st = $('#pull-status');
  if (total && completed != null) {
    const pct = (completed / total) * 100;
    fill.style.width = pct.toFixed(1) + '%';
    st.textContent = `${status} · ${fmtSize(completed)} / ${fmtSize(total)} · ${pct.toFixed(0)} %`;
  } else if (status) st.textContent = status;
});

// ── Modelos en memoria ───────────────────────────────────────
let runningModels = [];
async function pollRunning() {
  if (!connected) return;
  const res = await window.ollama.ps();
  runningModels = res.ok ? res.models : [];
  renderRunningEverywhere();
}
function renderRunningInto(box, detailed) {
  box.innerHTML = '';
  if (!runningModels.length) { box.appendChild(el('div', 'none', 'Ningún modelo cargado en memoria.')); return; }
  for (const m of runningModels) {
    const row = el('div', 'row');
    const dot = el('i', 'live is-on');
    const name = el('span', 'name', m.name);
    const bits = [fmtSize(m.size)];
    if (m.size_vram) bits.push(m.size_vram >= m.size ? 'en GPU' : `${Math.round(m.size_vram / m.size * 100)} % en GPU`);
    else bits.push('en CPU');
    if (detailed && m.expires_at) bits.push('hasta ' + fmtTime(m.expires_at));
    row.append(dot, name, el('span', 'mono', bits.join(' · ')));
    box.appendChild(row);
  }
}
function renderRunningEverywhere() {
  renderRunningInto($('#running-list'), false);
  renderRunningInto($('#perf-running'), true);
  const foot = $('#u-foot');
  if (!connected) foot.textContent = 'ollama sin conexión';
  else if (!runningModels.length) foot.textContent = 'nada en memoria';
  else {
    const total = runningModels.reduce((a, m) => a + (m.size || 0), 0);
    foot.textContent = `${runningModels.length} en memoria · ${fmtSize(total)}`;
  }
}

// ── Consumo: lateral + vista de recursos ─────────────────────
const HIST = 60;
const hist = { cpu: [], ram: [], gpu: [] };
let sysStats = null;

const pushHist = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };
function setMeter(id, pct, na) {
  const bar = $('#' + id);
  const meter = bar.parentElement;
  bar.style.width = na ? '0%' : Math.max(0, Math.min(100, pct)).toFixed(1) + '%';
  meter.classList.toggle('is-hot', !na && pct >= 80 && pct < 92);
  meter.classList.toggle('is-crit', !na && pct >= 92);
}

async function pollUsage() {
  let s;
  try { s = await window.sys.stats(); } catch { return; }
  sysStats = s;
  const ramPct = s.ram.total ? (s.ram.used / s.ram.total) * 100 : 0;
  const gpuPct = s.gpu ? s.gpu.util : 0;
  const vramPct = s.gpu && s.gpu.memTotal ? (s.gpu.memUsed / s.gpu.memTotal) * 100 : 0;
  pushHist(hist.cpu, s.cpu); pushHist(hist.ram, ramPct); pushHist(hist.gpu, gpuPct);

  // lateral
  setMeter('u-cpu', s.cpu); $('#u-cpu-v').textContent = Math.round(s.cpu) + '%';
  setMeter('u-ram', ramPct); $('#u-ram-v').textContent = Math.round(ramPct) + '%';
  const gpuRows = [$('#u-gpu').closest('.urow'), $('#u-vram').closest('.urow')];
  gpuRows.forEach(r => r.classList.toggle('is-na', !s.gpu));
  setMeter('u-gpu', gpuPct, !s.gpu); $('#u-gpu-v').textContent = s.gpu ? Math.round(gpuPct) + '%' : 'n/d';
  setMeter('u-vram', vramPct, !s.gpu); $('#u-vram-v').textContent = s.gpu ? Math.round(vramPct) + '%' : 'n/d';

  if (view === 'perf') renderPerf();
}

function sparkline(lineId, areaId, arr) {
  const n = HIST - 1;
  const off = HIST - arr.length;
  const pts = arr.map((v, i) => [((i + off) / n) * 100, 29 - (Math.max(0, Math.min(100, v)) / 100) * 27]);
  const str = pts.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
  $('#' + lineId).setAttribute('points', str);
  if (pts.length) {
    const first = pts[0][0].toFixed(2), last = pts[pts.length - 1][0].toFixed(2);
    $('#' + areaId).setAttribute('points', `${first},30 ${str} ${last},30`);
  }
}

function renderPerf() {
  if (!sysStats) return;
  const s = sysStats;
  $('#perf-platform').textContent = s.platform || '';
  const ramPct = s.ram.total ? (s.ram.used / s.ram.total) * 100 : 0;

  $('#cpu-big').textContent = Math.round(s.cpu);
  $('#cpu-cores').textContent = s.cores ? s.cores + ' núcleos' : '';
  setMeter('cpu-bar', s.cpu);
  $('#cpu-sub').textContent = s.cpuModel || 'CPU';
  sparkline('cpu-line', 'cpu-area', hist.cpu);

  $('#ram-big').textContent = Math.round(ramPct);
  $('#ram-total').textContent = fmtSize(s.ram.total);
  setMeter('ram-bar', ramPct);
  $('#ram-sub').textContent = `${fmtSize(s.ram.used)} en uso · ${fmtSize(s.ram.free)} libres`;
  sparkline('ram-line', 'ram-area', hist.ram);

  const card = $('#gpu-bar').closest('.instrument');
  card.classList.toggle('is-na', !s.gpu);
  if (s.gpu) {
    $('#gpu-big').textContent = Math.round(s.gpu.util);
    $('#gpu-temp').textContent = s.gpu.temp ? s.gpu.temp + ' °C' : '';
    setMeter('gpu-bar', s.gpu.util);
    $('#gpu-sub').textContent = `${s.gpu.name} · ${fmtSize(s.gpu.memUsed)} / ${fmtSize(s.gpu.memTotal)} VRAM`;
  } else {
    $('#gpu-big').textContent = '–';
    $('#gpu-temp').textContent = '';
    setMeter('gpu-bar', 0, true);
    $('#gpu-sub').textContent = 'Sin GPU NVIDIA (nvidia-smi no disponible)';
  }
  sparkline('gpu-line', 'gpu-area', hist.gpu);
  renderLastGen();
}

function renderLastGen() {
  const g = lastGen || {};
  $('#last-tps').textContent = g.tps ?? '–';
  $('#last-tokens').textContent = g.tokens ?? '–';
  $('#last-prompt').textContent = g.prompt ?? '–';
  $('#last-time').textContent = g.time ?? '–';
}

// ── Vistas ───────────────────────────────────────────────────
function switchView(v) {
  view = v;
  for (const name of ['chat', 'models', 'perf']) {
    $('#view-' + name).hidden = name !== v;
    $('#nav-' + name).classList.toggle('is-active', name === v);
  }
  if (v === 'models') renderModelsView();
  if (v === 'perf') { renderPerf(); pollRunning(); }
  if (v === 'chat') $('#input').focus();
}

// ── Tema ─────────────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  $('#theme-toggle').textContent = t === 'dark' ? 'Tema claro' : 'Tema oscuro';
  store.save('theme', t);
  window.ui.setTitleBarTheme(t); // recolorea min/max/cerrar a juego con el tema
}

// ── Arranque ─────────────────────────────────────────────────
function init() {
  applyTheme(store.load('theme', 'dark'));
  $('#system-prompt').value = settings.system;
  $('#temp').value = settings.temperature; $('#temp-val').textContent = Number(settings.temperature).toFixed(1);
  $('#num-ctx').value = settings.num_ctx;
  window.app.version().then(v => { if (v) $('#app-version').textContent = 'v' + v; });

  $('#new-chat').onclick = newChat;
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => switchView(t.dataset.view));
  $('#usage').onclick = () => switchView('perf');
  $('#refresh-models').onclick = renderModelsView;
  $('#start-ollama').onclick = startOllama;
  $('#theme-toggle').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  $('#settings-toggle').onclick = () => { const p = $('#settings-panel'); p.hidden = !p.hidden; };
  $('#pull-form').addEventListener('submit', (e) => { e.preventDefault(); pullModel(); });

  $('#model-select').onchange = (e) => setModel(e.target.value);
  $('#system-prompt').oninput = (e) => { settings.system = e.target.value; store.save('settings', settings); updateComposerMeta(); };
  $('#temp').oninput = (e) => { settings.temperature = Number(e.target.value); $('#temp-val').textContent = settings.temperature.toFixed(1); store.save('settings', settings); updateComposerMeta(); };
  $('#num-ctx').onchange = (e) => { settings.num_ctx = Math.max(512, Number(e.target.value) || 4096); e.target.value = settings.num_ctx; store.save('settings', settings); updateComposerMeta(); };

  const input = $('#input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (streaming) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; autosize();
    sendMessage(text);
  });
  $('#stop-btn').onclick = () => { if (currentStreamId) window.ollama.stop(currentStreamId); };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentStreamId) { window.ollama.stop(currentStreamId); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
  });

  renderChatList();
  renderMessages();
  renderLastGen();
  updateComposerMeta();
  checkConnection();
  pollUsage(); setInterval(pollUsage, 2000);
  setInterval(pollRunning, 6000);
}

document.addEventListener('DOMContentLoaded', init);
