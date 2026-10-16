/**
 * URL codec for the proxy.
 *
 * A proxied URL looks like:   /b/<sid>/<kind>/<enc(origin)>/<path>?<query>#<frag>
 *
 * Keeping the *path* in the clear (only the origin is encoded) is what makes the whole thing
 * fast and robust: the browser resolves relative URLs against the iframe document URL, and
 * because our prefix + path space mirrors the target's, `img.png` or `../x.css` already point
 * at the right proxied URL without any rewriting at all. Only absolute and root-relative URLs
 * need to be touched, and the client-side runtime fixes the dynamic ones.
 */

import { encOrigin, decOrigin } from './util.js';

export const P_PREFIX = '/b/';
export const KIND = { page: 'p', ws: 'w', asset: 'a' };

export function originFromUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** absolute real URL -> proxied absolute path (query/hash preserved) */
export function toProxied(sid, absUrl, kind = KIND.page) {
  let u;
  try { u = new URL(absUrl); } catch { return null; }
  // ws(s) shares the http(s) origin space: it is encoded as http(s) and the tunnel turns it back
  const ws = u.protocol === 'ws:' || u.protocol === 'wss:';
  if (!/^https?:$/.test(u.protocol) && !ws) return null;
  if (ws) u = new URL(u.href.replace(/^ws/, 'http'));
  u.username = '';
  u.password = '';
  const path = u.pathname || '/';
  const hash = u.hash || '';
  // pathname/search arrive pre-encoded from URL(); passing them through untouched means
  // "%2F" and friends survive a round trip, which decoding would not.
  return `${P_PREFIX}${sid}/${kind}/${encOrigin(u.origin)}${path}${u.search || ''}${hash}`;
}

/** proxied path -> { sid, kind, origin, realUrl } or null when malformed */
export function parseProxied(rawUrl) {
  const qIdx = rawUrl.indexOf('?');
  const search = qIdx >= 0 ? rawUrl.slice(qIdx) : '';
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const hashIdx = pathname.indexOf('#');
  const hash = hashIdx >= 0 ? pathname.slice(hashIdx) : '';
  const path = hashIdx >= 0 ? pathname.slice(0, hashIdx) : pathname;

  if (!path.startsWith(P_PREFIX)) return null;
  const rest = path.slice(P_PREFIX.length);
  const bits = rest.split('/');
  if (bits.length < 3) return null;
  const [sid, kind, enc] = bits;
  if (sid.length < 4 || sid.length > 64 || !/^[a-z0-9]+$/i.test(sid)) return null;
  const origin = decOrigin(enc);
  if (!origin) return null;
  const tail = '/' + bits.slice(3).join('/');
  const realPath = tail || '/';
  return { sid, kind, origin, tail: realPath, realUrl: origin + realPath + search + hash };
}

/** real absolute URL inside a proxied page -> proxied URL (used by the HTML rewriter) */
export function rewriteUrlAttribute(value, ctx) {
  const raw = value.trim();
  if (!raw) return null;
  if (raw[0] === '#') return null; // in-page anchor: let the browser scroll, don't navigate
  if (/^(data|blob|about|javascript|mailto|tel|sms|file|chrome|geo|ws|wss):/i.test(raw)) return null;
  if (raw.startsWith('//')) return toProxied(ctx.sid, ctx.docUrl.protocol + raw, ctx.kind);
  if (/^https?:\/\//i.test(raw)) return toProxied(ctx.sid, raw, ctx.kind);
  if (raw.startsWith(P_PREFIX)) return raw; // already proxied
  if (raw.startsWith('/')) return toProxied(ctx.sid, ctx.origin + raw, ctx.kind);
  // relative: resolve against the *real* document URL, then re-proxy
  try {
    return toProxied(ctx.sid, new URL(raw, ctx.docUrl).href, ctx.kind);
  } catch {
    return null;
  }
}

export function normalizeTarget(input, searchEngine) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?([/?#]|$)/i.test(s)) return 'http://' + s; // looks like a scheme, is a host
  // any other explicit scheme (javascript:, data:, file:, view-source:) is a mistake or an attack
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  if (/^\/|^\./.test(s)) return null; // bare paths are not addresses
  const hostish = /^[a-z0-9\-.]+\.[a-z]{2,}(:\d+)?([\/?#]|$)/i.test(s);
  const v4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?([\/?#]|$)/.test(s);
  if ((hostish || v4) && !/\s/.test(s)) return (v4 ? 'http://' : 'https://') + s;
  if (s === 'localhost' || /^localhost:\d+([\/?#]|$)/.test(s)) return 'http://' + s;
  if (/^\[[0-9a-f:]+\](:\d+)?([\/?#]|$)/i.test(s)) return 'http://' + s; // ipv6 literal
  const engine = searchEngine || 'https://duckduckgo.com/?q={query}';
  return /\{query\}/.test(engine)
    ? engine.replace(/\{query\}/, encodeURIComponent(s))
    : engine + (engine.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(s);
}

export function isProxiedPath(pathname) {
  return pathname.startsWith(P_PREFIX);
}
