/**
 * Chaos ADBrowser – runtime ad-blocking engine
 * --------------------------------------------
 * Loads a payload produced by ./compile.js and answers, in a few hundred nanoseconds, the
 * only two questions the proxy needs:
 *
 *   1. shouldBlock(request)   -> network filtering
 *   2. cosmeticCss(pageHost)  -> element hiding ("cosmetic filtering")
 *
 * Matching pipeline for one request (each stage can short-circuit):
 *   a. decision cache (Map, size-capped)                    ~hit in >80% of sub-resource loads
 *   b. host suffix walk against the blocked/allowed host set  (||domain^ rules, ~60k entries)
 *   c. host bucket  -> rules pinned to that exact request host   (||host/path…)
 *   d. page bucket  -> rules restricted via $domain=              (only for the current page)
 *   e. Aho–Corasick scan of the URL -> anchors of the generic rules, then verify
 *   f. unanchored "always" rules (kept tiny by the compiler)
 *
 * Everything is synchronous and allocation-light: strings are compared, never parsed twice.
 */

import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { AhoCorasick, buildFromMap } from './aho.js';
import { compileFilters, hostSuffixes, registrableDomain } from './compile.js';

const BIT = {
  document: 1, subdocument: 2, image: 4, script: 8, stylesheet: 16, font: 32,
  media: 64, object: 128, xmlhttprequest: 256, ping: 512, websocket: 1024, other: 2048,
};
export const TYPE_BIT = BIT;

/** Sec-Fetch-Dest (browser truth) -> our coarse resource type. */
export function typeFromFetchDest(dest, initiator = '') {
  switch (dest) {
    case 'document': case '': case undefined: return initiator === 'navigate' ? 'document' : 'other';
    case 'frame': case 'iframe': return 'subdocument';
    case 'image': case 'srcset': return 'image';
    case 'script': case 'worker': case 'sharedworker': case 'worklet': return 'script';
    case 'style': return 'stylesheet';
    case 'font': return 'font';
    case 'audio': case 'video': return 'media';
    case 'object': return 'object';
    case 'fencedframe': return 'subdocument';
    case 'empty': return 'other';
    case 'report': return 'other';
    case 'manifest': return 'other';
    default: return 'other';
  }
}

const MAX_REGEX_URL_LEN = 1400;
// negative sentinels: rule ids are >= 0, so a cached ALLOWED must never look like a rule index
const ALLOWED = -1;
const BLOCKED_BY_HOST = -2;

function ctxPage(req) { return req.pageHost || ''; }

export class AdBlocker {
  constructor(payload, opts = {}) {
    this.opts = { enabled: true, cosmetic: true, enhanced: true, ...opts };
    this.stats = { checked: 0, blocked: 0, allowedByException: 0, byHost: new Map(), byRule: new Map() };
    this.cache = new Map();
    this.cacheCap = opts.cacheCap ?? 60000;
    this.loadPayload(payload);
  }

  loadPayload(payload) {
    // an engine without a payload is legal: it blocks nothing and simply waits for user rules
    const p = payload ?? {
      hosts: [], hostAllow: [], rules: [], hostBucket: {}, pageBucket: {}, always: [], anchors: {},
      cosmetic: { generic: '', genericAllow: '', domains: {}, noCosmetic: '' }, meta: {},
    };
    payload = p;
    this.blockedHosts = toSet(payload.hosts);
    this.allowedHosts = toSet(payload.hostAllow);
    this.rules = (payload.rules ?? []).map(deserializeRule);
    this.hostBucket = toIdMap(payload.hostBucket, this.rules.length);
    this.pageBucket = toIdMap(payload.pageBucket, this.rules.length);
    this.always = (payload.always ?? []).slice();
    this.anchors = payload.anchors ?? {};
    const map = new Map();
    for (const [k, v] of Object.entries(this.anchors)) if (k) map.set(k, v);
    this.ac = map.size ? buildFromMap(map) : new AhoCorasick().build();
    this.cosmetic = payload.cosmetic ?? { generic: '', genericAllow: '', domains: {}, noCosmetic: '' };
    this.noCosmeticHosts = toSet(this.cosmetic.noCosmetic);
    this.cosmeticCache = new Map();
    this.meta = payload.meta ?? {};
    this.patternCount = map.size;
  }

