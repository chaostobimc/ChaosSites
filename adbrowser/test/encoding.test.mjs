/**
 * Everything in this file exists because of one symptom: "I searched for something and the tab stayed
 * a black page." A proxied document that cannot be decoded is not an error the browser shows — it is
 * either garbage HTML or an empty frame, so the proxy must always answer with *either* a readable
 * document *or* a page that explains itself.
 *
 * The fixture upstream behaves like a real CDN that is *allowed* to lie: it compresses with the codec
 * named by the case (offered or not), announces it in `content-encoding` and records the
 * `accept-encoding` it saw, so the retry logic can be asserted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { once } from 'node:events';

import { get, openTab, startServer } from './helpers.mjs';

const PAGE = (n = 60) => {
  let s = '<!doctype html><html><head><meta charset="utf-8"><title>Serp — Grüße</title>'
    + '<link rel="stylesheet" href="/s/main.css"></head><body>';
  for (let i = 0; i < n; i++) s += `<div class="r"><a href="/wiki/Item_${i}?q=a+b">Item ${i}</a></div>`;
  return s + '</body></html>';
};

/** case name -> [content-encoding header, encoder, honorsAcceptEncoding] */
const CASES = {
  'identity': () => ['identity', (b) => b],
  'gzip': () => ['gzip', (b) => b],
  'br': () => ['br', (b) => zlib.brotliCompressSync(b)],
  'raw-deflate': () => ['deflate', (b) => zlib.deflateRawSync(b)],
  'double-gzip': () => ['gzip, gzip', (b) => zlib.gzipSync(zlib.gzipSync(b))],
  'gzip-header-but-plain': () => ['gzip', (b) => b], // a middlebox already decoded it
  'unsupported-codec': () => ['compress', () => Buffer.from('\x00\x01\x02binary\x00\x03'.repeat(50))],
  'empty': () => ['identity', () => Buffer.alloc(0)],
  'file': () => ['identity', () => Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj <<>> endobj\n', 'latin1')],
};

const seen = [];
let upstream;
let base;
let app;
let tab;

function freePort() {
  const s = net.createServer();
  s.listen(0, '127.0.0.1');
  return once(s, 'listening').then(() => { const { port } = s.address(); s.close(); return port; });
}

before(async () => {
  const port = await freePort();
  upstream = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = u.searchParams.get('case') || 'identity';
    const encHeader = String(req.headers['accept-encoding'] ?? '');
    seen.push({ name, ae: encHeader });
    const make = CASES[name];
    if (!make) { res.writeHead(404).end('no such case'); return; }
    const [claimed, encode] = make();
    const buf = encode(Buffer.from(PAGE(), 'utf8'));
    const headers = {
      'content-type': name === 'file' ? 'application/pdf' : 'text/html; charset=UTF-8',
      'content-length': String(buf.length),
    };
    if (name === 'file') headers['content-disposition'] = 'attachment; filename="Jahresbericht 2026.pdf"';
    if (claimed !== 'identity') headers['content-encoding'] = claimed;
    res.writeHead(200, headers);
    res.end(buf);
  });
  await new Promise((r) => upstream.listen(port, '127.0.0.1', r));
  app = await startServer({ CHAOS_ALLOW_PRIVATE: '1', CHAOS_ADBLOCK: '1', CHAOS_LOG_LEVEL: 'silent' });
  base = app.base;
  const up = `http://127.0.0.1:${port}`;
  tab = await openTab(base, `${up}/search?case=identity`);
  tab.up = up;
});

after(async () => {
  await app?.close();
  upstream?.close();
});

const proxiedFor = (pathAndQuery) => {
  const enc = Buffer.from(new URL(tab.up).origin).toString('base64url');
  return `/b/${tab.id}/p/${enc}${pathAndQuery}`;
};
const fetchDoc = (name, headers = {}) => get(base, proxiedFor(`/search?case=${encodeURIComponent(name)}`), {
  headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', ...headers },
});
const renders = (r) => r.status === 200 && /window\.__UP=/.test(r.text) && /Item 59/.test(r.text)
  && /\/b\/[0-9a-f]+\/p\/[A-Za-z0-9_-]+\/wiki\/Item_0/.test(r.text);

