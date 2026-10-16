/**
 * Upstream fetch layer.
 *
 * One undici Agent for the whole process: connections are pooled per origin with keep-alive,
 * which is the single biggest lever on latency for asset-heavy pages (a YouTube watch page opens
 * 60+ requests; without pooling that is 60+ TCP+TLS handshakes).
 */

import { Agent, request as undiciRequest } from 'undici';
import config from '../config.js';

export const dispatcher = new Agent({
  connections: config.connections.connectionsPerOrigin,
  pipelining: config.connections.pipelining,
  keepAliveTimeout: config.connections.keepAliveTimeout,
  keepAliveMaxTimeout: config.connections.keepAliveTimeout * 4,
  allowH2: /^(1|true|yes)$/i.test(process.env.CHAOS_HTTP2 ?? ''),
  connectionsMaxIdleTime: 4000,
  headersTimeout: config.timeouts.headers,
  bodyTimeout: config.timeouts.body,
  connect: {
    timeout: config.timeouts.connect,
    rejectUnauthorized: !/^(0|false)$/i.test(process.env.CHAOS_INSECURE_TLS ?? ''),
  },
});

/** Headers we forward to the target site. Anything else could leak or confuse it. */
const FORWARD_REQUEST = new Set([
  'accept', 'accept-language', 'accept-encoding', 'cache-control', 'content-type', 'content-length',
  'if-none-match', 'if-modified-since', 'origin', 'range', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-dest', 'sec-fetch-storage-access', 'upgrade-insecure-requests', 'purpose',
  'priority', 'referer', 'user-agent', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-model', 'sec-ch-ua-full-version-list', 'x-requested-with',
  'baggage', 'traceparent', 'x-webauthn', 'last-event-id',
]);

/** Response headers that must never reach the browser through the proxy. */
const DROP_RESPONSE = new Set([
  'set-cookie', 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'x-content-type-options', 'strict-transport-security',
  'expect-ct', 'report-to', 'nel', 'server', 'date', 'via', 'cf-ray', 'alt-svc',
  'content-encoding', 'content-length', 'transfer-encoding', 'vary', 'x-xss-protection',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'cross-origin-embedder-policy',
  'access-control-allow-origin', 'access-control-allow-credentials', 'refresh',
]);

export function buildUpstreamHeaders({ method, url, headers, realDocUrl, cookieHeader, userAgent, dnt }) {
  const out = {};
  const isTop = headers['sec-fetch-dest'] === 'document' || headers['sec-fetch-dest'] === undefined;
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!FORWARD_REQUEST.has(key)) continue;
    if (v === undefined || v === null) continue;
    if (key === 'referer' && !config.sendReferer) continue;
    if (key === 'accept-encoding') continue; // we set it ourselves below
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  out['user-agent'] = userAgent || config.userAgents.desktop;
  // zstd is deliberately not offered: the buffered rewrite path would have to decompress it and
  // not every Node build ships a zstd decompressor. gzip/deflate/br cover everything.
  out['accept-encoding'] = 'gzip, deflate, br';
  out['accept-language'] = out['accept-language'] || 'en-US,en;q=0.9,de;q=0.8';
  if (config.dnt && dnt) out['dnt'] = '1';
  if (cookieHeader) out.cookie = cookieHeader;
  if (out.referer && realDocUrl) {
    try {
      const r = new URL(out.referer);
      out.referer = r.origin + r.pathname; // strip query from cross-site referer
    } catch { /* keep */ }
  }
  if (!out.referer && realDocUrl && config.sendReferer) out.referer = realDocUrl;
  if (method === 'GET' || method === 'HEAD') {
    delete out['content-type'];
    delete out['content-length'];
  }
  return out;
}

/**
 * undici gives us a plain headers object (set-cookie arrives as an array), so that is the input.
 * Everything the page must not see — framing, click-jacking guards, our own compression hints — is
 * dropped here; set-cookies are pulled out and handled by the session jar instead.
 */
export function filterResponseHeaders(uh, { canRewrite = false } = {}) {
  const out = {};
  const setCookies = [];
  const pairs = [];
  for (const [key, value] of Object.entries(uh ?? {})) {
    const k = String(key).toLowerCase();
    const arr = (Array.isArray(value) ? value : [value]).filter((v) => v !== undefined && v !== null);
    if (k === 'set-cookie') {
      for (const c of arr) setCookies.push(String(c));
      continue;
    }
    const joined = arr.join(', ');
    pairs.push([k, joined]);
    if (DROP_RESPONSE.has(k)) continue;
    if (k === 'link' && /rel=["']?preconnect/i.test(joined)) continue;
    if (k === 'cache-control' && canRewrite) continue; // we set our own for rewritten docs
    out[k] = arr.length > 1 ? arr : joined;
  }
  return { headers: out, setCookies, pairs };
}

/** every Set-Cookie of an undici response, flattened */
export function setCookiesOf(uh) {
  const v = uh?.['set-cookie'];
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

/**
 * @returns {Promise<{statusCode, headers, rawHeaders, body, url, size?}>}
 */
export async function fetchUpstream({ url, method = 'GET', headers, body, signal, maxRedirects = 0 }) {
  const res = await undiciRequest(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
    dispatcher,
    signal,
    maxRedirections: 0,
    headersTimeout: config.timeouts.headers,
    bodyTimeout: config.timeouts.body,
  });
  return res;
}

/** Turn an undici/socket error into something a human can act on. */
export function describeFetchError(err) {
  const code = err?.cause?.code ?? err?.code ?? '';
  const msg = String(err?.cause?.message ?? err?.message ?? err);
  if (/aborted|timeout/i.test(msg) || /TIMEOUT/i.test(code)) return 'Zeitüberschreitung beim Aufbau (' + code + ')';
  switch (code) {
    case 'ENOTFOUND': case 'EAI_AGAIN': return 'Domain nicht auflösbar: ' + msg.replace(/^getaddrinfo\s+/i, '');
    case 'ECONNREFUSED': return 'Port verweigert die Verbindung';
    case 'ECONNRESET': case 'EPIPE': return 'Verbindung zurückgesetzt';
    case 'EHOSTUNREACH': case 'ENETUNREACH': case 'ENETDOWN': return 'Ziel nicht erreichbar';
    case 'ETIMEDOUT': return 'Verbindung läuft aus';
    case 'CERT_HAS_EXPIRED': case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE': case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN': case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'TLS-Zertifikat ungültig: ' + code;
    default: break;
  }
  if (/self[- ]signed|certificate|unable to verify/i.test(msg)) return 'TLS-Problem: ' + msg;
  const short = msg.split('\n')[0].slice(0, 180);
  return short || 'Verbindung fehlgeschlagen';
}

export function closeAgent() {
  return dispatcher.close().catch(() => {});
}

export { config };
