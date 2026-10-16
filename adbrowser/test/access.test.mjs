import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { get, post, startServer } from './helpers.mjs';

const CODE = 'demo-code-42';
let srv;
before(async () => { srv = await startServer({ CHAOS_ACCESS_CODE: CODE }); });
after(async () => { await srv.close(); });

const H = (cookie) => ({ headers: cookie ? { cookie } : {} });

test('everything is behind the gate, the healthcheck is not', async () => {
  for (const p of ['/', '/start', '/assets/app.js', '/api/state', '/manifest.webmanifest']) {
    const r = await get(srv.base, p);
    assert.equal(r.status, 401, p + ' must require the code');
    assert.match(r.text, /form[^>]*action="\/access"/i, p + ' must show the login form');
  }
  // the public demo tree is deliberately exempt (the proxy fetches it from itself, cookie-less)
  const demo = await get(srv.base, '/site/news.html');
  assert.equal(demo.status, 200);
  assert.match(demo.text, /CHN S|Nachrichten|<h1>/);

  const h = await get(srv.base, '/healthz');
  assert.equal(h.status, 200, 'docker healthcheck must pass without a cookie');
  assert.equal(h.json().ok, true);
  assert.equal(h.json().gated, true);
});

test('wrong code is refused, right code sets a 30-day cookie', async () => {
  const bad = await post(srv.base, '/access', new URLSearchParams({ code: 'nope' }).toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(bad.status, 401);
  assert.match(bad.text, /Falscher Code/);

  const good = await post(srv.base, '/access', new URLSearchParams({ code: CODE }).toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(good.status, 302);
  assert.equal(good.headers.location, '/');
  const raw = good.headersRaw.getSetCookie?.()[0] ?? good.headers['set-cookie'] ?? '';
  assert.match(raw, /^chaos_access=[^;]+/);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /Max-Age=2592000/i);
  assert.ok(!raw.includes(CODE), 'the code itself must never go into the cookie');

  const cookie = raw.split(';')[0];
  const ui = await get(srv.base, '/', H(cookie));
  assert.equal(ui.status, 200);
  assert.match(ui.text, /id="frames"/);
  const tab0 = '/site/img/photo.svg';
  const api = await get(srv.base, '/api/state', H(cookie));
  assert.equal(api.status, 200);
  assert.equal(api.json().server.accessCode, true);

  // proxy routes need it too — a code-free bypass would leak the whole fetcher
  // the proxy fetches /site/* from itself without a cookie: that internal hop must stay allowed,
  // otherwise a gated instance could not serve its own demo pages
  const anon = await get(srv.base, tab0);
  assert.equal(anon.status, 200, 'public demo files are reachable without the code');

  const tab = await post(srv.base, '/api/tab', { url: srv.base + '/site/news.html' }, H(cookie));
  const { proxied } = tab.json();
  assert.equal((await get(srv.base, proxied, H(cookie))).status, 200);
  assert.equal((await get(srv.base, proxied, H('chaos_access=bogus'))).status, 401);

  const tab2 = await post(srv.base, '/api/tab', { url: srv.base + '/site/selftest.html' }, H(cookie));
  const doc = await get(srv.base, tab2.json().proxied, H(cookie));
  assert.equal(doc.status, 200, 'a gated proxy tab must still be able to load a proxied document');
  assert.match(doc.text, /window\.__UP=/);
  assert.match(doc.text, /blocked by Chaos ADBrowser|__chaos-ab-css/);
});

test('api and proxy routes are gated too', async () => {
  assert.equal((await get(srv.base, '/api/state')).status, 401);
  assert.equal((await post(srv.base, '/api/tab', { url: 'https://example.org/' })).status, 401);
  assert.equal((await get(srv.base, '/metrics')).status, 401);
});

test('access code is not required when unset', async () => {
  const open = await startServer({ CHAOS_ACCESS_CODE: '' });
  try {
    assert.equal((await get(open.base, '/')).status, 200);
    assert.equal((await get(open.base, '/healthz')).json().gated, undefined);
  } finally {
    await open.close();
  }
});
