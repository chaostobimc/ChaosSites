/**
 * The proxy request pipeline.
 *
 *   policy -> ad blocking -> upstream fetch (pooled) -> header sanitation -> body rewrite
 *
 * Only `text/html` and `text/css` are touched. Everything else — images, fonts, wasm, video,
 * already-compressed JS — is streamed through byte-for-byte with its original content-encoding,
 * so nothing is ever decompressed and re-compressed on the way to the browser. That is the
 * difference between "a proxy that works" and "a proxy that feels instant".
 */

import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

import config from '../config.js';
import { log, hostOf, pathOf, fmtBytes } from '../util.js';
import { toProxied } from '../encode.js';
import { rewriteHtml, extractTitle } from './html.js';
import { rewriteCss } from './css.js';
import { fetchUpstream, buildUpstreamHeaders, filterResponseHeaders, describeFetchError,
  setCookiesOf } from './fetcher.js';
import { stripTrackingParams } from '../sessions.js';
import { errorPage, sendText, downloadPage } from './responses.js';
import { decodeBody, looksTextual, headerText } from './decode.js';
import { BoundedMap } from '../util.js';

const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
export const EMPTY_JS = Buffer.from('/* blocked by Chaos ADBrowser */void 0;', 'utf8');
export const EMPTY_CSS = Buffer.from('/* blocked by Chaos ADBrowser */', 'utf8');

const CACHED_TYPES = new Set(['image', 'font', 'stylesheet', 'script', 'object', 'other']);
/**
 * Origins whose `content-encoding` header does not describe their bytes. They get `identity` from
 * then on (we ask once, fail once, never twice) — the alternative is a black page for the user.
 */
const BAD_ENCODING = new BoundedMap(4000);
const REWRITE_LIMIT = config.maxRewriteBytes;

export class ProxyError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {{engine:object, store:object, cache:object, bootstrapFor:Function}} deps
 */