  static fromFile(path) {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path);
    const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    return JSON.parse(text);
  }

  /** Merge a blob of user rules (ABP syntax) into the loaded filter set. */
  applyUserRules(text) {
    this.userRuleText = text ?? '';
    if (!this._base) this._base = snapshot(this);
    restore(this, this._base);
    const trimmed = (this.userRuleText || '').trim();
    if (!trimmed) {
      this.invalidateCaches();
      return { rules: 0, hosts: 0, cosmetic: 0, cosmeticHosts: 0 };
    }
    const compiled = compileFilters({ 'user-rules.txt': trimmed });
    mergePayload(this, compiled);
    this.invalidateCaches();
    const c = compiled.meta.counts;
    return { rules: c.networkRules, hosts: c.blockedHosts, cosmetic: c.cosmeticHosts, cosmeticHosts: c.cosmeticHosts };
  }

  invalidateCaches() {
    this.cache.clear();
    this.cosmeticCache.clear();
  }

  get info() {
    return {
      meta: this.meta,
      blockedHosts: this.blockedHosts.size,
      allowedHosts: this.allowedHosts.size,
      rules: this.rules.length,
      anchors: this.patternCount,
      hoisted: this.ac.memory,
      enabled: this.opts.enabled,
      cosmetic: this.opts.cosmetic,
      enhanced: this.opts.enhanced,
      userRules: (this.userRuleText || '').split('\n').filter((l) => l.trim() && !l.startsWith('!')).length,
      cacheSize: this.cache.size,
    };
  }

  /**
   * @param {object} req {url, host, pageHost, type, topLevel, thirdParty}
   * @returns {null|{rule:string, id:number}} match info when the request must be blocked
   */
  match(req) {
    if (!this.opts.enabled) return null;
    const url = req.url;
    this.stats.checked++;
    const doc = req.topLevel === true;
    const blockDoc = this.opts.blockDocuments === true;
    const typeBit = BIT[req.type] ?? BIT.other;
    const pageHost = req.pageHost || '';
    const tp = (req.thirdParty === undefined
      ? registrableDomain(req.host) !== registrableDomain(ctxPage(req))
      : req.thirdParty) ? 1 : 2;
    // The verdict is context-dependent — the same url can be a navigation (exempt), a script or a
    // third-party image, and $domain rules depend on the page — so the key carries that context.
    const key = url + '|' + typeBit + '|' + tp + '|' + (doc ? 1 : 0) + '|' + pageHost + (blockDoc ? '!' : '');
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      if (cached === ALLOWED) return null;
      if (cached === BLOCKED_BY_HOST) {
        this.noteBlocked(req, null);
        return { rule: `||${req.host}^`, id: -1 };
      }
      const rule = this.rules[cached];
      this.noteBlocked(req, rule);
      return { rule: rule?.src ?? 'blocked', id: cached };
    }
    const ctx = {
      url,
      host: req.host,
      pathIdx: pathIndexOf(url),
      pageHost,
      typeBit,
      tp,
      doc: doc && !blockDoc,
      blockDoc,
    };

    let blockedId = -1;
    let allowId = -1;
    let allowImportant = false;
    const mark = (id, rule) => {
      if (rule.exc) {
        allowId = id;
        if (blockedId > 0) blockedId = -1;
        return;
      }
      if (ctx.doc && !rule.imp) return; // never break top-level navigation
      if (rule.imp) allowImportant = true;
      if (blockedId === -1) blockedId = id;
    };

    // b) host suffix walk: most specific entry wins
    const suffixes = hostSuffixes(req.host);
    let hostState = 0;
    for (const s of suffixes) {
      if (this.allowedHosts.has(s)) { hostState = -1; break; }
      if (this.blockedHosts.has(s)) { hostState = 1; break; }
    }
    const hostBlocked = hostState === 1 && !ctx.doc;
    if (hostBlocked) blockedId = BLOCKED_BY_HOST;

    // c) + d) host/page buckets (also consulted while host-blocked, to honour path exceptions)
    let buckets = false;
    for (const s of suffixes) {
      const ids = this.hostBucket.get(s);
      if (ids) { buckets = true; for (const id of ids) this.evaluate(ctx, id, mark); }
    }
    if (ctx.pageHost) {
      for (const s of hostSuffixes(ctx.pageHost)) {
        const ids = this.pageBucket.get(s);
        if (ids) { buckets = true; for (const id of ids) this.evaluate(ctx, id, mark); }
      }
    }
    // e) + f) generic rules via the Aho–Corasick automaton
    if (blockedId === -1 || allowId !== -1 || buckets) {
      if (url.length <= MAX_REGEX_URL_LEN) this.ac.scan(url, (id) => this.evaluate(ctx, id, mark));
      for (const id of this.always) this.evaluate(ctx, id, mark);
    }

    if (blockedId !== -1 && allowId !== -1 && !allowImportant) blockedId = -1;
    if (allowId !== -1 && blockedId === -1) this.stats.allowedByException++;
    if (blockedId === -1) {
      this.put(key, ALLOWED);
      return null;
    }
    if (blockedId === BLOCKED_BY_HOST) {
      this.put(key, BLOCKED_BY_HOST);
      this.noteBlocked(req, null);
      return { rule: `||${req.host}^`, id: -1 };
    }
    this.put(key, blockedId);
    this.noteBlocked(req, this.rules[blockedId]);
    return { rule: this.rules[blockedId].src, id: blockedId };
  }

  evaluate(ctx, id, mark) {
    const rule = this.rules[id];
    if (!rule) return;
    if (rule.only && !(rule.only & ctx.typeBit)) return;
    if (rule.excl & ctx.typeBit) return;
    if (rule.tp === 1 && ctx.tp !== 1) return;
    if (rule.tp === 2 && ctx.tp !== 2) return;
    if (rule.dom) {
      if (!ctx.pageHost) return;
      let ok = false;
      for (const d of rule.dom) if (suffixOrWildcard(d, ctx.pageHost)) { ok = true; break; }
      if (!ok) return;
    }
    if (rule.domNot) {
      for (const d of rule.domNot) if (suffixOrWildcard(d, ctx.pageHost)) return;
    }
    if (rule.prefix && !ctx.url.startsWith(rule.prefix, ctx.pathIdx)) return;
    if (rule.lits.length) {
      let from = 0;
      for (const lit of rule.lits) {
        const idx = rule.litsOrdered ? ctx.url.indexOf(lit, from) : ctx.url.indexOf(lit);
        if (idx < 0) return;
        from = idx + 1;
      }
    }
    if (rule.re) {
      const re = (rule._re ??= compileSafe(rule.re));
      if (re && !re.test(ctx.url)) return;
    }
    if (!rule.lits.length && !rule.re && !rule.prefix && !rule.host) return;
    mark(id, rule);
  }

  noteBlocked(req, rule) {
    this.stats.blocked++;
    if (this.stats.byHost.size < 4000) {
      const host = req.host;
      this.stats.byHost.set(host, (this.stats.byHost.get(host) ?? 0) + 1);
    }
    if (rule) {
      const key = rule.src;
      if (key) this.stats.byRule.set(key, (this.stats.byRule.get(key) ?? 0) + 1);
    }
  }

  put(key, id) {
    // a full clear is cheaper than bookkeeping for a filter cache that is mostly hits
    if (this.cache.size >= this.cacheCap) this.cache.clear();
    this.cache.set(key, id);
  }

  /** Cosmetic CSS for a document: generic selectors + the ones scoped to this host. */
  cosmeticCss(pageHost) {
    if (!this.opts.cosmetic || !pageHost) return '';
    const key = `${pageHost}|${this.opts.enhanced ? 1 : 0}`;
    const hit = this.cosmeticCache.get(key);
    if (hit !== undefined) return hit;
    const parts = [];
    const noGen = this.noCosmeticHosts.has(registrableDomain(pageHost)) || this.noCosmeticHosts.has(pageHost);
    const cos = this.cosmetic;
    if (!noGen) {
      if (cos.generic) parts.push(cos.generic);
      if (cos.genericAllow) parts.push(cos.genericAllow);
    }
    const hostScoped = [];
    const extras = [];
    for (const s of hostSuffixes(pageHost)) {
      const css = this.cosmetic.domains[s];
      if (css) hostScoped.push(css);
      if (this.opts.enhanced && EXTRA_CSS_HOSTS.size) {
        const x = EXTRA_CSS_HOSTS.get(s);
        if (x) extras.push(x);
      }
    }
    // least specific first so that host-exact rules (e.g. un-hide the skip button) win
    parts.push(...hostScoped.reverse(), ...extras.reverse());
    const css = parts.join(';');
    if (this.cosmeticCache.size > 4000) this.cosmeticCache.clear();
    this.cosmeticCache.set(key, css);
    return css;
  }

  topBlocked(limit = 12) {
    return [...this.stats.byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
      .map(([host, n]) => ({ host, n }));
  }
}

