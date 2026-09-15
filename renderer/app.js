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
const dateLocale = () => (getLang() === 'en' ? 'en-US' : 'es');
const fmtDate = (s) => {
  try { return new Date(s).toLocaleDateString(dateLocale(), { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return ''; }
};
const fmtTime = (s) => {
  try { return new Date(s).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' }); }
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
  btn.textContent = ollamaIsInstalled ? t('ollama.start') : t('ollama.download');
}

async function checkConnection() {
  const res = await window.ollama.version();
  const was = connected;
  connected = !!res.ok;
  const c = $('#conn');
  c.className = 'conn ' + (connected ? 'is-ok' : 'is-bad');
  $('#conn-text').textContent = connected ? 'v' + res.version : t('conn.disconnected');
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
  b.disabled = true; b.textContent = t('ollama.starting');
  const res = await window.ollama.start();
  b.disabled = false;
  if (!res.ok) {
    if (res.notInstalled) ollamaIsInstalled = false;
    const key = { not_installed: 'ollama.notInstalled', spawn_failed: 'ollama.spawnFailed', start_timeout: 'ollama.startTimeout' }[res.code];
    toast(key ? t(key) : res.error, true);
  }
  updateOllamaCta();
  checkConnection();
}

// ── Modelos disponibles ──────────────────────────────────────
let models = [];
async function loadModels() {
  const res = await window.ollama.tags();
  if (!res.ok) { toast(t('toast.modelsListFailed', { err: res.error }), true); return []; }
  models = res.models;
  const sel = $('#model-select');
  sel.innerHTML = '';
  if (!models.length) {
    const o = el('option', null, t('composer.noModel')); o.value = ''; sel.appendChild(o);
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
  parts.push(currentModel ? shortModel(currentModel) : t('composer.noModel'));
  parts.push(t('composer.ctx', { n: settings.num_ctx }));
  parts.push(t('composer.temp', { n: Number(settings.temperature).toFixed(1) }));
  if (settings.system.trim()) parts.push(t('composer.system'));
  $('#composer-meta').textContent = parts.join(' · ');
}

// ── Lista de conversaciones ──────────────────────────────────
function renderChatList() {
  const list = $('#chat-list');
  list.innerHTML = '';
  if (!chats.length) { list.appendChild(el('div', 'chat-empty', t('conversations.empty'))); return; }
  for (const c of chats) {
    const item = el('div', 'chat-item' + (c.id === activeChatId ? ' is-active' : ''));
    const title = el('span', 'title', c.title || t('conversations.untitled'));
    const del = el('button', 'del', '×');
    del.title = t('conversations.deleteTitle');
    del.onclick = (e) => {
      e.stopPropagation();
      if (del.dataset.armed) { deleteChat(c.id); return; }
      del.dataset.armed = '1'; del.textContent = t('conversations.deleteConfirm');
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
  const h = el('h2', null, t('empty.title'));
  const p = el('p', null, t('empty.subtitle'));
  e.append(h, p);
  if (!connected) {
    const warn = el('div', 'warn');
    if (ollamaIsInstalled) {
      warn.textContent = t('empty.warnNoConn');
    } else {
      warn.append(t('empty.warnNotInstalled'));
      const a = el('a', null, t('empty.warnNotInstalledLink'));
      a.href = DOWNLOAD_URL;
      warn.appendChild(a);
      warn.append(t('empty.warnNotInstalledSuffix'));
    }
    e.appendChild(warn);
  } else if (!models.length) {
    e.appendChild(el('div', 'warn', t('empty.warnNoModels')));
  }
  const keys = el('dl', 'keys');
  for (const [k, v] of [
    [t('keys.enter'), t('keys.enterDesc')],
    [t('keys.shiftEnter'), t('keys.shiftEnterDesc')],
    [t('keys.esc'), t('keys.escDesc')],
    [t('keys.ctrlN'), t('keys.ctrlNDesc')],
    [t('keys.dblclick'), t('keys.dblclickDesc')],
  ]) {
    keys.append(el('dt', null, k), el('dd', null, v));
  }
  e.appendChild(keys);
  return e;
}

function renderMessage(m, chat, isLast) {
  const wrap = el('div', 'msg msg--' + m.role);
  const who = el('div', 'who', m.role === 'user' ? t('msg.you') : shortModel(m.model) || t('msg.model'));
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
  const copy = el('button', null, t('msg.copy'));
  copy.onclick = () => { navigator.clipboard.writeText(m.content); copy.textContent = t('msg.copied'); setTimeout(() => copy.textContent = t('msg.copy'), 1200); };
  actions.appendChild(copy);
  if (m.role === 'assistant' && isLast) {
    const regen = el('button', null, t('msg.regenerate'));
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
    const btn = el('button', 'copy-code', t('msg.copy'));
    btn.onclick = () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText((code ? code.innerText : pre.innerText).trim());
      btn.textContent = t('msg.copied'); setTimeout(() => btn.textContent = t('msg.copy'), 1200);
    };
    pre.appendChild(btn);
  });
}

function scrollBottom() { const b = $('#messages'); b.scrollTop = b.scrollHeight; }

// ── Generación ───────────────────────────────────────────────
function sendMessage(text) {
  if (!connected) { toast(t('toast.ollamaDown'), true); return; }
  if (!currentModel) { toast(t('toast.noModel'), true); return; }
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
    toast(t('toast.errorPrefix', { err: error }), true);
  } else if (aborted && !assistant.content) {
    assistant.content = t('msg.stopped'); assistant.error = true;
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
  if (!box.children.length) box.innerHTML = `<p class="none">${t('models.loading')}</p>`;
  const [tagsRes] = await Promise.all([window.ollama.tags(), pollRunning()]);
  box.innerHTML = '';
  if (!tagsRes.ok) { box.appendChild(el('p', 'none', t('models.error', { err: tagsRes.error }))); return; }
  models = tagsRes.models;
  $('#models-count').textContent = models.length ? String(models.length) : '';
  if (!models.length) { box.appendChild(el('p', 'none', t('models.none'))); return; }

  const table = el('table', 'table');
  table.innerHTML = `<thead><tr><th>${t('table.model')}</th><th class="num">${t('table.size')}</th><th class="num">${t('table.params')}</th><th class="num">${t('table.quant')}</th><th class="num">${t('table.modified')}</th><th></th></tr></thead>`;
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
    const use = el('button', 'btn btn--quiet', t('table.use'));
    use.onclick = () => { setModel(m.name); renderModelsView(); toast(t('toast.modelActive', { name: shortModel(m.name) })); };
    const info = el('button', 'btn btn--quiet', t('table.details'));
    info.onclick = () => toggleDetails(tr, m.name);
    const del = el('button', 'btn btn--quiet btn--danger', t('table.delete'));
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
  td.appendChild(el('span', 'loading', t('details.loading')));
  row.appendChild(td);
  tr.after(row);
  const res = await window.ollama.show(name);
  td.innerHTML = '';
  if (!res.ok) { td.appendChild(el('span', 'loading', t('details.error', { err: res.error }))); return; }
  const info = res.info || {};
  const mi = info.model_info || {};
  const arch = mi['general.architecture'] || info.details?.family || '';
  const ctx = mi[arch + '.context_length'];
  const emb = mi[arch + '.embedding_length'];
  const rows = [
    [t('details.family'), info.details?.family],
    [t('details.arch'), arch],
    [t('details.format'), info.details?.format],
    [t('details.maxCtx'), ctx ? t('details.maxCtxUnit', { n: ctx.toLocaleString(dateLocale()) }) : null],
    [t('details.embedding'), emb ? emb.toLocaleString(dateLocale()) : null],
    [t('details.capabilities'), Array.isArray(info.capabilities) ? info.capabilities.join(', ') : null],
    [t('details.params'), info.parameters],
    [t('details.template'), info.template],
    [t('details.license'), info.license ? String(info.license).split('\n').find(l => l.trim()) : null],
  ].filter(([, v]) => v);
  const dl = el('dl', 'kv');
  for (const [k, v] of rows) dl.append(el('dt', null, k), el('dd', null, String(v).trim()));
  td.appendChild(dl);
}

async function deleteModel(name) {
  const ok = await window.ui.confirm({
    title: t('confirm.deleteModelTitle'),
    message: t('confirm.deleteModelMessage', { name }),
    detail: t('confirm.deleteModelDetail'),
    buttons: [t('confirm.cancel'), t('confirm.ok')],
  });
  if (!ok) return;
  const res = await window.ollama.delete(name);
  if (!res.ok) { toast(t('toast.deleteFailed', { err: res.error }), true); return; }
  toast(t('toast.deleted', { name: shortModel(name) }));
  if (currentModel === name) currentModel = '';
  await loadModels();
  renderModelsView();
}

async function pullModel() {
  const input = $('#pull-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const box = $('#pull-progress'), fill = $('#pull-bar-fill'), status = $('#pull-status');
  box.hidden = false; fill.style.width = '0%'; status.textContent = t('pull.connecting');
  $('#pull-btn').disabled = true; input.disabled = true;
  const res = await window.ollama.pull(name);
  $('#pull-btn').disabled = false; input.disabled = false;
  if (res.ok) {
    status.textContent = t('pull.ready'); fill.style.width = '100%';
    toast(t('toast.downloaded', { name }));
    input.value = '';
    await loadModels();
    if (!currentModel || models.length === 1) setModel(name);
    renderModelsView();
    setTimeout(() => { box.hidden = true; }, 2500);
  } else {
    status.textContent = t('pull.error', { err: res.error });
    toast(t('toast.downloadFailed', { err: res.error }), true);
  }
}
window.ollama.onPullProgress(({ status, completed, total }) => {
  const fill = $('#pull-bar-fill'), st = $('#pull-status');
  if (total && completed != null) {
    const pct = (completed / total) * 100;
    fill.style.width = pct.toFixed(1) + '%';
    st.textContent = t('pull.progress', { status, done: fmtSize(completed), total: fmtSize(total), pct: pct.toFixed(0) });
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
  if (!runningModels.length) { box.appendChild(el('div', 'none', t('running.none'))); return; }
  for (const m of runningModels) {
    const row = el('div', 'row');
    const dot = el('i', 'live is-on');
    const name = el('span', 'name', m.name);
    const bits = [fmtSize(m.size)];
    if (m.size_vram) bits.push(m.size_vram >= m.size ? t('running.gpu') : t('running.gpuPct', { pct: Math.round(m.size_vram / m.size * 100) }));
    else bits.push(t('running.cpu'));
    if (detailed && m.expires_at) bits.push(t('running.until', { time: fmtTime(m.expires_at) }));
    row.append(dot, name, el('span', 'mono', bits.join(' · ')));
    box.appendChild(row);
  }
}
function renderRunningEverywhere() {
  renderRunningInto($('#running-list'), false);
  renderRunningInto($('#perf-running'), true);
  const foot = $('#u-foot');
  if (!connected) foot.textContent = t('usageFoot.disconnected');
  else if (!runningModels.length) foot.textContent = t('usageFoot.empty');
  else {
    const total = runningModels.reduce((a, m) => a + (m.size || 0), 0);
    foot.textContent = t('usageFoot.summary', { n: runningModels.length, size: fmtSize(total) });
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
  $('#cpu-cores').textContent = s.cores ? t('perf.cores', { n: s.cores }) : '';
  setMeter('cpu-bar', s.cpu);
  $('#cpu-sub').textContent = s.cpuModel || 'CPU';
  sparkline('cpu-line', 'cpu-area', hist.cpu);

  $('#ram-big').textContent = Math.round(ramPct);
  $('#ram-total').textContent = fmtSize(s.ram.total);
  setMeter('ram-bar', ramPct);
  $('#ram-sub').textContent = t('perf.ramSub', { used: fmtSize(s.ram.used), free: fmtSize(s.ram.free) });
  sparkline('ram-line', 'ram-area', hist.ram);

  const card = $('#gpu-bar').closest('.instrument');
  card.classList.toggle('is-na', !s.gpu);
  if (s.gpu) {
    $('#gpu-big').textContent = Math.round(s.gpu.util);
    $('#gpu-temp').textContent = s.gpu.temp ? s.gpu.temp + ' °C' : '';
    setMeter('gpu-bar', s.gpu.util);
    $('#gpu-sub').textContent = t('perf.gpuSub', { name: s.gpu.name, used: fmtSize(s.gpu.memUsed), total: fmtSize(s.gpu.memTotal) });
  } else {
    $('#gpu-big').textContent = '–';
    $('#gpu-temp').textContent = '';
    setMeter('gpu-bar', 0, true);
    $('#gpu-sub').textContent = t('perf.noGpu');
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
function updateThemeLabel() {
  const t2 = document.documentElement.getAttribute('data-theme');
  $('#theme-toggle').textContent = t2 === 'dark' ? t('theme.toLight') : t('theme.toDark');
}
function applyTheme(t2) {
  document.documentElement.setAttribute('data-theme', t2);
  updateThemeLabel();
  store.save('theme', t2);
  window.ui.setTitleBarTheme(t2); // recolorea min/max/cerrar a juego con el tema
}

// ── Idioma ───────────────────────────────────────────────────
function updateModelsCatalogHint() {
  const hint = $('#models-catalog-hint');
  if (!hint) return;
  hint.innerHTML = '';
  hint.append(t('models.catalogPrefix') + ' ');
  const a = el('a', null, 'ollama.com/library'); a.href = 'https://ollama.com/library';
  hint.append(a, '.');
}
function onLangChange() {
  updateThemeLabel();
  updateOllamaCta();
  updateComposerMeta();
  updateModelsCatalogHint();
  renderChatList();
  renderMessages();
  if (view === 'models') renderModelsView();
  if (view === 'perf') renderPerf();
  renderRunningEverywhere();
}

// ── Arranque ─────────────────────────────────────────────────
function init() {
  applyStaticI18n();
  document.documentElement.setAttribute('lang', getLang());
  applyTheme(store.load('theme', 'dark'));
  updateModelsCatalogHint();
  $('#system-prompt').value = settings.system;
  $('#temp').value = settings.temperature; $('#temp-val').textContent = Number(settings.temperature).toFixed(1);
  $('#num-ctx').value = settings.num_ctx;
  window.app.version().then(v => { if (v) $('#app-version').textContent = 'v' + v; });

  $('#new-chat').onclick = newChat;
  document.querySelectorAll('.tab').forEach(t2 => t2.onclick = () => switchView(t2.dataset.view));
  $('#usage').onclick = () => switchView('perf');
  $('#refresh-models').onclick = renderModelsView;
  $('#start-ollama').onclick = startOllama;
  $('#theme-toggle').onclick = () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  $('#lang-toggle').onclick = () => setLang(getLang() === 'es' ? 'en' : 'es');
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