export function createProxyHandler(deps) {
  const { engine, store, cache, bootstrapFor } = deps;

  return async function handleProxiedRequest(req, res, { tab, profile, parsed, forceIdentity = false }) {
    const settings = profile.settings;
    const headers = req.headers;
    const dest = headers['sec-fetch-dest'] ?? '';
    const mode = headers['sec-fetch-mode'] ?? '';
    const method = (req.method ?? 'GET').toUpperCase();
    const upstream = decideUrl(parsed.realUrl, settings);
    const host = hostOf(upstream).toLowerCase();
    const type = resourceType(dest, upstream, method);
    const isNavigation = (dest === 'document' || dest === 'iframe' || dest === '') && mode === 'navigate';
    const stats = tab.stats;
    stats.requests++;
    if (profile) profile.stats.requests++;

    // ---------- policy ----------
    const policy = checkPolicy(upstream, settings);
    if (policy) return deny(res, req, policy, isNavigation, type);

    // ---------- ad blocking ----------
    let blockInfo = null;
    if (settings.adblock && engine.opts.enabled) {
      blockInfo = engine.match({
        url: upstream,
        host,
        pageHost: hostOf(tab.url ?? '').toLowerCase(),
        type,
        topLevel: isNavigation && sameUrl(upstream, tab.url),
      });
    }
    if (blockInfo && !(isNavigation && !settings.strictDocs)) {
      stats.blocked++;
      stats.savedBytes += estimateAdBytes(type);
      bumpHost(stats, host);
      if (profile) { profile.stats.blocked++; profile.stats.savedBytes += estimateAdBytes(type); }
      return respondBlocked(res, type, method);
    }
    if (!settings.images && type === 'image') return respondBlocked(res, 'image', method);
    if (settings.scripts === 'block' && type === 'script') return respondBlocked(res, 'script', method);
    if (!settings.media && type === 'media') return respondBlocked(res, 'media', method);

    if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'].includes(method)) {
      return sendText(res, 405, 'method not allowed');
    }

    // ---------- object cache ----------
    const cacheable = config.cache.enabled && (method === 'GET' || method === 'HEAD')
      && CACHED_TYPES.has(type) && !isNavigation;
    const cacheKey = `${settings.desktopUa ? 'd' : 'm'}|${type}|${upstream}`;
    if (cacheable) {
      const hit = cache.get(cacheKey);
      if (hit) {
        res.writeHead(200, { ...hit.headers, 'x-chaos-cache': 'HIT' });
        if (method === 'HEAD') return res.end();
        stats.bytes += hit.bytes;
        return res.end(hit.body);
      }
    }

    // ---------- upstream ----------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), config.timeouts.total);
    const abortOnClose = () => controller.abort(new Error('client closed'));
    res.on('close', abortOnClose);
    const done = () => { clearTimeout(timer); res.off('close', abortOnClose); };

    const cookieHeader = profile.jar.header(upstream, {});
    const outHeaders = buildUpstreamHeaders({
      method,
      headers,
      realDocUrl: isNavigation ? null : tab.url,
      cookieHeader,
      userAgent: settings.desktopUa ? config.userAgents.desktop : config.userAgents.mobile,
      dnt: settings.stripTracking,
    });
    if (!isNavigation && tab.referrer) outHeaders.referer = tab.referrer;
    if (cookieHeader) outHeaders.cookie = cookieHeader;
    // A host that once lied about its encoding is only ever asked for plain bytes.
    if (forceIdentity || BAD_ENCODING.has(host)) outHeaders['accept-encoding'] = 'identity';

    let up;
    try {
      up = await fetchUpstream({
        url: upstream,
        method,
        headers: outHeaders,
        // undici.request() consumes a node Readable directly — no stream conversion needed
        body: method === 'GET' || method === 'HEAD' ? undefined : req,
        signal: controller.signal,
      });
    } catch (err) {
      done();
      const msg = describeFetchError(err);
      log.debug(`${method} ${upstream} -> ${msg}`);
      if (isNavigation) return showError(res, upstream, msg, 502);
      return sendText(res, 502, msg);
    }

    const { statusCode, headers: uh, body } = up;

    // ---------- redirects ----------
    if (statusCode >= 300 && statusCode < 400 && uh.location) {
      for (const c of setCookiesOf(uh)) profile.jar.parse(c, { url: upstream });
      let next = null;
      try { next = new URL(String(uh.location), upstream).href; } catch { /* bogus location */ }
      done();
      discard(body);
      if (!next) return sendText(res, 502, 'bad redirect target');
      const proxied = toProxied(tab.id, next) ?? next;
      store.touch(tab.id, { url: next, redirectFrom: upstream });
      res.writeHead(statusCode === 307 || statusCode === 308 ? statusCode : 302, {
        location: proxied,
        'cache-control': 'no-store',
        'x-chaos-redirect': headerText(next, 300),
      });
      return res.end();
    }

    // ---------- response headers ----------
    const { headers: out, setCookies } = filterResponseHeaders(uh, { canRewrite: false });
    for (const c of setCookies) profile.jar.parse(c, { url: upstream });

    if (statusCode === 304) {
      out['cache-control'] = 'no-cache';
      res.writeHead(304, out);
      done();
      return res.end();
    }

    const contentType = String(uh['content-type'] ?? '').toLowerCase();
    const isHtml = /text\/html|application\/xhtml\+xml/.test(contentType);
    const isCss = /text\/css/.test(contentType);
    const isRewritable = (isHtml || isCss) && statusCode < 400
      && Number(uh['content-length'] ?? 1) <= REWRITE_LIMIT;

    // ---------- a file, not a page ----------
    // attachment (or a binary mime) on a top-level navigation must never be streamed into the tab:
    // Chrome would download it and leave the frame blank, which looks exactly like a broken proxy.
    const disposition = String(uh['content-disposition'] ?? '');
    if (/^\s*attachment/i.test(disposition) && isTopDocument(headers, dest) && method === 'GET') {
      discard(body);
      done();
      const filename = (/filename\*?\s*=\s*"?([^";]+)/i.exec(disposition)?.[1] ?? '').trim();
      return downloadPage(res, {
        url: upstream,
        filename: filename || decodeURIComponent(hostOf(upstream) + pathOf(upstream)).split('/').pop(),
        size: uh['content-length'] ? fmtBytes(Number(uh['content-length'])) : '',
        mime: contentType.split(';')[0],
        proxiedUrl: toProxied(tab.id, upstream) ?? upstream,
      });
    }

    // ---------- streaming passthrough ----------
    if (!isRewritable) {
      const pass = { ...out };
      if (uh['content-length']) pass['content-length'] = uh['content-length'];
      if (uh['content-encoding']) pass['content-encoding'] = uh['content-encoding'];
      if (uh['content-range']) pass['content-range'] = uh['content-range'];
      if (isHtml || isCss) pass['content-type'] = contentType.split(';')[0].trim() + '; charset=utf-8';
      const canBrowserCache = cacheable && (mayCache(uh) || isAssetCacheable(contentType, statusCode));
      pass['cache-control'] = canBrowserCache
        ? `public, max-age=${Math.round(config.cache.browserTtlMs / 1000)}`
        : (pass['cache-control'] || 'no-cache');
      res.writeHead(statusCode, pass);
      if (method === 'HEAD') { done(); discard(body); return res.end(); }
      if (!cacheable || pass['content-encoding'] || statusCode !== 200) {
        try {
          for await (const chunk of body) { stats.bytes += chunk.length; res.write(chunk); }
        } catch { /* aborted */ }
        done();
        res.end();
        return;
      }
      // tee into the object cache while streaming
      const chunks = [];
      let size = 0;
      let cacheableSize = true;
      try {
        for await (const chunk of body) {
          size += chunk.length;
          stats.bytes += chunk.length;
          res.write(chunk);
          if (cacheableSize) {
            if (size > config.cache.maxObjectBytes) cacheableSize = false;
            else chunks.push(chunk);
          }
        }
      } catch { /* aborted */ }
      done();
      res.end();
      if (cacheableSize && chunks.length) {
        cache.set(cacheKey, { body: Buffer.concat(chunks), headers: { ...pass, 'content-length': size }, bytes: size });
      }
      return;
    }

    // ---------- buffered + rewritten ----------
    let raw;
    try {
      raw = await readBody(body, {
        limit: REWRITE_LIMIT,
        onBytes: (n) => { stats.bytes += n; },
      });
    } catch (err) {
      done();
      return isNavigation ? showError(res, upstream, err.message ?? String(err), err.code ?? 507)
        : sendText(res, 500, String(err.message ?? err));
    }
    done();

    // Compressed bytes must never reach the browser as "HTML" — that is how a proxied SERP ends up
    // as an empty black frame. Decode (raw deflate, double gzip, sniffing included); if the origin
    // cannot be made sense of, ask that origin for identity bytes exactly once instead of rendering
    // garbage, and say so in a page the user can read if even that fails.
    const dec = decodeBody(raw, uh['content-encoding']);
    if (!dec.ok) {
      if (!BAD_ENCODING.has(host) && !forceIdentity) {
        BAD_ENCODING.set(host, 1);
        log.warn(`${host}: ${dec.why} — erneuter Versuch ohne Komprimierung`);
        return handleProxiedRequest(req, res, { tab, profile, parsed, forceIdentity: true });
      }
      const why = `${dec.why} (Rohdaten: ${fmtBytes(raw.length)})`;
      log.warn(`${host}: ${why}`);
      // A stylesheet or an embedded frame that cannot be read must not break the whole page: an
      // empty document keeps everything else alive.
      if (isCss || !isTopDocument(headers, dest)) {
        return emptyStub(res, isCss ? 'stylesheet' : 'script');
      }
      return showError(res, upstream, 'Die Antwort dieses Servers ist nicht lesbar: ' + why
        + '. Meist ein Proxy/CDN-Problem auf dem Weg dorthin.', 502);
    }
    raw = dec.buf;
    if (isHtml && isTopDocument(headers, dest) && !looksTextual(raw)) {
      return showError(res, upstream, 'Die Seite lieferte keine HTML-Daten (Binärdaten oder ein Download, '
        + 'den der Browser hier nicht rendern kann).', 502);
    }
    if (isHtml && raw.length === 0) {
      // HTTP 200 + empty body is what search engines and CDNs answer when they do not like the
      // request (bot detection, missing cookie, TLS fingerprint). A blank frame would look like a
      // bug in this browser, so explain it instead.
      if (isTopDocument(headers, dest)) {
        return showError(res, upstream, 'Der Server hat geantwortet, aber die Seite ist leer (HTTP 200, '
          + '0 Bytes). Solche Antworten sind meist Bot-Erkennung oder ein fehlendes Cookie — bitte die '
          + 'Seite erneut laden oder im Tab die Cookies prüfen.', 502);
      }
      return emptyStub(res, isCss ? 'stylesheet' : 'script');
    }

    const docUrl = new URL(upstream);
    const rctx = { sid: tab.id, docUrl, origin: docUrl.origin, kind: 'p' };
    let title = '';
    let text;
    if (isHtml) {
      const charset = pickCharset(uh['content-type'], raw);
      text = decodeWith(raw, charset);
      title = extractTitle(text);
      const inject = bootstrapFor(tab, profile, {
        docUrl: upstream,
        origin: docUrl.origin,
        cookies: profile.jar.clientSnapshot(upstream),
        css: settings.cosmetic ? engine.cosmeticCss(docUrl.hostname) : '',
        settings,
        type,
      });
      text = rewriteHtml(text, { ...rctx, inject });
    } else {
      text = rewriteCss(decodeWith(raw, 'utf-8'), rctx);
    }

    let payload = Buffer.from(text, 'utf8');
    const acceptEncoding = String(headers['accept-encoding'] ?? '');
    const finalHeaders = {
      'content-type': isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8',
      'content-length': payload.length,
      'cache-control': cacheable && isCss
        ? `public, max-age=${Math.round(config.cache.browserTtlMs / 1000)}`
        : 'no-cache',
      vary: 'accept-encoding',
      'x-content-type-options': 'nosniff',
    };
    if (isHtml && title) finalHeaders['x-chaos-title'] = encodeURIComponent(title.slice(0, 160));
    if (config.compress && payload.length > 1200) {
      if (acceptEncoding.includes('br')) {
        payload = zlib.brotliCompressSync(payload, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: isHtml ? 5 : 6 },
        });
        finalHeaders['content-encoding'] = 'br';
      } else if (acceptEncoding.includes('gzip')) {
        payload = zlib.gzipSync(payload, { level: isHtml ? 6 : 7 });
        finalHeaders['content-encoding'] = 'gzip';
      }
      finalHeaders['content-length'] = payload.length;
    }
    if (isCss && cacheable && payload.length <= config.cache.maxObjectBytes && !finalHeaders['content-encoding']) {
      cache.set(cacheKey, { body: payload, headers: { ...finalHeaders }, bytes: payload.length });
    }
    if (isNavigation) store.touch(tab.id, { url: docUrl.origin + docUrl.pathname + docUrl.search, title, referrer: null });
    res.writeHead(statusCode, finalHeaders);
    if (method === 'HEAD') return res.end();
    res.end(payload);
  };
}

