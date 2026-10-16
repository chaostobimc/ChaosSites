/** Runtime configuration. Everything can be overridden with CHAOS_* env vars. */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DATA_DIR = process.env.CHAOS_DATA_DIR || join(ROOT, 'data');
// Precedence: explicit env → writable data dir (freshly built lists) → the payload shipped in
// the image. That way a volume at CHAOS_DATA_DIR can take over the lists without losing the
// built-in ones if it is empty.
function resolveFiltersFile() {
  if (process.env.CHAOS_FILTERS_FILE) return process.env.CHAOS_FILTERS_FILE;
  const inData = join(DATA_DIR, 'adblock.json.gz');
  if (existsSync(inData)) return inData;
  const inApp = join(ROOT, 'data', 'adblock.json.gz');
  return existsSync(inApp) ? inApp : inData;
}
export const FILTERS_FILE = resolveFiltersFile();
export const LISTS_DIR = join(DATA_DIR, 'lists');

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v) => (v ? String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);

export const config = {
  port: num(process.env.PORT ?? process.env.CHAOS_PORT, 6001),
  host: process.env.CHAOS_HOST || '0.0.0.0',
  /** Optional shared secret. When set, the UI asks for it once and stores it in a cookie. */
  accessCode: process.env.CHAOS_ACCESS_CODE || '',
  /** Base URL used to build absolute proxied links (behind a reverse proxy set this). */
  publicBase: process.env.CHAOS_PUBLIC_BASE || '',
  /**
   * Optional per-tab origin isolation: set CHAOS_ISOLATE_SUFFIX=proxy.example.com (wildcard DNS
   * + wildcard TLS) and every tab runs on https://<tabId>.proxy.example.com, giving the proxied
   * page an origin of its own — it can then no longer touch this UI's storage or DOM.
   */
  isolateSuffix: process.env.CHAOS_ISOLATE_SUFFIX || '',
  isolateTls: !/^(0|false)$/i.test(process.env.CHAOS_ISOLATE_TLS ?? '1'),
  isolateOrigin(sid) {
    const suffix = this.isolateSuffix;
    if (!suffix) return '';
    const proto = this.isolateTls ? 'https' : 'http';
    return proto + '://' + sid + '.' + suffix;
  },

  /** How many pages/tabs a session keeps around before pruning. */
  maxTabs: num(process.env.CHAOS_MAX_TABS, 24),
  /** ceiling on live profiles (each = cookie jar + history), oldest are pruned first */
  maxProfiles: num(process.env.CHAOS_MAX_PROFILES, 5000),
  sessionTtlMs: num(process.env.CHAOS_SESSION_TTL_MIN, 60 * 12) * 60 * 1000,

  /** Upstream fetching */
  timeouts: {
    headers: num(process.env.CHAOS_HEADER_TIMEOUT_MS, 20000),
    body: num(process.env.CHAOS_BODY_TIMEOUT_MS, 120000),
    connect: num(process.env.CHAOS_CONNECT_TIMEOUT_MS, 10000),
    total: num(process.env.CHAOS_TOTAL_TIMEOUT_MS, 180000),
  },
  maxRedirects: num(process.env.CHAOS_MAX_REDIRECTS, 6),
  maxRewriteBytes: num(process.env.CHAOS_MAX_REWRITE_MB, 16) * 1024 * 1024,
  maxCacheObjectBytes: num(process.env.CHAOS_CACHE_OBJECT_MB, 6) * 1024 * 1024,
  connections: {
    /** keep-alive pools per upstream origin; big for perceived speed on asset-heavy pages */
    connectionsPerOrigin: num(process.env.CHAOS_CONNECTIONS_PER_ORIGIN, 24),
    pipelining: 1,
    keepAliveTimeout: num(process.env.CHAOS_KEEPALIVE_MS, 30000),
  },
  cache: {
    enabled: bool(process.env.CHAOS_CACHE, true),
    maxBytes: num(process.env.CHAOS_CACHE_MB, 192) * 1024 * 1024,
    maxObjectBytes: num(process.env.CHAOS_CACHE_OBJECT_MB, 6) * 1024 * 1024,
    defaultTtlMs: num(process.env.CHAOS_CACHE_TTL_MS, 5 * 60 * 1000),
    /** how long the browser may keep a proxied sub-resource (immutable-ish assets) */
    browserTtlMs: num(process.env.CHAOS_BROWSER_TTL_MS, 30 * 60 * 1000),
  },

  /** Ad blocking */
  adblock: {
    enabled: bool(process.env.CHAOS_ADBLOCK, true),
    cosmetic: bool(process.env.CHAOS_COSMETIC, true),
    /** also block ad requests that are top-level navigations (pop-unders). off = safer */
    blockDocuments: bool(process.env.CHAOS_BLOCK_AD_DOCS, false),
    /** $important rules override the allowlist even for pages */
    enhanced: bool(process.env.CHAOS_ENHANCED_COSMETIC, true),
    autoUpdate: bool(process.env.CHAOS_FILTERS_AUTO_UPDATE, false),
    updateIntervalMs: num(process.env.CHAOS_FILTERS_UPDATE_HOURS, 24) * 3600 * 1000,
  },

  /** Privacy extras */
  stripQuery: list(process.env.CHAOS_STRIP_QUERY).length
    ? list(process.env.CHAOS_STRIP_QUERY)
    : [], // e.g. utm_source,utm_medium,... (empty by default: never break a site silently)
  sendReferer: bool(process.env.CHAOS_SEND_REFERER, true),
  dnt: bool(process.env.CHAOS_DNT, true),
  /** refuse to fetch private/loopback addresses (SSRF guard) */
  ssrfGuard: bool(process.env.CHAOS_SSRF_GUARD, true),
  allowPrivate: bool(process.env.CHAOS_ALLOW_PRIVATE, false),
  denyHosts: list(process.env.CHAOS_DENY_HOSTS),
  allowHosts: list(process.env.CHAOS_ALLOW_HOSTS),

  userAgents: {
    desktop:
      process.env.CHAOS_UA_DESKTOP ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    mobile:
      process.env.CHAOS_UA_MOBILE ||
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },

  /** search engine used when the address bar gets a query instead of a URL */
  searchEngine: process.env.CHAOS_SEARCH || 'https://duckduckgo.com/?q={query}',
  homeUrl: process.env.CHAOS_HOME || '/start',

  logLevel: process.env.CHAOS_LOG_LEVEL || 'info',
  /** dev-friendly: no compression on our own static assets */
  compress: bool(process.env.CHAOS_COMPRESS, true),
};

export default config;