test('a SERP-shaped document survives every normal content-encoding', async () => {
  for (const name of ['identity', 'gzip', 'br']) {
    const r = await fetchDoc(name);
    assert.ok(renders(r), `${name}: browser would render nothing — got ${r.status} ${r.body.length}B`);
  }
});

test('raw deflate behind "content-encoding: deflate" still renders', async () => {
  const r = await fetchDoc('raw-deflate');
  assert.ok(renders(r), 'deflate fallback missing: ' + r.body.subarray(0, 40));
});

test('double-encoded bodies (gzip, gzip) still render', async () => {
  const r = await fetchDoc('double-gzip');
  assert.ok(renders(r), 'double gzip passed through as text');
});

test('"content-encoding: gzip" on plain bytes is treated as plain text, not garbage', async () => {
  const r = await fetchDoc('gzip-header-but-plain');
  assert.ok(renders(r), 'lied header turned text into a black page');
});

test('an undecodable body is retried with identity and never emitted as HTML', async () => {
  seen.length = 0;
  const r = await fetchDoc('unsupported-codec');
  assert.equal(r.status, 502);
  assert.match(r.text, /nicht lesbar/);
  assert.match(r.text, /Erneut versuchen/);
  assert.ok(!r.body.includes(0), 'binary noise must never reach the browser as a document');
  const retries = seen.filter((s) => s.name === 'unsupported-codec');
  assert.equal(retries.length, 2, 'expected one identity retry, saw ' + JSON.stringify(retries));
  assert.equal(retries[1].ae, 'identity', 'second attempt must ask for plain bytes');
  // and the origin is now remembered: a normal case on the same host is served uncompressed, fine
  const after = await fetchDoc('gzip');
  assert.ok(renders(after), 'after the identity fallback the site must still work');
  assert.ok(seen.some((s) => s.name === 'gzip' && s.ae === 'identity'), 'sticky identity for this host');
});

test('an empty HTTP 200 document explains itself instead of showing a black frame', async () => {
  const r = await fetchDoc('empty');
  assert.equal(r.status, 502);
  assert.match(r.text, /leer/);
  assert.match(r.text, /Chaos ADBrowser/);
});

test('an empty embedded frame gets an empty document, not our error page', async () => {
  const r = await fetchDoc('empty', { 'sec-fetch-dest': 'iframe', 'sec-fetch-is-nested-navigation': '?1' });
  assert.equal(r.status, 200);
  assert.ok(!/Chaos ADBrowser · Fehler/.test(r.text), 'our card must not appear inside somebody elses iframe');
});

test('a file instead of a page offers a download instead of leaving a blank tab', async () => {
  const r = await fetchDoc('file');
  assert.equal(r.status, 200);
  assert.match(r.text, /Diese Adresse ist eine Datei/);
  assert.match(r.text, /Jahresbericht 2026\.pdf/);
  assert.match(r.text, /download/);
  assert.equal(r.headersRaw.get('content-disposition'), null, 'we must not tell the frame to download');
  // following our own link sends sec-fetch-dest: download → the bytes stream through untouched
  const d = await get(base, proxiedFor('/search?case=file'), {
    headers: { 'sec-fetch-dest': 'download', 'sec-fetch-mode': 'no-cors' },
  });
  assert.equal(d.status, 200);
  assert.match(d.headers['content-type'], /pdf/);
  assert.match(d.headers['content-disposition'], /attachment/);
});

test('header values we compose stay on one line and inside latin1', async () => {
  const r = await fetchDoc('unsupported-codec');
  const err = r.headersRaw.get('x-chaos-error') ?? '';
  assert.ok(err.length > 0);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(err, /[\x00-\x1f\x7f]/);
  assert.ok([...err].every((c) => c.codePointAt(0) <= 0xff), 'x-chaos-error must be latin1-safe: ' + err);
});
