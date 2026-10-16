/** Small shared helpers: base64url codec, bounded caches, logging, misc. */

const B64_ENC = new Map();
const B64_DEC = new Map();

export function encOrigin(origin) {
  let hit = B64_ENC.get(origin);
  if (hit) return hit;
  hit = Buffer.from(origin, 'utf8').toString('base64url');
  if (B64_ENC.size > 20000) B64_ENC.clear();
  B64_ENC.set(origin, hit);
  return hit;
}

export function decOrigin(seg) {
  let hit = B64_DEC.get(seg);
  if (hit) return hit;
  try {
    hit = Buffer.from(seg, 'base64url').toString('utf8');
    if (!/^https?:\/\/[^\s]+$/.test(hit)) return null;
  } catch {
    return null;
  }
  if (B64_DEC.size > 20000) B64_DEC.clear();
  B64_DEC.set(seg, hit);
  return hit;
}

/** Insertion-ordered bounded map: cheap "good enough" LRU for hot key sets. */
export class BoundedMap extends Map {
  constructor(max = 5000, onEvict = null) {
    super();
    this.max = max;
    this.onEvict = onEvict;
  }
  set(key, value) {
    if (super.has(key)) super.delete(key);
    else if (super.size >= this.max) {
      const oldest = super.keys().next().value;
      const victim = super.get(oldest);
      super.delete(oldest);
      this.onEvict?.(oldest, victim);
    }
    return super.set(key, value);
  }
}

export class ByteBudget {
  constructor(max) {
    this.max = max;
    this.used = 0;
  }
  get free() { return this.max - this.used; }
  claim(n) { this.used += n; return this; }
  release(n) { this.used = Math.max(0, this.used - n); return this; }
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let level = LEVELS[process.env.CHAOS_LOG_LEVEL || 'info'] ?? 2;
export function setLogLevel(l) { level = LEVELS[l] ?? level; }
const C = { dim: '\x1b[2m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const stamp = () => new Date().toISOString().slice(11, 19);
export const log = {
  error: (...a) => level >= 0 && console.error(C.red + stamp() + ' !' + C.reset, ...a),
  warn: (...a) => level >= 1 && console.warn(C.yellow + stamp() + ' *' + C.reset, ...a),
  info: (...a) => level >= 2 && console.log(C.green + stamp() + ' ·' + C.reset, ...a),
  debug: (...a) => level >= 3 && console.log(C.dim + stamp() + ' .' + C.reset, ...a),
};

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const now = () => Number(process.hrtime.bigint() / 1000000n);

export function hostOf(url) {
  const i = url.indexOf('//');
  if (i < 0) return '';
  const start = i + 2;
  let end = start;
  while (end < url.length && !'/\\?#'.includes(url[end])) end++;
  const withPort = url.slice(start, end);
  const at = withPort.lastIndexOf('@');
  return (at >= 0 ? withPort.slice(at + 1) : withPort).toLowerCase();
}

export function originOf(url) {
  const host = hostOf(url);
  if (!host) return '';
  const proto = url.slice(0, url.indexOf('//'));
  return proto + '//' + host;
}

export function pathOf(url) {
  const i = url.indexOf('//');
  if (i < 0) return '/';
  let p = url.indexOf('/', i + 2);
  return p < 0 ? '/' : url.slice(p);
}

const PRIVATE_NAME_RE = /^(localhost|.*\.(localhost|internal|local|home|lan))$/i;
const PRIVATE_IP_RE = /^(127\.|0\.|10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d)\.)|^172\.(1[6-9]|2\d|3[01])\./;

export function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (PRIVATE_NAME_RE.test(h)) return true;
  if (h.includes(':')) return /^(::1|::|fe80|fc|fd)/.test(h); // IPv6 loopback / ULA / link-local
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_IP_RE.test(h);
  return false;
}

export function clamp(n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; }

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
