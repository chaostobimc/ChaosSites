/**
 * Chaos ADBrowser — browser chrome.
 *
 * Tabs are iframes; each one owns a server-side session (its own cookie jar, referrer, stats).
 * The page inside tells us where it went via postMessage, so the address bar, history and the
 * ad counter stay honest even for SPA navigations.
 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  tabs: new Map(),
  order: [],
  active: null,
  settings: {},
  state2: null,
  poll: null,
  loading: new Set(),
};

const LS_TABS = 'chaos:tabs';
const LS_LAST = 'chaos:last';

const api = {
  async get(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(path + ' → ' + r.status);
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    if (!r.ok) throw new Error(path + ' → ' + r.status);
    return r.json();
  },
};

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
};
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u ?? ''; } };
const colorFor = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 62%)`;
};

/* ------------------------------------------------------------------ *
 *  tabs
 * ------------------------------------------------------------------ */

let tabSeq = 0;

async function newTab(input = '', { activate = true, restore = false } = {}) {
  const tab = { id: null, url: '', title: 'Neuer Tab', el: null, loading: false, started: 0, stats: null,
    revealT: 0, stallT: 0 };
  let res;
  try {
    res = await api.post('/api/tab', input ? { url: input } : {});
  } catch (err) {
    // Without this the whole app would just sit there: no tab, no message, dark stage.
    toast('Tab konnte nicht geöffnet werden: ' + (err.message ?? err));
    throw err;
  }
  tab.id = res.id;
  tab.url = res.url ?? '';
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', [
    'allow-scripts', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-popups-to-escape-sandbox',
    'allow-pointer-lock', 'allow-downloads', 'allow-same-origin', 'allow-presentation',
  ].join(' '));
  frame.setAttribute('allow', 'fullscreen; autoplay; encrypted-media; picture-in-picture; clipboard-write');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('fetchpriority', 'high');
  frame.dataset.tab = tab.id;
  frame.addEventListener('load', () => {
    settleFrame(tab);
    state.loading.delete(tab.id);
    setProgress();
    frame.classList.add('on');
    refreshStats(tab.id);
    if (tab.started) {
      const ms = Math.round(performance.now() - tab.started);
      tab.lastMs = ms;
      tab.started = 0;
    }
  });
  tab.el = frame;
  $('#frames').append(frame);
  showEmpty(false);
  if (res.proxied) navigate(tab, res.proxied, { realUrl: tab.url });
  else armFrame(tab, '/start');
  state.tabs.set(tab.id, tab);
  state.order.push(tab.id);
  if (activate) activateTab(tab.id);
  renderTabs();
  persist();
  tabSeq++;
  return tab;
}

/**
 * Point a tab's frame at a proxied URL — and never leave it invisible just because the page is slow.
 *
 * `load` on an iframe fires only after *every* subresource settled, so one long-poll, one open
 * websocket or one dead ad host would keep the tab black forever (the page behind it is fine, it is
 * simply not shown). Two timers fix that: `reveal` makes the frame visible a beat later whatever has
 * arrived so far, `stall` offers "neu laden / anhalten" if the page is still hanging.
 */
const REVEAL_MS = 1200;
const STALL_MS = 12000;

function armFrame(tab, src) {
  const frame = tab.el;
  if (!frame) return;
  clearTimeout(tab.revealT);
  clearTimeout(tab.stallT);
  frame.classList.remove('stall');
  frame.removeAttribute('loading'); // a lazy frame that was hidden once never loads again
  tab.loading = true;
  tab.started = performance.now();
  state.loading.add(tab.id);
  tab.revealT = setTimeout(() => frame.classList.add('on'), REVEAL_MS);
  tab.stallT = setTimeout(() => showStall(tab), STALL_MS);
  frame.src = src;
  setProgress();
  renderTabs();
}

function settleFrame(tab) {
  clearTimeout(tab.revealT);
  clearTimeout(tab.stallT);
  tab.revealT = tab.stallT = 0;
  tab.loading = false;
  if (tab.el) tab.el.classList.remove('stall');
  hideStall();
}

