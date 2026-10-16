import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toProxied, parseProxied, normalizeTarget, originFromUrl } from '../src/encode.js';
import { encOrigin, BoundedMap } from '../src/util.js';
import { CookieJar } from '../src/cookies.js';
import { Store, DEFAULT_SETTINGS, statsOf } from '../src/sessions.js';
import { rewriteHtml, extractTitle } from '../src/proxy/html.js';
import { rewriteCss } from '../src/proxy/css.js';
import { registrableDomain, hostSuffixes } from '../src/adblock/compile.js';

/* ---------------------------- url scheme ---------------------------- */

test('origin encoding is path-safe and reversible', () => {
  for (const o of ['https://de.wikipedia.org', 'http://localhost:6001', 'https://x.co:8443', 'https://xn--80ak6aa92e.com']) {
    const enc = encOrigin(o);
    assert.ok(!/[+/=]/.test(enc), 'must be url-safe: ' + enc);
    assert.equal(Buffer.from(enc, 'base64url').toString('utf8'), o);
  }
});

test('a proxied url keeps path, query and hash untouched', () => {
  const real = 'https://de.wikipedia.org/wiki/Doc?a=1&b=2#Kapitel';
  const p = toProxied('sid1234', real);
  assert.equal(p, `/b/sid1234/p/${encOrigin('https://de.wikipedia.org')}/wiki/Doc?a=1&b=2#Kapitel`);
  const back = parseProxied(p);
  assert.equal(back.sid, 'sid1234');
  assert.equal(back.kind, 'p');
  assert.equal(back.realUrl, real);
  assert.equal(originFromUrl(real), 'https://de.wikipedia.org');
});

test('websocket kind round trips (ws is encoded in the http origin space)', () => {
  const p = toProxied('sid1234', 'wss://echo.example/socket?x=1', 'w');
  const back = parseProxied(p);
  assert.equal(back.kind, 'w');
  assert.equal(back.origin, 'https://echo.example');
  assert.equal(back.realUrl, 'https://echo.example/socket?x=1');
});

test('hostile or malformed proxy paths return null', () => {
  for (const bad of ['/b/x/p/zzz/', '/nope', '/b/sid1234/p//x', '/b/sid1234/p/aGVhZGVyLWluamVjdA/x']) {
    const r = parseProxied(bad);
    assert.ok(r === null || typeof r.realUrl === 'string', 'unexpected shape for ' + bad);
    if (r) assert.ok(/^https?:|^wss?:/.test(r.realUrl), 'never a file:/javascript: target: ' + r.realUrl);
  }
});

test('address bar input becomes a url or a search', () => {
  const tpl = 'https://duckduckgo.com/?q={query}';
  assert.equal(normalizeTarget('de.wikipedia.org/wiki/X', tpl), 'https://de.wikipedia.org/wiki/X');
  assert.equal(normalizeTarget('HTTPS://A.B/c', tpl).toLowerCase(), 'https://a.b/c');
  assert.equal(normalizeTarget('localhost:6001/site', tpl), 'http://localhost:6001/site');
  assert.match(normalizeTarget('wie spät ist es', tpl), /q=wie%20sp%C3%A4t%20ist%20es/);
  assert.equal(normalizeTarget('   ', tpl), null);
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'view-source:https://x', '/just/a/path', '../up']) {
    assert.equal(normalizeTarget(bad, tpl), null, bad);
  }
  assert.equal(normalizeTarget('localhost', tpl), 'http://localhost');
  assert.match(normalizeTarget('duck duck go', tpl), /^https:\/\/duckduckgo\.com\/\?q=duck/);
});

/* ---------------------------- cookies ---------------------------- */

