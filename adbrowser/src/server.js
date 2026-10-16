/**
 * HTTP entry point: routing, session/profile plumbing, the browser UI's own API, static assets
 * and the WebSocket tunnel. Everything URL-shaped goes through src/proxy/handler.js.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import config, { ROOT as APP_ROOT, FILTERS_FILE, DATA_DIR } from './config.js';
import { log, fmtBytes, BoundedMap } from './util.js';
import { AdBlocker } from './adblock/engine.js';
import { compileFilters } from './adblock/compile.js';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { Store, DEFAULT_SETTINGS, statsOf } from './sessions.js';
import { Cache } from './proxy/cache.js';
import { createProxyHandler } from './proxy/handler.js';
import { parseProxied, normalizeTarget, toProxied, P_PREFIX } from './encode.js';
import { bootstrapFor } from './inject/bootstrap.js';
import { sendJson, sendText, notFoundPage, errorPage, PAGE_STYLE } from './proxy/responses.js';
import { attachWebSocketTunnel } from './proxy/ws.js';
import { WebSocketServer } from 'ws';
import { closeAgent } from './proxy/fetcher.js';

const UI_DIR = join(APP_ROOT, 'src', 'ui');
const SITE_DIR = join(APP_ROOT, 'src', 'site');
const INJECT_DIR = join(APP_ROOT, 'src', 'inject');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/*  boot                                                               */
/* ------------------------------------------------------------------ */

function loadFilters() {
  let payload = null;
  let source = FILTERS_FILE;
  try {
    payload = AdBlocker.fromFile(FILTERS_FILE);
  } catch (err) {
    log.warn(`could not read ${FILTERS_FILE}: ${err.message}`);
  }
  if (!payload) {
    // build in memory from whatever is on disk so a fresh checkout still blocks ads
    const lists = {};
    const seed = join(DATA_DIR, 'seed.txt');
    if (existsSync(seed)) lists['seed.txt'] = readFileSync(seed, 'utf8');
    const dir = join(DATA_DIR, 'lists');
    if (existsSync(dir)) {
      for (const f of listTxt(dir)) {
        try { lists[f] = readFileSync(join(dir, f), 'utf8'); } catch { /* skip */ }
      }
    }
    if (!Object.keys(lists).length) {
      log.warn('no filter data found — ad blocking will use defaults only. Run: npm run build:filters');
      payload = compileFilters({ 'inline.txt': '||doubleclick.net^\n||googlesyndication.com^\n' });
      source = 'inline-defaults';
    } else {
      payload = compileFilters(lists);
      source = 'compiled-at-boot (run "npm run build:filters" to cache it)';
    }
  }
  const engine = new AdBlocker(payload, {
    enabled: config.adblock.enabled,
    cosmetic: config.adblock.cosmetic,
    enhanced: config.adblock.enhanced,
    blockDocuments: config.adblock.blockDocuments,
  });
  const c = payload.meta?.counts ?? {};
  log.info(`ad block engine ready — ${c.blockedHosts ?? 0} hosts, ${c.networkRules ?? 0} rules, `
    + `${c.cosmeticHosts ?? 0} cosmetic hosts, ${c.genericSelectors ?? 0} generic selectors (${source})`);
  return engine;
}

function listTxt(dir) {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.txt'));
  } catch {
    return [];
  }
}

export const USER_RULES_FILE = join(DATA_DIR, 'user-rules.txt');

const store = new Store({
  ttlMs: config.sessionTtlMs,
  maxTabs: config.maxTabs,
  maxProfiles: config.maxProfiles,
});
const engine = loadFilters();
const cache = new Cache(config.cache);
const startedAt = Date.now();

const staticCache = new BoundedMap(64);