let stalledTab = null;
function showStall(tab) {
  if (!tab?.id) return;
  stalledTab = tab.id;
  if (tab.el) tab.el.classList.add('stall');
  const host = hostOf(tab.url) || 'Diese Seite';
  $('#stallmsg').textContent = `${host} antwortet nicht vollständig — die Seite lädt noch.`;
  $('#stall').hidden = false;
  renderTabs();
}
function hideStall() {
  stalledTab = null;
  const el = $('#stall');
  if (el) el.hidden = true;
}

function navigate(tab, proxied, { realUrl = '' } = {}) {
  if (!proxied) return;
  if (realUrl) tab.url = realUrl;
  armFrame(tab, proxied);
}

function activateTab(id) {
  state.active = id;
  for (const t of state.tabs.values()) {
    t.el.classList.toggle('on', t.id === id);
    // only frames that have already loaded once are worth deferring
    if (t.id !== id) { if (t.started === 0) t.el.setAttribute('loading', 'lazy'); }
    else t.el.removeAttribute('loading');
  }
  const tab = state.tabs.get(id);
  showEmpty(state.order.length === 0);
  if (stalledTab === id) showStall(tab); else hideStall();
  if (tab) {
    $('#address').value = tab.url || '';
    document.title = tab.title && tab.title !== 'Neuer Tab' ? `${tab.title} · Chaos ADBrowser` : 'Chaos ADBrowser';
  }
  renderTabs();
  refreshStats(id);
  persist();
}

function closeTab(id) {
  const tab = state.tabs.get(id);
  if (!tab) return;
  settleFrame(tab);
  tab.el.remove();
  state.tabs.delete(id);
  state.order = state.order.filter((x) => x !== id);
  api.post('/api/tab/close', { id }).catch(() => {});
  if (state.active === id) {
    const next = state.order[state.order.length - 1];
    if (next) activateTab(next);
    else { renderTabs(); showEmpty(true); }
  }
  renderTabs();
  persist();
}

function showEmpty(on) {
  $('#empty').hidden = !on;
  if (on) {
    $('#empty').innerHTML = `<div><h2>Kein Tab offen</h2>
      <p>Tippe oben eine Adresse ein oder öffne einen neuen Tab — Werbung und Tracker werden beim Laden entfernt.</p>
      <button class="btn primary" id="emptynew">Ersten Tab öffnen</button></div>`;
    $('#emptynew')?.addEventListener('click', () => { showEmpty(false); newTab(''); });
  }
}

function renderTabs() {
  const wrap = $('#tabs');
  wrap.innerHTML = '';
  for (const id of state.order) {
    const tab = state.tabs.get(id);
    if (!tab) continue;
    const host = hostOf(tab.url);
    const el = document.createElement('div');
    el.className = 'tab' + (id === state.active ? ' on' : '');
    el.title = `${tab.title || host}\n${tab.url}` + (tab.lastMs ? `\ngeladen in ${tab.lastMs} ms` : '');
    el.innerHTML = `<span class="fav" style="background:${host ? colorFor(host) : '#4d7cff'}">${(host[0] ?? '?').toUpperCase()}</span>
      <span class="label">${escapeHtml(tab.title || host || 'Neuer Tab')}</span>
      ${tab.stats?.blocked ? `<span class="ad">${tab.stats.blocked}</span>` : ''}
      <button class="x" title="Schließen (Strg+W)">×</button>`;
    el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('x')) { closeTab(id); return; }
      activateTab(id);
    });
    el.addEventListener('auxclick', (ev) => { if (ev.button === 1) closeTab(id); });
    wrap.append(el);
  }
  wrap.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#back').disabled = !canBack();
  $('#fwd').disabled = !canForward();
}
/** the dot in the omnibox: tls is to *our* server + the target, so report it honestly */
function paintLock(tab) {
  const el = $('#lock');
  if (!el) return;
  el.classList.remove('secure', 'blocked');
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) { el.title = 'Startseite — kein Ziel'; return; }
  if (tab.url.indexOf('https:') === 0) {
    el.classList.add('secure');
    el.title = 'Ziel per https erreichbar — der Proxy sieht den Klartext zwischen Ziel und uns, '
      + 'ausserdem läuft alles über die Server-IP.';
  } else {
    el.classList.add('blocked');
    el.title = 'Ziel nur über http — zwischen Proxy und Ziel ist die Verbindung unverschlüsselt.';
  }
}