/* ------------------------------------------------------------------ */

function decideUrl(url, settings) {
  if (settings.stripTracking) {
    const stripped = stripTrackingParams(url);
    if (stripped !== url) return stripped;
  }
  if (config.stripQuery.length) {
    try {
      const u = new URL(url);
      for (const p of config.stripQuery) u.searchParams.delete(p);
      return u.href;
    } catch { return url; }
  }
  return url;
}

export /**
 * Read-and-forget. An undici response body that is destroyed without a listener emits an
 * 'error' event (UND_ERR_ABORTED) and takes the process down, so the listener always goes on
 * first; dump() also lets the pooled connection be reused for the next request.
 */
function discard(body) {
  if (!body) return;
  try {
    body.on('error', noop);
    if (typeof body.dump === 'function') { body.dump().catch(noop); return; }
    body.resume();
    body.destroy?.();
  } catch { /* already gone */ }
}
const noop = () => {};

function resourceType(dest, url, method) {
  switch (dest) {
    case 'document': return 'document';
    case 'iframe': case 'frame': case 'fencedframe': return 'subdocument';
    case 'image': case 'srcset': return 'image';
    case 'script': case 'worker': case 'sharedworker': case 'worklet': return 'script';
    case 'style': return 'stylesheet';
    case 'font': return 'font';
    case 'audio': case 'video': return 'media';
    case 'object': return 'object';
    case 'fetch': case 'xmlhttprequest': return 'xmlhttprequest';
    case 'beacon': return 'ping';
    case 'manifest': case 'report': case 'empty': return 'other';
    default: break;
  }
  const clean = url.split('?')[0];
  if (/\.(png|jpe?g|gif|webp|avif|ico|bmp|svgz?)$/i.test(clean)) return 'image';
  if (/\.css$/i.test(clean)) return 'stylesheet';
  if (/\.(m?js|json|map)$/i.test(clean)) return 'script';
  if (/\.(woff2?|ttf|otf|eot)$/i.test(clean)) return 'font';
  if (/\.(mp4|webm|m4s|mp3|m4a|ogg|mov|ts|m3u8)$/i.test(clean)) return 'media';
  if (/\.(html?|xhtml|aspx?|php|jsp|cfm)$/.test(clean)) return 'document';
  return method === 'GET' || method === 'HEAD' ? 'other' : 'xmlhttprequest';
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  const strip = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } };
  return strip(a) === strip(b);
}