test('parse + match by domain and path', () => {
  const jar = new CookieJar();
  jar.parse('sid=abc; Path=/; Max-Age=600', { url: 'https://shop.example/cart' });
  jar.parse('cart=1; Path=/cart; Domain=.shop.example', { url: 'https://shop.example/cart/x' });
  jar.parse('other=1; Domain=.other.example; Path=/', { url: 'https://other.example/' });
  const h = jar.header('https://shop.example/cart/item');
  assert.match(h, /sid=abc/);
  assert.match(h, /cart=1/);
  assert.ok(!/other/.test(h ?? ''));
  assert.match(jar.header('https://sub.shop.example/'), /sid=abc/, 'domain cookies cover subs');
  assert.ok(!/cart=1/.test(jar.header('https://shop.example/') ?? ''), 'path scope respected');
});

test('longest path first, deletion, expiry', () => {
  const jar = new CookieJar();
  jar.parse('top=1; Path=/', { url: 'https://x.test/a/b' });
  jar.parse('deep=2; Path=/a/b', { url: 'https://x.test/a/b' });
  assert.equal((jar.header('https://x.test/a/b/c') ?? '').split(';')[0], 'deep=2', 'most specific first');
  jar.parse('top=3; Expires=Thu, 01 Jan 1970 00:00:00 GMT', { url: 'https://x.test/' });
  assert.ok(!/top=3/.test(jar.header('https://x.test/a/b') ?? ''), 'expired value must not resurrect');
  const t0 = Date.now();
  jar.parse('soon=1; Max-Age=1', { url: 'https://x.test/', nowTs: t0 });
  assert.match(jar.header('https://x.test/', { nowTs: t0 }) ?? '', /soon=1/);
  assert.ok(!/soon=1/.test(jar.header('https://x.test/', { nowTs: t0 + 5000 }) ?? ''), 'max-age expiry respected');
});

test('Secure over http is refused; HttpOnly never reaches the page', () => {
  const jar = new CookieJar();
  jar.parse('locked=1; Secure; Path=/', { url: 'https://x.test/' });
  assert.match(jar.header('https://x.test/'), /locked=1/);
  assert.equal(jar.header('http://x.test/'), null);
  jar.parse('token=secret; HttpOnly; Path=/', { url: 'https://x.test/' });
  const snap = jar.clientSnapshot('https://x.test/');
  assert.equal(snap.locked, '1');
  assert.equal(snap.token, undefined);
});

test('a same-site Set-Cookie can overwrite a cookie from another host (no pinning)', () => {
  const jar = new CookieJar();
  jar.parse('sid=mine; Path=/', { url: 'https://bank.example/' });
  jar.parse('sid=taken; Path=/; Domain=.bank.example', { url: 'https://bank.example/' });
  assert.equal(jar.header('https://bank.example/'), 'sid=taken');
  const n = jar.size;
  jar.parse('x=1; Domain=.evil.example; Path=/', { url: 'https://bank.example/' });
  assert.equal(jar.size, n, 'an unrelated host cannot write into this jar');
});

test('syncClient: page writes and deletes, HttpOnly survives both', () => {
  const jar = new CookieJar();
  jar.parse('token=secret; HttpOnly; Path=/', { url: 'https://x.test/' });
  jar.parse('old=yes; Path=/', { url: 'https://x.test/' });
  jar.parse('ui=1; Path=/', { url: 'https://other.test/' });
  jar.syncClient('https://x.test/page.html', { fresh: '1' });
  assert.equal(jar.clientSnapshot('https://x.test/').fresh, '1');
  assert.equal(jar.clientSnapshot('https://x.test/').old, undefined, 'deleted in page → deleted in jar');
  assert.match(jar.header('https://x.test/'), /token=secret/);
  assert.equal(jar.clientSnapshot('https://other.test/').ui, '1', 'other hosts untouched');
});

/* ---------------------------- sessions ---------------------------- */