function toSet(blob) {
  if (!blob) return new Set();
  return new Set(String(blob).split('\n'));
}

function toIdMap(obj, ruleCount) {
  const map = new Map();
  if (!obj) return map;
  for (const [k, ids] of Object.entries(obj)) {
    const clean = ids.filter((id) => id < ruleCount);
    if (clean.length) map.set(k, clean);
  }
  return map;
}

function deserializeRule(o) {
  const dom = o.d ? o.d.map((d) => String(d).replace(/^\*\./, '')) : null;
  return {
    src: o.s ?? '',
    lits: o.l ?? [],
    litsOrdered: (o.l ?? []).length > 1,
    re: o.r ?? null,
    _re: null,
    prefix: o.p ?? null,
    host: o.h ?? null,
    dom,
    domNot: o.n ?? null,
    tp: o.t ?? 0,
    imp: o.i === 1,
    only: o.o ?? 0,
    excl: o.x ?? 0,
    exc: o.e === 1,
  };
}

function compileSafe(src) {
  if (src.length > 900) return null; // refuse monster regexes rather than risk CPU spikes
  try { return new RegExp(src, 'i'); } catch { return null; }
}

export function suffixOrWildcard(ruleHost, host) {
  if (!ruleHost || !host) return false;
  if (host === ruleHost || host.endsWith('.' + ruleHost)) return true;
  return false;
}