const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function activeTab() { return state.tabs.get(state.active); }

/* ------------------------------------------------------------------ *
 *  navigation history (chrome-level, the iframe keeps its own too)
 * ------------------------------------------------------------------ */

function frameNav(dir) {
  const tab = activeTab();
  if (!tab) return;
  try {
    const win = tab.el.contentWindow;
    if (!win) return;
    if (dir < 0) win.history.back();
    else win.history.forward();
    return true;
  } catch { return false; }
}
function canBack() {
  const t = activeTab();
  if (!t) return false;
  try { return (t.el.contentWindow?.history?.length ?? 0) > 1; } catch { return true; }
}
// the platform does not expose "can I go forward"; keep the button live and let history decide
function canForward() { return !!activeTab(); }

/* ------------------------------------------------------------------ *
 *  address bar
 * ------------------------------------------------------------------ */

async function submitAddress(value) {
  const input = (value ?? '').trim();
  if (!input) return;
  if (input === 'chaos:stats') { openPanel('ad'); return; }
  if (/^(start|\/start|about:chaos)$/i.test(input)) {
    const t = activeTab();
    if (t) armFrame(t, '/start'); else await newTab('');
    return;
  }
  if (input.startsWith('/b/')) { // a proxied path was pasted in
    const t = activeTab() ?? await newTab('');
    navigate(t, input);
    return;
  }
  let url = '';
  try {
    url = (await api.get('/api/resolve?q=' + encodeURIComponent(input))).url;
  } catch (err) {
    toast('Adresse konnte nicht aufgelöst werden: ' + (err.message ?? err));
    return;
  }
  if (!url) { toast('Das sieht nicht nach einer Adresse oder Suchanfrage aus.'); return; }
  const t = activeTab() ?? await newTab('');
  if (url.startsWith('/')) navigate(t, url, { realUrl: location.origin + url });
  else navigate(t, toProxiedLocal(url, t.id), { realUrl: url });
  $('#address').value = url;
  persist();
}