test('store: profiles own tabs, history and the tab cap', () => {
  const store = new Store({ ttlMs: 60000, maxTabs: 3 });
  const p = store.profile(null, { create: true });
  const t = store.tab(p, { url: 'https://a.test/' });
  assert.equal(t.profileId, p.id);
  store.touch(t.id, { url: 'https://a.test/x', title: 'X' });
  assert.equal(store.tabById(t.id).url, 'https://a.test/x');
  const sum = store.summary(p);
  assert.equal(sum.tabs[0].title, 'X');
  assert.equal(sum.history[0].url, 'https://a.test/x');
  assert.ok(statsOf(store.tabById(t.id)).requests >= 0);
  for (let i = 0; i < 6; i++) store.tab(p, { url: `https://a.test/${i}` });
  assert.ok(p.tabs.size <= 3, 'maxTabs enforced, got ' + p.tabs.size);
});

test('pruned tab ids are adopted instead of 404ing forever', () => {
  const store = new Store({ ttlMs: 60000, maxTabs: 2 });
  const p = store.profile(null, { create: true });
  const old = store.tab(p, { url: 'https://a.test/1' });
  store.tab(p, { url: 'https://a.test/2' });
  store.tab(p, { url: 'https://a.test/3' });
  const adopted = store.adoptTab(old.id, p);
  assert.ok(adopted, 'adoptTab returned a tab');
  assert.equal(store.tabById(old.id).profileId, p.id);
});

test('default settings are the "browsing feels normal" set', () => {
  assert.equal(DEFAULT_SETTINGS.adblock, true);
  assert.equal(DEFAULT_SETTINGS.cosmetic, true);
  assert.equal(DEFAULT_SETTINGS.images, true);
  assert.equal(DEFAULT_SETTINGS.media, true);
  assert.equal(DEFAULT_SETTINGS.websockets, true);
  assert.equal(DEFAULT_SETTINGS.scripts, 'allow');
});

/* ---------------------------- util ---------------------------- */

test('hostSuffixes walks full host → registrable domain only', () => {
  assert.deepEqual(hostSuffixes('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com']);
  assert.deepEqual(hostSuffixes('example.com'), ['example.com']);
  assert.deepEqual(hostSuffixes(''), []);
});

test('registrableDomain keeps public suffix + one label', () => {
  assert.equal(registrableDomain('www.foo.example.com'), 'example.com');
  assert.equal(registrableDomain('localhost'), 'localhost');
  assert.equal(registrableDomain('a.b.co.uk'), 'b.co.uk');
});

test('BoundedMap evicts in insertion order', () => {
  const m = new BoundedMap(3);
  for (const k of 'abcd') m.set(k, k.toUpperCase());
  assert.equal(m.size, 3);
  assert.equal(m.get('a'), undefined);
  assert.equal(m.get('d'), 'D');
});

/* ---------------------------- rewriting ---------------------------- */

const CTX = {
  sid: 's1d2',
  docUrl: new URL('https://news.example/sport/index.html?x=1'),
  origin: 'https://news.example',
  kind: 'p',
};
const wrap = (path) => `/b/s1d2/p/${encOrigin('https://news.example')}${path}`;