function pathIndexOf(url) {
  const p = url.indexOf('//');
  if (p < 0) return 0;
  const slash = url.indexOf('/', p + 2);
  return slash < 0 ? url.length : slash;
}

function snapshot(engine) {
  return {
    blockedHosts: new Set(engine.blockedHosts),
    allowedHosts: new Set(engine.allowedHosts),
    rules: engine.rules.slice(),
    hostBucket: new Map(engine.hostBucket),
    pageBucket: new Map(engine.pageBucket),
    always: engine.always.slice(),
    anchors: { ...engine.anchors },
    cosmetic: {
      generic: engine.cosmetic.generic,
      genericAllow: engine.cosmetic.genericAllow,
      domains: { ...engine.cosmetic.domains },
      noCosmetic: engine.cosmetic.noCosmetic,
    },
  };
}

function restore(engine, snap) {
  engine.blockedHosts = new Set(snap.blockedHosts);
  engine.allowedHosts = new Set(snap.allowedHosts);
  engine.rules = snap.rules.slice();
  engine.hostBucket = new Map(snap.hostBucket);
  engine.pageBucket = new Map(snap.pageBucket);
  engine.always = snap.always.slice();
  engine.anchors = { ...snap.anchors };
  engine.cosmetic = { ...snap.cosmetic, domains: { ...snap.cosmetic.domains } };
  engine.noCosmeticHosts = toSet(engine.cosmetic.noCosmetic);
  rebuildAutomaton(engine);
}