/** the client-side mirror of src/encode.js#toProxied (used when we skip a round trip) */
function toProxiedLocal(absUrl, sid) {
  const u = new URL(absUrl);
  const enc = b64u(`${u.protocol}//${u.host}`);
  return `/b/${sid}/p/${enc}${u.pathname || '/'}${u.search}${u.hash}`;
}
function b64u(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ------------------------------------------------------------------ *
 *  live stats + messages from the page
 * ------------------------------------------------------------------ */

async function refreshStats(id) {
  const tab = state.tabs.get(id ?? state.active);
  if (!tab?.id) return;
  try {
    const s = await api.get(`/b/${tab.id}/api/tab`);
    tab.stats = s.stats;
    tab.url = s.url || tab.url;
    tab.title = s.title || tab.title;
    if (id === state.active || id == null) {
      $('#tab-blocked').textContent = s.stats.blocked;
      paintPanelStats(s.stats);
      renderTabs();
    }
  } catch { /* tab gone */ }
}

function paintPanelStats(stats) {
  if (!stats) return;
  $('#stat-blocked').textContent = stats.blocked;
  $('#stat-saved').textContent = fmtBytes(stats.savedBytes);
  $('#stat-cache').textContent = (state.state2?.cache?.hitRate ?? 0) + '%';
  const ul = $('#tophosts');
  if (!stats.top?.length) {
    ul.innerHTML = '<li class="muted">Noch nichts geblockt.</li>';
  } else {
    ul.innerHTML = stats.top.map((t) => `<li><span>${escapeHtml(t.host)}</span><b>${t.n}</b></li>`).join('');
  }
}

function setProgress() {
  const on = state.loading.size > 0;
  $('#progress').hidden = !on;
  $('#progress').classList.toggle('on', on);
}

addEventListener('message', async (ev) => {
  const d = ev.data;
  if (!d || d.__chaos !== 1) return;
  const frame = ev.source?.frameElement;
  const id = frame?.dataset.tab;
  const tab = state.tabs.get(id);
  if (!tab) return;
  if (d.kind === 'goto') { submitAddress(d.url); return; }
  if (d.kind === 'popup') {
    const t = await newTab('');
    navigate(t, d.proxied, { realUrl: d.url });
    return;
  }
  if (d.url && d.url !== tab.url) {
    tab.url = d.url;
    if (id === state.active) $('#address').value = d.url;
  }
  if (d.title) tab.title = d.title;
  renderTabs();
  persist();
});

/* ------------------------------------------------------------------ *
 *  panel
 * ------------------------------------------------------------------ */

function openPanel(section = 'ad') {
  $('#panel').classList.add('open');
  $('#panel').setAttribute('aria-hidden', 'false');
  $$('#paneltabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === section));
  $$('#panel .panel-body > section').forEach((s) => { s.hidden = s.dataset.panel !== section; });
  if (section === 'hist') renderHistory();
  if (section === 'lists') renderEngineInfo();
  if (section === 'about') renderAbout();
}
function closePanel() {
  $('#panel').classList.remove('open');
  $('#panel').setAttribute('aria-hidden', 'true');
}

function renderEngineInfo() {
  const info = state.state2?.adblock ?? {};
  const c = info.meta?.counts ?? {};
  const rows = [
    ['Blockierte Hosts', (c.blockedHosts ?? 0).toLocaleString('de-DE')],
    ['Netzwerk-Regeln', (c.networkRules ?? 0).toLocaleString('de-DE')],
    ['Anker (Aho-Corasick)', (c.anchors ?? 0).toLocaleString('de-DE')],
    ['Cosmetic-Hosts', (c.cosmeticHosts ?? 0).toLocaleString('de-DE')],
    ['Generische Selektoren', (c.genericSelectors ?? 0).toLocaleString('de-DE')],
    ['Ausnahmen (Hosts)', (c.allowedHosts ?? 0).toLocaleString('de-DE')],
    ['Eigene Regeln', info.userRules ?? 0],
    ['Entscheidungen', (state.state2?.adblock?.stats?.checked ?? 0).toLocaleString('de-DE')],
    ['Treffer', (state.state2?.adblock?.stats?.blocked ?? 0).toLocaleString('de-DE')],
    ['Zu geladen', info.meta?.built ? new Date(info.meta.built).toLocaleString('de-DE') : '—'],
  ];
  $('#engineinfo').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('#upmsg').textContent = (state.state2?.adblock?.meta?.sources ?? [])
    .map((s) => `${s.list} (${s.network + s.cosmetic})`).join(' · ') || 'Seed-Liste';
}

function renderAbout() {
  const s = state.state2?.server ?? {};
  $('#serverinfo').innerHTML = [
    ['Port', s.port],
    ['Node', s.node],
    ['Uptime', Math.round((s.uptimeSec ?? 0) / 60) + ' min'],
    ['Isolation', s.isolate],
    ['Zugangscode', s.accessCode ? 'aktiv' : 'keiner'],
    ['Profile', state.state2?.cache ? state.state2?.profiles ?? '—' : '—'],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('#securitynote').innerHTML = state.state2?.server?.isolate === 'same origin'
    ? 'Seiten laufen auf demselben Origin wie diese UI. Für harte Trennung den Container mit '
      + '<code>CHAOS_ISOLATE_SUFFIX=sub.example.com</code> starten (Wildcard-DNS + TLS), dann bekommt jeder Tab einen eigenen Origin.'
    : 'Jeder Tab läuft auf einem eigenen Origin — proxied Seiten können diese UI nicht lesen.';
}

function renderHistory(filter = '') {
  const hist = (state.state2?.profile?.history ?? []).slice().reverse();
  const items = hist.filter((h) => !filter || (h.url + ' ' + (h.title ?? '')).toLowerCase().includes(filter.toLowerCase()));
  $('#history').innerHTML = items.length
    ? items.map((h) => `<li><a href="#" data-url="${escapeHtml(h.url)}">${escapeHtml(h.title || hostOf(h.url))}
        <span class="t">${escapeHtml(hostOf(h.url))} · ${new Date(h.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span></a></li>`).join('')
    : '<li class="muted">Noch nichts.</li>';
  $$('#history a').forEach((a) => a.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const tab = activeTab() ?? await newTab('');
    const { proxied } = await api.post('/b/' + tab.id + '/api/navigate', { url: a.dataset.url }).catch(() => ({}));
    navigate(tab, proxied ?? toProxiedLocal(a.dataset.url, tab.id), { realUrl: a.dataset.url });
    closePanel();
  }));
}

/* ------------------------------------------------------------------ *
 *  wiring
 * ------------------------------------------------------------------ */

async function loadState() {
  state.state2 = await api.get('/api/state');
  state.settings = state.state2.settings ?? {};
  for (const [k, v] of Object.entries(state.settings)) {
    const el = $(`[data-setting="${k}"]`);
    if (el && el.type === 'checkbox') el.checked = !!v;
  }
  const mode = state.settings.scripts ?? 'allow';
  $$('#scriptmode button').forEach((b) => b.classList.toggle('on', b.dataset.scripts === mode));
  $('#userrules').value = state.state2.userRules ?? '';
  paintPanelStats(state.state2.profile?.tabs?.[0]?.stats);
  renderEngineInfo();
  renderAbout();
}

async function pushSettings(patch) {
  Object.assign(state.settings, patch);
  await api.post('/api/settings', patch);
  toast('Gespeichert — wirkt ab dem nächsten Laden');
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#rulesmsg');
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.textContent = ''; }, 3500);
}