test('html rewrite: wrapping + security header strip, scripts untouched', () => {
  const html = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src *">
<meta http-equiv="X-Frame-Options" content="deny">
<meta http-equiv="refresh" content="5;url=https://x.example/">
<link rel="stylesheet" href="/style.css">
<link rel="preload" href="/f.woff2" as="font">
</head><body>
<a href="/a/b?c=1">l</a><a href="#frag">f</a><a href="mailto:x@y.z">m</a>
<img src="https://news.example/i.png" srcset="/p.png 1x, https://news.example/p2.png 2x">
<div style="background:url(/bg.png)">s</div>
<script src="/app.js" integrity="sha384-aaa"></script>
<script>var u = "https://news.example/api"; fetch("/other");</script>
<iframe src="https://news.example/embed?a=1&b=2"></iframe>
<form action="/post" method="post"><input name="q"></form>
</body></html>`;
  const out = rewriteHtml(html, CTX);

  assert.ok(!/content-security-policy/i.test(out), 'CSP meta must go');
  assert.ok(!/x-frame-options/i.test(out), 'frame options must go');
  assert.ok(/http-equiv="refresh"[^>]*\/b\/s1d2\/p\//i.test(out), 'a refresh is re-pointed into the proxy instead of escaping');
  assert.ok(!/integrity=/.test(out), 'integrity hashes break on rewritten scripts');

  assert.ok(out.includes(`href="${wrap('/style.css')}"`), 'link wrapped');
  assert.ok(out.includes(`href="${wrap('/f.woff2')}"`), 'preload wrapped');
  assert.match(out, /href="#frag"/, 'fragments stay local');
  assert.match(out, /href="mailto:x@y\.z"/, 'mailto stays');
  assert.ok(out.includes(`href="${wrap('/a/b?c=1')}"`), 'root-relative link wrapped');
  assert.ok(out.includes(`action="${wrap('/post')}"`), 'form action wrapped');
  assert.match(out, /<script>var u = "https:\/\/news\.example\/api"; fetch\("\/other"\);<\/script>/,
    'inline script text must not be rewritten');
  assert.ok(out.includes(`src="${wrap('/app.js')}"`), 'script src wrapped');

  const srcset = /srcset="([^"]+)"/.exec(out)[1];
  for (const part of srcset.split(', ')) {
    assert.ok(part.includes('/b/s1d2/p/'), 'srcset entry unwrapped: ' + part);
  }
  assert.ok(/url\("?\/b\/s1d2\/p\//.test(out), 'inline style url() wrapped');
  const iframe = /<iframe src="([^"]+)"/.exec(out)[1];
  assert.equal(parseProxied(iframe).realUrl, 'https://news.example/embed?a=1&b=2');
});

test('relative urls resolve against the document, not our origin', () => {
  const ctx = { ...CTX, docUrl: new URL('https://news.example/a/b/c.html') };
  const out = rewriteHtml('<a href="../up.html">u</a><img src="sub/p.png">', ctx);
  assert.equal(parseProxied(/href="([^"]+)"/.exec(out)[1]).realUrl, 'https://news.example/a/up.html');
  assert.equal(parseProxied(/src="([^"]+)"/.exec(out)[1]).realUrl, 'https://news.example/a/b/sub/p.png');
});

test('srcdoc / javascript: / data: values are left alone', () => {
  const html = `<iframe srcdoc="<b>hi</b>"></iframe><a href="javascript:void(0)">j</a>
<img src="data:image/png;base64,AA"><img src="blob:https://news.example/x">`;
  const out = rewriteHtml(html, CTX);
  assert.equal(out, html, 'nothing in that set may be rewritten');
});

test('title extraction', () => {
  assert.equal(extractTitle('<title>My &amp; Page</title>'), 'My & Page');
  assert.equal(extractTitle('<h1>x</h1><title>\n a\nb \n</title>'), 'a b');
  assert.equal(extractTitle('<html><body>x</body></html>'), '');
  assert.ok(extractTitle('<title>' + 'x'.repeat(400) + '</title>').length <= 160, 'title is capped');
});

test('css rewrite: url() wrapped, @import dropped, data: kept', () => {
  const css = `@import "https://x.test/a.css";
@media (max-width: 600px) { .a { background: url("/img/a.png") no-repeat; } }
.b { background-image: url('https://news.example/b.png'); }
.c { mask: url(data:image/svg+xml;base64,AAA); }`;
  const out = rewriteCss(css, CTX);
  assert.ok(/@import[^;]*\/b\/s1d2\/p\//.test(out), 'imports are re-pointed at the proxy: ' + out.slice(0, 90));
  assert.ok(out.includes(`url(${wrap('/img/a.png')})`) || out.includes(`url("${wrap('/img/a.png')}")`), out);
  assert.ok(out.includes(wrap('/b.png')), 'absolute same-origin url wrapped');
  assert.ok(out.includes('url(data:image'), 'data urls pass through');
  assert.ok(out.includes('@media'), 'queries stay intact');
});
