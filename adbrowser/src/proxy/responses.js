/** Standalone responses that the UI, the error pages and the API all share. */

import { Buffer } from 'node:buffer';

export function sendText(res, status, text, extra = {}) {
  const body = Buffer.from(String(text), 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
}

export function sendJson(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(body);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const PAGE_STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e6e9f2;
 font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
.card{max-width:660px;width:100%;padding:26px 28px;border:1px solid #232838;border-radius:16px;
 background:#11141c;box-shadow:0 20px 60px #0009}
h1{margin:0 0 4px;font-size:19px}
p{margin:10px 0;color:#a9b2c9}
code{background:#0a0c12;border:1px solid #1d2231;border-radius:8px;padding:2px 6px;
 font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8fe3b0;word-break:break-all}
.row{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
a.btn,button{appearance:none;border:1px solid #2a3348;background:#161b26;color:#dfe5f5;padding:9px 14px;
 border-radius:10px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}
a.btn:hover,button:hover{border-color:#4d7cff;background:#1b2233}
.muted{color:#6b7793;font-size:12.5px}
`;

export function errorPage({ url, message, code }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chaos ADBrowser · Fehler</title><style>${PAGE_STYLE}</style></head>
<body><div class="card">
<h1>⚠️ Seite konnte nicht geladen werden</h1>
<p><code>${esc(url || 'unbekannte Zieladresse')}</code></p>
<p class="muted">${code ? 'HTTP ' + esc(code) + ' · ' : ''}${esc(message)}</p>
<div class="row">
  <button onclick="try{parent.location.reload()}catch(e){history.back()}">Erneut versuchen</button>
  <a class="btn" href="${esc(url)}" rel="noreferrer noopener" target="_top">Direkt öffnen</a>
</div>
<p class="muted" style="margin-top:16px">Hinweis: Seiten mit strikter IP-/Fingerprint-Prüfung (Google-Logins,
Streaming mit DRM, Captchas) blockieren Proxy-Zugriffe. Werbung und Tracker werden unabhängig davon entfernt.</p>
</div></body></html>`;
}

export function notFoundPage(res, what = 'route') {
  const body = Buffer.from(`<!doctype html><meta charset="utf-8"><title>404</title>
<style>${PAGE_STYLE}</style><div class="card"><h1>404 — ${esc(what)} nicht gefunden</h1>
<p class="muted">Diese Route existiert auf dem Chaos ADBrowser nicht.</p></div>`, 'utf8');
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
  res.end(body);
}