async function serveStatic(res, req, dir, rel, { immutable = false } = {}) {
  const safe = normalize('/' + rel).replace(/^(\.\.[/\\])+/, '');
  const ext = extname(safe).toLowerCase();
  const file = join(dir, safe);
  if (!file.startsWith(dir)) return notFoundPage(res, 'asset');
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return notFoundPage(res, 'asset');
  }
  let entry = staticCache.get(file);
  if (!entry || entry.mtime !== mtime) {
    const body = await readFile(file);
    entry = { body, mtime, type: MIME[extname(file)] ?? 'application/octet-stream' };
    staticCache.set(file, entry);
  }
  const etag = 'W/"' + createHash('sha1').update(file + ':' + mtime).digest('base64url').slice(0, 20) + '"';
  const headers = {
    'content-type': entry.type,
    etag,
    // html must not sit in a cache (the UI has to update when we update); assets may
    'cache-control': immutable
      ? 'public, max-age=604800, immutable'
      : ext === '.html' ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': headers['cache-control'] });
    return res.end();
  }
  let body = entry.body;
  const ae = req.headers['accept-encoding'] ?? '';
  if (config.compress && body.length > 1200 && /^(text\/|image\/svg|application\/json)/.test(entry.type)) {
    const useBr = ae.includes('br');
    const useGzip = useBr || ae.includes('gzip');
    if (useGzip) {
      const key = file + (useBr ? '?br' : '?gz');
      let enc = staticCache.get(key);
      if (!enc || enc.mtime !== mtime) {
        enc = {
          mtime,
          body: useBr
            ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } })
            : zlib.gzipSync(body, { level: 7 }),
        };
        staticCache.set(key, enc);
      }
      body = enc.body;
      headers['content-encoding'] = useBr ? 'br' : 'gzip';
      headers.vary = 'accept-encoding';
    }
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function profileFor(req, res, { create = true } = {}) {
  const cid = readCookie(req, 'chaos_cid');
  if (cid) {
    const p = store.profile(cid, { create: false });
    if (p) return { profile: p, cid };
  }
  if (!create) return { profile: null, cid: null };
  const fresh = store.profile(null, { create: true });
  res.setHeader('set-cookie', `chaos_cid=${fresh.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  return { profile: fresh, cid: fresh.id };
}

/**
 * A tab always runs inside *its own* profile — that is where its cookies, referrer and settings
 * live. The request cookie only decides which profile's tab list the UI sees; without it (API
 * clients, or a tab restored after the profile pruned) we attach the tab to a fresh profile.
 */
function tabContext(sid, req, res) {
  const reqCtx = profileFor(req, res);
  const tab = store.tabById(sid);
  if (!tab) {
    const adopted = store.adoptTab(sid, reqCtx.profile);
    return adopted ? { tab: adopted, profile: reqCtx.profile } : null;
  }
  const owner = store.profile(tab.profileId, { create: false });
  return { tab, profile: owner ?? reqCtx.profile };
}

function authorized(req) {
  if (!config.accessCode) return true;
  return readCookie(req, 'chaos_access') === accessHash(config.accessCode);
}
function accessHash(code) {
  return createHash('sha256').update('chaos-adb:' + code).digest('base64url').slice(0, 43);
}

const LOGIN_PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Chaos ADBrowser · Zugang</title>
<style>${PAGE_STYLE}</style></head>
<body><form class="card" method="post" action="/access">
<h1>🔐 Chaos ADBrowser</h1>
<p>Dieser Proxy ist mit einem Zugangscode geschützt.</p>
<p><input name="code" type="password" autocomplete="current-password" placeholder="Code"
  style="width:100%;padding:11px 13px;border-radius:10px;border:1px solid #2a3348;background:#0a0c12;color:#e6e9f2;font:inherit"></p>
<div class="row"><button type="submit">Los geht's</button></div>
</form></body></html>`;

export function createServer({ engineOverride } = {}) {
  const ab = engineOverride ?? engine;
  const handle = createProxyHandler({
    engine: ab,
    store,
    cache,
    bootstrapFor,
  });

  const server = http.createServer((req, res) => {
    handleRequest(req, res, { ab, handle }).catch((err) => {
      log.error('unhandled:', err?.stack ?? err);
      if (!res.headersSent) sendText(res, 500, 'internal error');
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 0;
  server.timeout = 0;
  // Demo endpoint so the WebSocket tunnel has something to talk to even with no internet route
  // (a real target site would run its own ws server). Registered *before* the tunnel and it marks
  // the request as handled, so the tunnel does not reject it as "not a proxy route".
  const demoWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url ?? '/').split('?')[0];
    if (p !== '/site/ws-echo') return;
    req.__chaosUpgrade = true;
    demoWss.handleUpgrade(req, socket, head, (ws) => {
      let n = 0;
      ws.send(JSON.stringify({ ok: true, hello: 'chaos demo websocket', ts: Date.now() }));
      ws.on('message', (data, isBinary) => {
        n++;
        ws.send(isBinary ? data : JSON.stringify({ echo: String(data), n }));
      });
    });
  });
  attachWebSocketTunnel(server, { store, engine: ab });
  return server;
}

async function handleRequest(req, res, { ab, handle }) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method.toUpperCase();

  if (authorized(req) === false) {
    if (method === 'POST' && path === '/access') return handleAccess(req, res);
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(LOGIN_PAGE);
  }

  if (path === '/healthz' || path === '/health') {
    return sendJson(res, 200, {
      ok: true, uptime: Math.round((Date.now() - startedAt) / 1000),
      filters: ab.meta?.built ?? null, blockedHosts: ab.info.blockedHosts,
    });
  }
  if (path === '/metrics') {
    return sendJson(res, 200, {
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      profiles: store.profiles.size,
      tabs: store.byTab.size,
      adblock: ab.stats.checked ? { checked: ab.stats.checked, blocked: ab.stats.blocked, allowedByException: ab.stats.allowedByException } : { checked: 0, blocked: 0 },
      cache: cache.stats,
      info: ab.info,
      mem: process.memoryUsage(),
    });
  }

  // ---------------- proxied traffic ----------------
  if (path.startsWith(P_PREFIX)) {
    const session = /^\/b\/([a-z0-9]{4,64})\/(up\.js|api\/[a-z-]+)$/i.exec(path);
    const parsed = session ? null : parseProxied(req.url);
    if (!session && !parsed) return notFoundPage(res, 'proxy route');
    const ctx = tabContext(session ? session[1] : parsed.sid, req, res);
    if (!ctx) return notFoundPage(res, 'unknown tab session');
    if (session && session[2] === 'up.js') {
      return serveStatic(res, req, INJECT_DIR, 'client.js', { immutable: true });
    }
    if (session) return handleSessionApi(req, res, { ...ctx, ab, url });
    if (parsed.kind === 'w') return sendText(res, 426, 'websocket upgrade required');
    return handle(req, res, { ...ctx, parsed });
  }

  // ---------------- own UI + assets ----------------
  if (method === 'GET' || method === 'HEAD' || (method === 'POST' && path === '/site/echo')) {
    if (path === '/' || path === '/index.html') {
      profileFor(req, res); // hand out the profile cookie as early as possible
      return serveStatic(res, req, UI_DIR, 'index.html');
    }
    if (path === '/start') { profileFor(req, res); return serveStartPage(req, res); }
    if (path === '/assets/up.js') return serveStatic(res, req, INJECT_DIR, 'client.js', { immutable: true });
    if (path.startsWith('/assets/')) return serveStatic(res, req, UI_DIR, path.slice(8), { immutable: true });
    if (path === '/site/redirect' || path === '/site/redirect/') {
      // exists so that "redirect handling" is demonstrable without an internet route
      res.writeHead(301, { location: '/site/news.html', 'cache-control': 'no-store' });
      return res.end();
    }
    if (path === '/site/echo' || path === '/site/echo/') {
      let body = '';
      req.setEncoding('utf8');
      for await (const c of req) { body += c; if (body.length > 400_000) break; }
      const seen = {};
      for (let i = 0; i < req.rawHeaders.length; i += 2) seen[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
      const echo = {
        ok: true,
        method: req.method,
        time: new Date().toISOString(),
        receivedHeaders: seen,
        body: body.length > 4000 ? body.slice(0, 4000) + '…' : body,
      };
      return sendJson(res, 200, echo);
    }
    if (path.startsWith('/site/')) return serveStatic(res, req, SITE_DIR, path.slice(6));
    if (path === '/favicon.ico' || path === '/favicon.svg') return serveStatic(res, req, UI_DIR, 'favicon.svg');
    if (path === '/manifest.webmanifest') return sendJson(res, 200, MANIFEST);
  }

  // ---------------- API ----------------
  const { profile, cid } = profileFor(req, res);
  if (path.startsWith('/api/')) return handleApi(req, res, { profile, ab, url, cid });

  if (path === '/' || /^\/(index\.html|start|assets\/|site\/|favicon|manifest)/.test(path)) {
    return sendText(res, 405, 'method not allowed for this route', { allow: 'GET, HEAD' });
  }
  return notFoundPage(res, 'route');
}

const MANIFEST = {
  name: 'Chaos ADBrowser',
  short_name: 'ADBrowser',
  start_url: '/',
  display: 'standalone',
  background_color: '#0b0d12',
  theme_color: '#0b0d12',
  icons: [{ src: '/assets/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
};

function handleAccess(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
  req.on('end', () => {
    const params = new URLSearchParams(body);
    const code = params.get('code') ?? '';
    if (code !== config.accessCode) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE.replace('Los geht', 'Falscher Code — erneut'));
      return;
    }
    res.writeHead(302, {
      location: '/',
      'set-cookie': `chaos_access=${accessHash(code)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    });
    res.end();
  });
}

async function handleApi(req, res, { profile, ab, url }) {
  const method = req.method.toUpperCase();
  const path = url.pathname;
  const json = async () => {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 2_000_000) break; }
    try { return body ? JSON.parse(body) : {}; } catch { return {}; }
  };

  if (path === '/api/state' && method === 'GET') {
    return sendJson(res, 200, {
      profile: store.summary(profile),
      settings: profile.settings,
      userRules: ab.userRuleText ?? '',
      adblock: {
        ...ab.info,
        stats: {
          checked: ab.stats.checked, blocked: ab.stats.blocked,
          top: ab.topBlocked(10),
        },
      },
      cache: cache.stats,
      server: {
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        node: process.version,
        port: config.port,
        isolate: config.isolateSuffix ? 'per-tab origin' : 'same origin',
        accessCode: !!config.accessCode,
      },
      config: {
        searchEngine: config.searchEngine,
        homeUrl: config.homeUrl,
        quickLinks: QUICK_LINKS,
      },
    });
  }
  if (path === '/api/user-rules' && method === 'GET') {
    return sendJson(res, 200, { rules: ab.userRuleText ?? '', counts: ab.info.meta?.counts ?? {} });
  }
  if (path === '/api/settings' && method === 'POST') {
    const patch = await json();
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in patch) profile.settings[k] = patch[k];
    }
    ab.opts.cosmetic = profile.settings.cosmetic;
    ab.opts.enhanced = profile.settings.enhanced;
    ab.opts.blockDocuments = profile.settings.strictDocs || config.adblock.blockDocuments;
    ab.invalidateCaches();
    return sendJson(res, 200, { settings: profile.settings });
  }
  if (path === '/api/user-rules' && method === 'POST') {
    const { rules = '' } = await json();
    const text = String(rules).slice(0, 200000);
    const result = ab.applyUserRules(text);
    ab.userRuleText = text;
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(USER_RULES_FILE, text, 'utf8');
    } catch (err) { log.warn('could not persist user rules: ' + err.message); }
    return sendJson(res, 200, { ok: true, ...result, counts: ab.info.meta.counts });
  }
  if (path === '/api/tab' && method === 'POST') {
    const body = await json();
    const target = body.url ? normalizeTarget(body.url, config.searchEngine) : null;
    const tab = store.tab(profile, { url: target });
    const proxied = target ? toProxied(tab.id, target) : null;
    return sendJson(res, 200, { id: tab.id, url: target, proxied, prefix: `/b/${tab.id}/` });
  }
  if (path === '/api/tab/close' && method === 'POST') {
    const { id } = await json();
    return sendJson(res, 200, { closed: store.closeTab(id) });
  }
  if (path === '/api/resolve' && method === 'GET') {
    const t = normalizeTarget(url.searchParams.get('q') ?? '', config.searchEngine);
    return sendJson(res, 200, { url: t });
  }
  if (path === '/api/clear' && method === 'POST') {
    const { what = 'all' } = await json();
    if (what === 'cache' || what === 'all') cache.clear();
    if (what === 'cookies' || what === 'all') profile.jar.clear();
    if (what === 'history' || what === 'all') profile.history.length = 0;
    if (what === 'all') ab.invalidateCaches();
    return sendJson(res, 200, { ok: true });
  }
  if (path === '/api/filters/update' && method === 'POST') {
    if (!/^(1|true)$/i.test(process.env.CHAOS_ALLOW_FILTER_UPDATE ?? '')) {
      return sendJson(res, 403, { error: 'set CHAOS_ALLOW_FILTER_UPDATE=1 to enable in-place filter updates' });
    }
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [join(APP_ROOT, 'scripts', 'build-filters.mjs')], { stdio: 'ignore', detached: false });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    if (code === 0) {
      const payload = AdBlocker.fromFile(FILTERS_FILE);
      if (payload) {
        ab.loadPayload(payload);
        ab.invalidateCaches();
      }
      return sendJson(res, 200, { ok: true, counts: ab.info.meta.counts });
    }
    return sendJson(res, 500, { error: 'filter build failed with code ' + code });
  }
  return notFoundPage(res, 'api route');
}

async function handleSessionApi(req, res, { tab, profile, ab, url }) {
  const path = url.pathname;
  const method = req.method.toUpperCase();
  if (path.endsWith('/api/cookies') && method === 'POST') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 512_000) break; }
    let map = null;
    try { map = JSON.parse(body || '{}'); } catch { map = null; }
    if (map && typeof map === 'object') {
      profile.jar.syncClient(tab.url ?? url.href, map);
      return sendJson(res, 200, { ok: true, count: Object.keys(map).length });
    }
    return sendJson(res, 400, { error: 'expected a json object' });
  }
  if (path.endsWith('/api/tab') && method === 'GET') {
    return sendJson(res, 200, {
      id: tab.id, url: tab.url, title: tab.title, stats: statsOf(tab),
      settings: profile.settings,
      blocked: ab.stats.blocked,
    });
  }
  if (path.endsWith('/api/navigate') && method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let target = '';
    try { target = (JSON.parse(body || '{}').url ?? '').toString(); } catch { target = body; }
    const real = normalizeTarget(target, config.searchEngine);
    if (!real) return sendJson(res, 400, { error: 'could not understand that address' });
    store.touch(tab.id, { url: real });
    return sendJson(res, 200, { real, proxied: toProxied(tab.id, real) });
  }
  if (path.endsWith('/api/close') && method === 'POST') {
    store.closeTab(tab.id);
    return sendJson(res, 200, { ok: true });
  }
  return sendText(res, 404, 'no such session api');
}

const QUICK_LINKS = [
  { name: 'YouTube', url: 'https://www.youtube.com', color: '#ff0033', ad: 'high' },
  { name: 'Wikipedia', url: 'https://de.wikipedia.org', color: '#3366cc', ad: 'none' },
  { name: 'Reddit', url: 'https://www.reddit.com', color: '#ff4500', ad: 'high' },
  { name: 'GitHub', url: 'https://github.com', color: '#8b5cf6', ad: 'none' },
  { name: 'Spiegel', url: 'https://www.spiegel.de', color: '#e2001a', ad: 'high' },
  { name: 'Heise', url: 'https://www.heise.de', color: '#1f8bd0', ad: 'high' },
  { name: 'Twitch', url: 'https://www.twitch.tv', color: '#9146ff', ad: 'high' },
  { name: 'Wetter.com', url: 'https://www.wetter.com', color: '#0f7bb6', ad: 'high' },
  { name: 'AD-Testseite', url: '/site/news.html', color: '#22c55e', test: true },
];

async function serveStartPage(req, res) {
  const file = join(UI_DIR, 'start.html');
  let html;
  try {
    html = await readFile(file, 'utf8');
  } catch {
    return sendText(res, 500, 'start page missing');
  }
  const links = QUICK_LINKS.map((q) => `<a class="ql" href="${q.test ? q.url : '#'}" data-url="${q.url}"
     style="--c:${q.color}"><span class="dot"></span>${q.name}<em>${q.ad === 'none' ? 'werbefrei' : q.ad === 'high' ? 'viele ads' : ''}</em></a>`).join('');
  html = html.replace('{{QUICK_LINKS}}', links);
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-cache',
  });
  res.end(buf);
}

/* ------------------------------------------------------------------ */
/*  main                                                               */
/* ------------------------------------------------------------------ */

/** Periodic filter rebuild so the payload never rots on a long-lived container. */
function startFilterUpdater() {
  const run = async () => {
    const { spawn } = await import('node:child_process');
    await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(APP_ROOT, 'scripts', 'build-filters.mjs')], { stdio: 'ignore' });
      child.on('exit', async (code) => {
        if (code === 0) {
          const payload = AdBlocker.fromFile(FILTERS_FILE);
          if (payload) {
            const user = engine.userRuleText ?? '';
            engine.loadPayload(payload);
            if (user) engine.applyUserRules(user);
            log.info('filter lists refreshed');
          }
        } else log.warn('filter update failed with code ' + code);
        resolve();
      });
    });
  };
  const t = setInterval(run, config.adblock.updateIntervalMs);
  t.unref?.();
  setTimeout(run, 5000).unref?.();
}

export async function main() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  // user rules survive restarts; loading them is a ~1 ms compile
  if (existsSync(USER_RULES_FILE)) {
    try {
      engine.applyUserRules(readFileSync(USER_RULES_FILE, 'utf8'));
      log.info('loaded custom rules from data/user-rules.txt');
    } catch (err) { log.warn('user rules failed to load: ' + err.message); }
  }
  if (config.adblock.autoUpdate) startFilterUpdater();

  const shown = config.publicBase || `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  log.info(`Chaos ADBrowser listening on ${shown}  (port ${config.port})`);
  log.info(`filters: ${engine.info.blockedHosts} blocked hosts · ${engine.info.rules} network rules · cache ${fmtBytes(cache.stats.bytes)}`);
  if (config.accessCode) log.info('access code protection is ON');
  else log.warn('no CHAOS_ACCESS_CODE set — anyone who can reach this port can browse through it');

  const statsTimer = setInterval(() => {
    log.debug(`cache hit ${cache.stats.hitRate}% · checks ${engine.stats.checked} · blocked ${engine.stats.blocked}`);
  }, 30000);
  statsTimer.unref?.();

  const shutdown = (signal) => {
    log.info(`${signal} — shutting down`);
    clearInterval(statsTimer);
    server.close();
    closeAgent().finally(() => setTimeout(() => process.exit(0), 200).unref());
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err?.stack ?? err));

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  main().catch((err) => {
    log.error(err.stack ?? String(err));
    process.exit(1);
  });
}