function checkPolicy(url, settings) {
  let u;
  try { u = new URL(url); } catch { return { code: 400, why: 'invalid target url' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { code: 400, why: `protocol ${u.protocol} is not supported` };
  }
  // our own demo pages are reachable through the proxy even with the SSRF guard on: they are
  // public, static and the only way to show (and test) filtering without an internet route.
  if (isLocalDemo(url)) return null;
  const hostname = u.hostname.toLowerCase();
  if (!hostname) return { code: 400, why: 'missing host' };
  if (config.allowHosts.length && !config.allowHosts.some((h) => hostname === h || hostname.endsWith('.' + h))) {
    return { code: 403, why: `${hostname} is not on the operator allow list` };
  }
  if (config.denyHosts.length && config.denyHosts.some((h) => hostname === h || hostname.endsWith('.' + h))) {
    return { code: 403, why: `${hostname} is blocked by the operator deny list` };
  }
  if (config.ssrfGuard && !config.allowPrivate && isPrivateish(hostname)) {
    return {
      code: 403,
      why: 'private/loopback addresses are refused by the SSRF guard (set CHAOS_ALLOW_PRIVATE=1 to allow them)',
    };
  }
  if (u.username || u.password) {
    return { code: 400, why: 'credentials in the URL are not forwarded' };
  }
  return null;
}

/** http(s)://(localhost|127.0.0.1|our host)[:our port]/site/… */
function isLocalDemo(url) {
  try {
    const u = new URL(url);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (port !== config.port) return false;
    if (!/^\/site\//.test(u.pathname)) return false;
    return /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(u.hostname)
      || u.hostname.endsWith('.e2b.app');
  } catch { return false; }
}

function isPrivateish(hostname) {
  return /^(localhost|.*\.(local|internal|lan|home))$/.test(hostname)
    || /^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || hostname === '::1' || /^(fe80|fc|fd)[0-9a-f:]*$/.test(hostname);
}

function estimateAdBytes(type) {
  return type === 'image' ? 42000 : type === 'script' ? 96000 : type === 'media' ? 640000 : 18000;
}

function bumpHost(stats, host) {
  const n = (stats.hosts.get(host) ?? 0) + 1;
  if (stats.hosts.size < 400) stats.hosts.set(host, n);
}

function mayCache(uh) {
  const cc = String(uh['cache-control'] ?? '').toLowerCase();
  const m = /max-age=(\d+)/.exec(cc);
  if (/no-store/.test(cc)) return false;
  if (m) return Number(m[1]) > 30;
  return /public/.test(cc);
}

function isAssetCacheable(contentType, status) {
  return status === 200 && /image\/|font\/|application\/font|text\/css|javascript|application\/wasm/.test(contentType);
}


/** Only `document` navigations get our error pages — a hidden iframe gets an empty stub instead. */
/**
 * Is this the document of one of our own tabs (as opposed to an iframe *inside* a proxied page)?
 * Chrome tells us directly with `Sec-Fetch-Is-Nested-Navigation: ?1`. Tab documents get a readable
 * error page; nested frames just get an empty document, because an embed that fails is normal and
 * a full-screen "this page failed" card inside somebody's comment widget is not.
 */
function isTopDocument(headers, dest) {
  if (headers['sec-fetch-is-nested-navigation'] === '?1') return false;
  return dest === 'document' || dest === '' || dest === 'iframe' || dest === 'frame';
}

function emptyStub(res, type) {
  const body = type === 'stylesheet' ? EMPTY_CSS : EMPTY_JS;
  res.writeHead(200, {
    'content-type': type === 'stylesheet' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-chaos-blocked': type,
  });
  res.end(body);
}

function pickCharset(contentType, buf) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType ?? ''));
  if (m) return m[1].toLowerCase();
  const head = buf.subarray(0, 4096).toString('latin1');
  const meta = /<meta[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return meta ? meta[1].toLowerCase() : 'utf-8';
}