function mergePayload(engine, compiled) {
  const offset = engine.rules.length;
  for (const o of compiled.rules) engine.rules.push(deserializeRule(o));
  for (const h of String(compiled.hosts ?? '').split('\n')) if (h) engine.blockedHosts.add(h);
  for (const h of String(compiled.hostAllow ?? '').split('\n')) if (h) engine.allowedHosts.add(h);
  mergeBuckets(engine.hostBucket, compiled.hostBucket, offset);
  mergeBuckets(engine.pageBucket, compiled.pageBucket, offset);
  for (const [k, v] of Object.entries(compiled.anchors ?? {})) {
    const arr = engine.anchors[k] ? [...engine.anchors[k], ...v.map((x) => x + offset)] : v.map((x) => x + offset);
    engine.anchors[k] = arr;
  }
  engine.always.push(...compiled.always.map((x) => x + offset));
  if (compiled.cosmetic) {
    if (compiled.cosmetic.generic) {
      // both sides are "<sel>,<sel>{display:none!important}" — rebuild one clean block instead of
      // splicing strings, otherwise the user rule would corrupt the last selector of the payload.
      const selOf = (css) => {
        const i = String(css).lastIndexOf('{');
        return (i < 0 ? String(css) : String(css).slice(0, i)).replace(/,+$/, '').trim();
      };
      const merged = [selOf(engine.cosmetic.generic), selOf(compiled.cosmetic.generic)]
        .filter(Boolean).join(',');
      engine.cosmetic.generic = merged ? merged + '{display:none!important}' : '';
    }
    if (compiled.cosmetic.genericAllow) {
      const allow = [engine.cosmetic.genericAllow, compiled.cosmetic.genericAllow].filter(Boolean).join(';');
      engine.cosmetic.genericAllow = allow;
    }
    for (const [h, css] of Object.entries(compiled.cosmetic.domains ?? {})) {
      engine.cosmetic.domains[h] = engine.cosmetic.domains[h] ? `${engine.cosmetic.domains[h]};${css}` : css;
    }
    for (const h of String(compiled.cosmetic.noCosmetic ?? '').split('\n')) if (h) engine.noCosmeticHosts.add(h);
  }
  rebuildAutomaton(engine);
}

function mergeBuckets(map, obj, offset) {
  for (const [k, ids] of Object.entries(obj ?? {})) {
    const arr = map.get(k) ?? [];
    for (const id of ids) arr.push(id + offset);
    map.set(k, arr);
  }
}

function rebuildAutomaton(engine) {
  const map = new Map();
  for (const [k, v] of Object.entries(engine.anchors)) if (k) map.set(k, v);
  engine.ac = map.size ? buildFromMap(map) : new AhoCorasick().build();
  engine.patternCount = map.size;
}

/** Extra cosmetic rules we ship ourselves (site-specific quality of life). */
const YT_HIDE = [
  'ytd-ad-slot-renderer', 'ytmusic-mealbar-promo-renderer', '.ytp-ad-module',
  '.ytp-ad-overlay-slot', '.ytp-ad-player-overlay-layout', '#player-ads',
  'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer', 'ytd-in-feed-ad-layout-renderer',
  'ytd-ad-meta-info-renderer', 'ytd-merch-shelf-renderer', 'ytmusic-promo-banner',
  'ytd-display-ad-renderer', 'ytd-companion-slot-renderer', 'ytd-action-companion-ad-renderer',
  '.ytp-ad-image-overlay', '.ytp-ad-survey-view', 'ytd-promoted-sparkles-web-renderer',
  '.ytp-ad-overlay-container', '.ytp-ad-text-overlay', '.ytp-skip-ad-button',
  'ytd-promoted-video-renderer', 'ytd-player-legacy-desktop-desktop-watch-ads-renderer',
  'ytd-desktop-display-ad-renderer', 'ytd-sentiment-survey', 'ytd-companion-ad-renderer',
  '#player-ad-div', 'ytd-video-primary-info-renderer #creator-page-for-video-ads',
].join(',') + '{display:none!important}';

export const EXTRA_CSS_HOSTS = new Map([
  // the skip button stays in the DOM on purpose: the page runtime clicks it even though the
  // surrounding ad layout is display:none, so a stray ad is dismissed without ever flashing.
  ['youtube.com', YT_HIDE],
  ['youtube-nocookie.com', YT_HIDE],
]);

for (const [host, css] of [...EXTRA_CSS_HOSTS]) {
  if (host.startsWith('*.')) { EXTRA_CSS_HOSTS.set(host.slice(2), css); EXTRA_CSS_HOSTS.delete(host); }
}

for (const [host, css] of [...EXTRA_CSS_HOSTS]) {
  if (host.startsWith('*.')) { EXTRA_CSS_HOSTS.set(host.slice(2), css); EXTRA_CSS_HOSTS.delete(host); }
}

export { buildFromMap, AhoCorasick };
