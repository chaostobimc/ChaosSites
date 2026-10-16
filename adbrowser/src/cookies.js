/**
 * Server-side cookie jar (RFC 6265 flavoured).
 *
 * Cookies live on the *proxy*, never in the user's browser, so a proxied site can neither
 * read nor poison anything on our own origin, and no cookie ever leaks between tabs/sessions.
 * The page's `document.cookie` is emulated by the injected client runtime against a snapshot
 * that we hand it at document time and that it flushes back to us (debounced + on unload).
 */

export class CookieJar {
  constructor() {
    /** Map<`host|path|name`, cookie> — host without leading dot means "exact host" */
    this.store = new Map();
  }

  get size() { return this.store.size; }

  clear(host) {
    if (!host) { this.store.clear(); return; }
    for (const [k, c] of this.store) if (c.domain === host) this.store.delete(k);
  }

  /** Parse one `Set-Cookie` header and store it. */
  parse(headerValue, { url, nowTs = Date.now() }) {
    const parts = String(headerValue).split(';');
    const [rawName, ...rawVal] = parts[0].split('=');
    const name = (rawName || '').trim();
    if (!name) return null;
    const value = rawVal.join('=').trim();
    const attrs = {};
    for (const p of parts.slice(1)) {
      const i = p.indexOf('=');
      const k = (i < 0 ? p : p.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : p.slice(i + 1).trim();
      attrs[k] = v;
    }
    const u = new URL(url);
    if (u.protocol === 'file:') return null;
    let domain = (attrs.domain || '').replace(/^\./, '').toLowerCase();
    const host = u.hostname.toLowerCase();
    if (domain) {
      if (!(host === domain || host.endsWith('.' + domain))) return null; // refuse cross-domain
      if (isIpLike(host)) domain = host;
    } else {
      domain = host;
    }
    let path = attrs.path && attrs.path.startsWith('/') ? attrs.path : defaultPath(u.pathname);
    if (!path.endsWith('/')) path += '/';
    const maxAge = attrs['max-age'] !== undefined ? Number(attrs['max-age']) : undefined;
    // Expires=Thu, 01 Jan 1970 is the canonical "delete me" — 0 is falsy, so test for undefined
    const expires = attrs.expires !== undefined && attrs.expires !== '' ? Date.parse(attrs.expires) : undefined;
    const expiry = maxAge !== undefined && Number.isFinite(maxAge)
      ? nowTs + maxAge * 1000
      : Number.isFinite(expires) ? expires : undefined;
    if (expiry !== undefined && expiry <= nowTs) { // deletion
      for (const [k, c] of this.store) if (c.name === name && c.domain === domain && pathPrefix(c.path, path)) this.store.delete(k);
      return null;
    }
    const key = `${domain}|${path}|${name}`;
    const prev = this.store.get(key);
    this.store.set(key, {
      name,
      value,
      domain,
      path,
      secure: 'secure' in attrs,
      httpOnly: 'httponly' in attrs,
      sameSite: (attrs.samesite || 'lax').toLowerCase(),
      expiry,
      creation: prev?.creation ?? nowTs,
      lastAccess: nowTs,
    });
    return this.store.get(key);
  }

  /** Cookies that should be sent with `url`, ordered per RFC 6265 §5.4. */
  forRequest(url, { nowTs = Date.now() } = {}) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isSecure = u.protocol === 'https:';
    const out = [];
    for (const [k, c] of this.store) {
      if (c.expiry !== undefined && c.expiry <= nowTs) { this.store.delete(k); continue; }
      if (c.secure && !isSecure) continue;
      if (!domainMatch(c.domain, host)) continue;
      if (!pathPrefix(c.path, u.pathname)) continue;
      out.push(c);
    }
    out.sort((a, b) => {
      const byPath = b.path.length - a.path.length;
      if (byPath) return byPath;
      const byCreation = (a.creation ?? 0) - (b.creation ?? 0);
      if (byCreation) return byCreation;
      return a.name < b.name ? -1 : 1;
    });
    return out;
  }

  header(url, opts) {
    const cookies = this.forRequest(url, opts);
    if (!cookies.length) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Snapshot for the page (JS-visible cookies only). */
  clientSnapshot(url, opts = {}) {
    const u = new URL(url);
    const out = {};
    for (const c of this.forRequest(url, opts)) {
      if (c.httpOnly) continue;
      if (c.secure && u.protocol !== 'https:') continue;
      out[c.name] = c.value;
    }
    return out;
  }

  /**
   * Merge a `document.cookie` snapshot back into the jar. The page can only see non-HttpOnly
   * cookies, so we replace exactly that set: deletions propagate, HttpOnly ones stay untouched.
   */
  syncClient(url, map, { nowTs = Date.now() } = {}) {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    for (const [k, c] of this.store) {
      if (c.httpOnly) continue;
      if (!domainMatch(c.domain, host) || !pathPrefix(c.path, path)) continue;
      if (!(c.name in (map ?? {}))) this.store.delete(k);
    }
    for (const [name, value] of Object.entries(map ?? {})) {
      if (typeof value !== 'string') continue;
      // keep the existing scope if we already know this cookie, otherwise pin it to the site
      let existing = null;
      for (const [, c] of this.store) if (c.name === name && domainMatch(c.domain, host)) { existing = c; break; }
      const domain = existing?.domain ?? (isIpLike(host) ? host : host);
      const cookiePath = existing?.path ?? '/';
      this.store.set(`${domain}|${cookiePath}|${name}`, {
        name, value, domain, path: cookiePath,
        secure: u.protocol === 'https:', httpOnly: false, sameSite: 'lax',
        expiry: existing?.expiry, creation: existing?.creation ?? nowTs, lastAccess: nowTs,
      });
    }
    return this.size;
  }

  toJSON() {
    return [...this.store.values()].map((c) => ({ ...c }));
  }

  static fromJSON(arr) {
    const jar = new CookieJar();
    for (const c of arr ?? []) if (c?.name && c.domain && c.path) jar.store.set(`${c.domain}|${c.path}|${c.name}`, c);
    return jar;
  }
}

export function serializeSetCookie(c) {
  let s = `${c.name}=${c.value}; Path=${c.path.replace(/\/$/, '') || '/'}; Domain=${c.domain.startsWith('[') ? c.domain : c.domain}`;
  if (c.expiry) s += `; Expires=${new Date(c.expiry).toUTCString()}`;
  if (c.secure) s += '; Secure';
  if (c.sameSite && c.sameSite !== 'lax') s += `; SameSite=${c.sameSite[0].toUpperCase() + c.sameSite.slice(1)}`;
  return s;
}

function defaultPath(pathname) {
  const idx = pathname.lastIndexOf('/');
  return idx <= 0 ? '/' : pathname.slice(0, idx + 1);
}

export function pathPrefix(cookiePath, requestPath) {
  if (cookiePath === '/') return true;
  if (requestPath === cookiePath) return true;
  if (requestPath.startsWith(cookiePath)) {
    return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
  }
  return false;
}

export function domainMatch(cookieDomain, host) {
  const d = cookieDomain.toLowerCase();
  const h = host.toLowerCase();
  if (isIpLike(h)) return d === h;
  return h === d || h.endsWith('.' + d);
}

function isIpLike(host) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':');
}