function persist() {
  try {
    const data = state.order.map((id) => {
      const t = state.tabs.get(id);
      return t ? { id: null, url: t.url, title: t.title } : null;
    }).filter(Boolean);
    localStorage.setItem(LS_TABS, JSON.stringify(data));
    const a = activeTab();
    if (a?.url) localStorage.setItem(LS_LAST, a.url);
  } catch { /* private mode */ }
}

function wire() {
  $('#newtab').addEventListener('click', () => newTab(''));
  $('#panelbtn').addEventListener('click', () => openPanel('ad'));
  $('#closepanel').addEventListener('click', closePanel);
  $('#menu').addEventListener('click', () => openPanel('about'));
  $$('#paneltabs button').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.tab)));
  $('#home').addEventListener('click', () => { const t = activeTab(); if (t) armFrame(t, '/start'); else newTab(''); });
  $('#stallreload').addEventListener('click', () => {
    const tab = state.tabs.get(stalledTab ?? state.active);
    if (!tab) return;
    armFrame(tab, tab.el.src); // same url, fresh request
  });
  $('#stallstop').addEventListener('click', () => {
    const tab = state.tabs.get(stalledTab ?? state.active);
    if (!tab) return;
    // stop the loader without losing what did arrive: about:blank would be a black page again
    settleFrame(tab);
    state.loading.delete(tab.id);
    setProgress();
    tab.el.classList.add('on');
  });
  $('#reload').addEventListener('click', () => {
    const t = activeTab();
    if (!t) return;
    try { t.el.contentWindow.location.reload(); } catch { armFrame(t, t.el.src); }
  });
  $('#back').addEventListener('click', () => frameNav(-1));
  $('#fwd').addEventListener('click', () => frameNav(1));
  $('#external').addEventListener('click', () => {
    const t = activeTab();
    if (t?.url && /^https?:/.test(t.url)) window.open(t.url, '_blank', 'noopener');
  });
  $('#omnibox').addEventListener('submit', (ev) => {
    ev.preventDefault();
    submitAddress($('#address').value);
  });
  $('#address').addEventListener('focus', (ev) => ev.target.select());
  $('#clearaddr').addEventListener('click', () => { $('#address').value = ''; $('#address').focus(); });

  $$('[data-setting]').forEach((el) => el.addEventListener('change', () => {
    pushSettings({ [el.dataset.setting]: el.type === 'checkbox' ? el.checked : el.value });
  }));
  $$('#scriptmode button').forEach((b) => b.addEventListener('click', () => {
    $$('#scriptmode button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    pushSettings({ scripts: b.dataset.scripts });
  }));
  $('#saverules').addEventListener('click', async () => {
    const r = await api.post('/api/user-rules', { rules: $('#userrules').value });
    toast(`ok: ${r.rules ?? 0} Regeln, ${r.hosts ?? 0} Hosts aktiv`);
    await loadState();
  });
  $('#clearfilters').addEventListener('click', async () => {
    $('#userrules').value = '';
    await api.post('/api/user-rules', { rules: '' });
    toast('eigene Regeln entfernt');
  });
  $('#updatefilters').addEventListener('click', async () => {
    $('#upmsg').textContent = 'Lade neue Listen …';
    try {
      const r = await api.post('/api/filters/update', {});
      $('#upmsg').textContent = 'Fertig: ' + JSON.stringify(r.counts ?? {});
      await loadState();
    } catch (err) {
      $('#upmsg').textContent = 'Nicht erlaubt: Container mit CHAOS_ALLOW_FILTER_UPDATE=1 starten '
        + '(oder im Container `npm run build:filters` ausführen und neu starten).';
    }
  });
  $$('[data-clear]').forEach((b) => b.addEventListener('click', async () => {
    await api.post('/api/clear', { what: b.dataset.clear });
    toast(b.dataset.clear + ' geleert');
    if (b.dataset.clear === 'history') { state.state2 = await api.get('/api/state'); renderHistory(); }
  }));
  $('#histsearch').addEventListener('input', (ev) => renderHistory(ev.target.value));
  $('#shield').addEventListener('click', () => openPanel('ad'));

  addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && ev.key.toLowerCase() === 'l') { ev.preventDefault(); $('#address').focus(); }
    else if (mod && ev.key.toLowerCase() === 't') { ev.preventDefault(); newTab(''); }
    else if (mod && ev.key.toLowerCase() === 'w') { ev.preventDefault(); if (state.active) closeTab(state.active); }
    else if (mod && ev.key.toLowerCase() === 'r') { ev.preventDefault(); $('#reload').click(); }
    else if (ev.altKey && ev.key === 'ArrowLeft') { ev.preventDefault(); frameNav(-1); }
    else if (ev.altKey && ev.key === 'ArrowRight') { ev.preventDefault(); frameNav(1); }
    else if (mod && /^[1-9]$/.test(ev.key)) {
      ev.preventDefault();
      const id = state.order[Number(ev.key) - 1];
      if (id) activateTab(id);
    } else if (ev.key === 'Escape') closePanel();
    else if (ev.key === 'F5') { ev.preventDefault(); $('#reload').click(); }
  });

  // poll stats of the active tab while it is loading
  setInterval(() => {
    if (state.loading.size && state.active) refreshStats(state.active);
  }, 800);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadState().catch(() => {});
  });
}

async function boot() {
  wire();
  await loadState().catch(() => {});
  let restore = [];
  try { restore = JSON.parse(localStorage.getItem(LS_TABS) ?? '[]'); } catch { restore = []; }
  if (!restore.length && localStorage.getItem(LS_LAST)) restore = [{ url: localStorage.getItem(LS_LAST) }];
  if (!restore.length) { await newTab(''); return; }
  for (const r of restore.slice(0, 8)) {
    if (!r.url) { await newTab(''); continue; }
    await newTab(r.url, { activate: false });
  }
  const last = state.order[state.order.length - 1];
  if (last) activateTab(last);
  showEmpty(state.order.length === 0);
}

boot().catch((err) => {
  console.error(err);
  $('#empty').hidden = false;
  $('#empty').innerHTML = `<div><h2>UI konnte nicht starten</h2><p>${escapeHtml(String(err.message ?? err))}</p></div>`;
});
