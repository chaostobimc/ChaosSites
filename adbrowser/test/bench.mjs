/**
 * Performance bench — run with `npm run bench`.
 *
 * Numbers to compare against when changing the hot paths (filter matching, rewriting, caching).
 * The end-to-end part measures our own overhead: the same bytes are fetched through the proxy and
 * straight from the origin, so the difference is what the proxy costs per request.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

import { AdBlocker } from '../src/adblock/engine.js';
import { FILTERS_FILE } from '../src/config.js';
import { rewriteHtml, extractTitle } from '../src/proxy/html.js';
import { encOrigin } from '../src/util.js';

const N = 200_000;
const results = [];
function record(name, ops, ns) {
  const perSec = ops / (ns / 1e9);
  results.push({ name, ops, perSec: Math.round(perSec), us: (ns / ops / 1000).toFixed(3) });
}
function bench(name, ops, fn) {
  fn(); // warm up (JIT + caches)
  const t0 = process.hrtime.bigint();
  fn();
  const ns = Number(process.hrtime.bigint() - t0);
  record(name, ops, ns);
}

/* ---------------- 1. filter engine ---------------- */

const ab = new AdBlocker(AdBlocker.fromFile(FILTERS_FILE));
const hosts = [
  'news.example.com', 'cdn.shop.example.org', 'images.blog.example.net', 'static.video.example.io',
  'pagead2.googlesyndication.com', 'doubleclick.net', 'google-analytics.com', 'www.youtube.com',
];
const paths = [
  '/index.html', '/app.min.js', '/style.css', '/img/logo.svg', '/adserver/track.js',
  '/pagead/js/adsbygoogle.js', '/static/1x1-transparent.gif', '/api/v1/feed?page=2',
];
const types = ['document', 'script', 'stylesheet', 'image', 'xmlhttprequest', 'media'];

const workload = [];
for (let i = 0; i < N; i++) {
  const host = hosts[i % hosts.length];
  const path = paths[(i * 7) % paths.length];
  const url = `https://${host}${path}?r=${i % 97}`;
  workload.push({
    url, host,
    pageHost: hosts[(i * 3) % hosts.length],
    type: types[i % types.length],
    topLevel: i % 40 === 0,
  });
}

let blocked = 0;
bench(`engine.match × ${N.toLocaleString('de-DE')} (mixed, cached)`, N, () => {
  blocked = 0;
  for (const req of workload) if (ab.match(req)) blocked++;
});
const fresh = new AdBlocker(AdBlocker.fromFile(FILTERS_FILE));
fresh.cacheCap = 1; // effectively disable the decision cache
const unique = workload.map((r, i) => ({ ...r, url: r.url.replace('r=', 'n' + (i % 997) + 'r=') }));
let b2 = 0;
bench(`engine.match × 20k (uncached, cold path)`, 20_000, () => {
  b2 = 0;
  for (let k = 0; k < 20_000 / 10_000; k++) for (let i = 0; i < 10_000; i++) if (fresh.match(unique[i])) b2++;
});
bench('cosmeticCss per host × 5k', 5_000, () => {
  for (let i = 0; i < 5_000; i++) ab.cosmeticCss(hosts[i % hosts.length]);
});
const bigCss = ab.cosmeticCss('www.youtube.com');

/* ---------------- 2. rewriting ---------------- */

const doc = `<!doctype html><html><head><title>bench</title>${'<link rel="stylesheet" href="/s.css">'.repeat(20)}
</head><body>${'<div class="row"><a href="/a/b?x=1">t</a><img src="p.png" srcset="/q.png 2x"></div>'.repeat(400)}
<script src="/app.js"></script></body></html>`;
const ctx = { sid: 's1d2', docUrl: new URL('https://news.example/sport/index.html'), origin: 'https://news.example', kind: 'p' };
bench(`rewriteHtml ${(doc.length / 1024).toFixed(0)} KB × 200`, 200, () => rewriteHtml(doc, ctx));
bench('extractTitle × 20k', 20_000, () => { for (let i = 0; i < 20_000; i++) extractTitle(doc); });

/* ---------------- 3. end to end through a live server ---------------- */

const srv = await startServer();
try {
  const tab = await (await fetch(srv.base + '/api/tab', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: srv.base + '/site/news.html' }),
  })).json();
  const proxied = srv.base + tab.proxied;
  const direct = srv.base + '/site/news.html';
  const DOCS = 400;
  await fetch(proxied); // warm
  let t0 = Date.now();
  for (let i = 0; i < DOCS / 8; i++) {
    await Promise.all([fetch(proxied), fetch(proxied), fetch(proxied), fetch(proxied),
      fetch(proxied), fetch(proxied), fetch(proxied), fetch(proxied)]);
  }
  const proxiedMs = Date.now() - t0;
  t0 = Date.now();
  for (let i = 0; i < DOCS / 8; i++) {
    await Promise.all([fetch(direct), fetch(direct), fetch(direct), fetch(direct),
      fetch(direct), fetch(direct), fetch(direct), fetch(direct)]);
  }
  const directMs = Date.now() - t0;
  record(`proxy: ${DOCS} documents (8 parallel)`, DOCS, proxiedMs * 1e6);
  record(`origin: ${DOCS} documents (baseline)`, DOCS, directMs * 1e6);

  // 100 different sub-resources, cold then warm (object cache)
  const assets = Array.from({ length: 60 }, (_, i) => `${srv.base}${tab.proxied.replace('/site/news.html', '')}/site/app.js?v=${i}`);
  t0 = Date.now();
  await Promise.all(assets.map((u) => fetch(u)));
  const coldMs = Date.now() - t0;
  t0 = Date.now();
  await Promise.all(assets.map((u) => fetch(u)));
  const warmMs = Date.now() - t0;
  record(`60 assets cold (rewrite+cache store)`, 60, coldMs * 1e6);
  record(`60 assets warm (object cache hit)`, 60, warmMs * 1e6);

  // cold start of a fresh container-equivalent process
  t0 = Date.now();
  const boot = await startServer();
  const bootMs = Date.now() - t0;
  await boot.close();
  results.push({ name: 'process boot → /healthz ready', ops: 1, perSec: Math.round(1000 / bootMs), us: bootMs * 1000 });
  await srv.close();
} finally {
  await srv.close().catch(() => {});
}

/* ---------------- report ---------------- */

const pad = (s, n) => String(s).padEnd(n);
console.log('\nChaos ADBrowser · bench (' + process.version + ', ' + N.toLocaleString('de-DE') + ' workload items)\n');
console.log(pad('measurement', 48) + pad('ops', 10) + pad('ops/s', 14) + 'µs/op');
console.log('-'.repeat(86));
for (const r of results) {
  console.log(pad(r.name, 48) + pad(r.ops.toLocaleString('de-DE'), 10)
    + pad(r.perSec.toLocaleString('de-DE'), 14) + r.us);
}
console.log('-'.repeat(86));
console.log(`verdicts: ${blocked} blocked / ${N} (cached pass), ${b2} (cold pass)`);
console.log(`youtube cosmetic css: ${(bigCss.length / 1024).toFixed(1)} KB, injected once per document\n`);

/* ---------------- helpers ---------------- */

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), CHAOS_LOG_LEVEL: 'error', CHAOS_FILTERS_AUTO_UPDATE: '0' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* not yet */ }
    await delay(50);
  }
  let closed = false;
  return {
    base, port,
    async close() {
      if (closed) return;
      closed = true;
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit').catch(() => {});
    },
  };
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