export function decodeWith(buf, charset) {
  if (!charset || charset.startsWith('utf-8') || charset.startsWith('utf8')) return buf.toString('utf8');
  if (charset === 'latin1' || charset === 'iso-8859-1' || charset === 'windows-1252') {
    return Buffer.from(buf).toString('latin1');
  }
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

/** Collect a body with a hard cap; decoding is decode.js' job, not ours. */
export async function readBody(body, { limit, onBytes }) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new ProxyError(507, `body larger than ${fmtBytes(limit)} — not rewritten for safety`);
    onBytes?.(chunk.length);
    chunks.push(chunk);
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

function respondBlocked(res, type, method) {
  const base = { 'cache-control': 'no-store', 'x-chaos-blocked': type };
  if (method === 'HEAD') { res.writeHead(200, base); return res.end(); }
  if (type === 'script') {
    res.writeHead(200, { ...base, 'content-type': 'application/javascript; charset=utf-8', 'content-length': EMPTY_JS.length });
    return res.end(EMPTY_JS);
  }
  if (type === 'stylesheet') {
    res.writeHead(200, { ...base, 'content-type': 'text/css; charset=utf-8', 'content-length': EMPTY_CSS.length });
    return res.end(EMPTY_CSS);
  }
  if (type === 'image') {
    res.writeHead(200, { ...base, 'content-type': 'image/gif', 'content-length': GIF_1X1.length });
    return res.end(GIF_1X1);
  }
  if (type === 'document' || type === 'subdocument') {
    const html = '<!doctype html><meta charset="utf-8"><title>blocked</title>'
      + '<body style="margin:0;background:transparent"></body>';
    res.writeHead(200, { ...base, 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
    return res.end(html);
  }
  res.writeHead(204, base);
  res.end();
}

function deny(res, req, policy, isNavigation, type) {
  if (isNavigation) return showError(res, req.url, policy.why, policy.code);
  if (type === 'image') return respondBlocked(res, 'image', req.method);
  if (type === 'script') return respondBlocked(res, 'script', req.method);
  return sendText(res, policy.code ?? 403, policy.why);
}

function showError(res, url, message, code = 502) {
  const buf = Buffer.from(errorPage({ url, message, code }), 'utf8');
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-chaos-error': headerText(message),
  });
  res.end(buf);
}

export { GIF_1X1 };
