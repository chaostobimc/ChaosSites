/**
 * Chaos ADBrowser – filter list compiler
 * -------------------------------------
 * Parses AdBlock-Plus style filter lists (EasyList, EasyPrivacy, Fanboy’s Annoyance, …) and
 * compiles them into a compact, engine-ready payload:
 *
 *   hosts      : blob of blocked hostnames        -> suffix walk against a Set
 *   hostAllow  : blob of allowed hostnames        (unrestricted @@ rules)
 *   rules      : master rule table, addressed by numeric id
 *   anchors    : literal -> [ruleId] for an Aho–Corasick prefilter
 *   always     : [ruleId] that must be checked for every request
 *   hostBucket : requestHost -> [ruleId] (rules anchored on `||host/…`)
 *   pageBucket : pageHost    -> [ruleId] (rules restricted via `$domain=`)
 *   cosmetic   : generic + per-domain hide/unhide CSS
 *
 * Design goals: bounded memory, O(url length) work per request, and *never* half-applying a
 * rule — anything we cannot fully honour is dropped (and counted), so pages don't break.
 */

export const TYPES = [
  'document', 'subdocument', 'image', 'script', 'stylesheet', 'font',
  'media', 'object', 'xmlhttprequest', 'ping', 'websocket', 'other',
];
const TYPE_BIT = new Map(TYPES.map((t, i) => [t, 1 << i]));
for (const [alias, target] of [
  ['fetch', 'xmlhttprequest'], ['xhr', 'xmlhttprequest'], ['beacon', 'ping'],
  ['frame', 'subdocument'], ['iframe', 'subdocument'], ['innerframe', 'subdocument'],
  ['mainframe', 'document'], ['doc', 'document'], ['object-subrequest', 'object'],
  ['inline-script', 'script'], ['inline-font', 'font'], ['background', 'image'],
  ['all', null], ['empty', null], ['paintworklet', null], ['serviceworker', null],
  ['sharedworker', null], ['report', 'other'], ['mp4', 'media'], ['popup', null],
]) {
  TYPE_BIT.set(alias, target === null ? 0 : TYPE_BIT.get(target));
}

const KNOWN_OPTIONS = new Set([
  'domain', 'third-party', '3p', 'first-party', '1p', 'strict3p', 'strict1p', 'important',
  'badfilter', 'match-case', 'generichide', 'specifichide', 'elemhide', 'duplicate',
  'instructions', 'all', 'empty', 'other', ...TYPE_BIT.keys(),
]);

const SEP_CLASS = '[^a-z0-9_.%\\-]';
const NEEDS_ESCAPE = new Set('.+?^${}()|[]\\/'.split(''));
const RE_META = /[.*+?^${}()|[\]\\/]/g;

const MULTI_LABEL_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'ltd.uk', 'plc.uk', 'nhs.uk', 'sch.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'id.au', 'com.br', 'net.br', 'org.br', 'gov.br', 'com.ar', 'com.mx', 'com.cn', 'net.cn',
  'org.cn', 'gov.cn', 'co.in', 'net.in', 'org.in', 'gov.in', 'co.nz', 'net.nz', 'org.nz',
  'govt.nz', 'co.za', 'org.za', 'web.za', 'com.tr', 'org.tr', 'net.tr', 'gov.tr', 'com.tw',
  'org.tw', 'co.kr', 'or.kr', 'com.sg', 'edu.sg', 'com.hk', 'org.hk', 'com.my', 'net.my',
  'org.my', 'co.id', 'or.id', 'com.ph', 'com.pl', 'net.pl', 'org.pl', 'edu.pl', 'info.pl',
  'mil.pl', 'com.ua', 'in.ua', 'co.il', 'org.il', 'net.il', 'ac.il', 'com.pt', 'org.pt',
  'com.ro', 'co.at', 'ac.at', 'or.at', 'gv.at', 'com.ec', 'com.pe', 'org.pe', 'com.co',
  'com.eg', 'com.sa', 'com.pk', 'com.ng', 'com.gh', 'com.vn', 'com.gr', 'edu.gr', 'org.gr',
  'com.cy', 'com.ee', 'com.lt', 'com.lv', 'com.mk', 'com.ai', 'com.fj', 'fr', 'fi', 'ax',
]);

export function registrableDomain(host) {
  if (!host) return '';
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  return MULTI_LABEL_TLDS.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** `||rule.com^` semantics: matches when ruleHost equals host or is a parent domain of it. */
export function hostSuffixMatch(ruleHost, host) {
  if (!ruleHost || !host) return false;
  if (host === ruleHost) return true;
  return host.length > ruleHost.length + 1 && host.endsWith('.' + ruleHost);
}

/** Parent domains, most specific first: a.b.c.com -> [a.b.c.com, b.c.com, c.com]. */
export function hostSuffixes(host) {
  if (!host) return [];
  const out = [host];
  let dot = host.indexOf('.');
  while (dot >= 0) {
    const next = host.indexOf('.', dot + 1);
    if (next < 0) break; // the remainder would be a bare TLD — never a filter key
    out.push(host.slice(dot + 1));
    dot = next;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  pattern translation                                                */
/* ------------------------------------------------------------------ */

function convertRegexLiteral(pattern) {
  if (pattern[0] !== '/') return null;
  let end = -1;
  for (let j = 1; j < pattern.length; j++) {
    const c = pattern[j];
    if (c === '\\') { j++; continue; }
    if (c === '/' && (j === pattern.length - 1 || pattern[j + 1] === '$')) { end = j; break; }
  }
  if (end < 1) return null;
  const inner = pattern.slice(1, end);
  try { new RegExp(inner, 'i'); } catch { return null; }
  return { host: null, hostOnly: false, lits: [], re: inner, prefix: null };
}

function escapeRe(s) { return s.replace(RE_META, '\\$&'); }

/**
 * Translate one ABP filter pattern into literals + a (rarely needed) regular expression.
 * @returns {{host:?string, hostOnly:boolean, lits:string[], re:?string, prefix:?string}|null}
 */
export function translatePattern(pattern) {
  const rl = convertRegexLiteral(pattern);
  if (rl) return rl;
  if (pattern.includes('#')) return null; // cosmetic syntax, not a network rule

  let p = pattern;
  let host = null;
  let anchorStart = false;
  let anchorEnd = false;

  if (p.startsWith('||')) {
    let i = 2;
    let h = '';
    while (i < p.length && !'/^*|'.includes(p[i])) h += p[i++];
    h = h.toLowerCase();
    if (h && !/^[a-z0-9._:\-[\]]+$/.test(h)) return null;
    host = h || null;
    p = p.slice(i);
  } else {
    if (p.startsWith('|')) { anchorStart = true; p = p.slice(1); }
    if (p.endsWith('|') && p.length > 1) { anchorEnd = true; p = p.slice(0, -1); }
  }

  const lits = [];
  let cur = '';
  let re = '';
  const flush = () => { if (cur) lits.push(cur.toLowerCase()); cur = ''; };

  for (let j = 0; j < p.length; j++) {
    const c = p[j];
    if (c === '*') { re += '.*'; flush(); continue; }
    if (c === '^') {
      re += p[j + 1] === '*' ? '.*' : `(?:${SEP_CLASS}|$)`;
      flush();
      continue;
    }
    if (c === '\\') {
      const nx = p[++j];
      if (nx === undefined) break;
      cur += nx;
      re += NEEDS_ESCAPE.has(nx) ? '\\' + nx : nx;
      continue;
    }
    cur += c;
    re += NEEDS_ESCAPE.has(c) ? '\\' + c : c;
  }
  flush();

  if (!host) {
    const body = re ? (anchorStart ? '^' : '') + re + (anchorEnd ? '$' : '') : '';
    return { host: null, hostOnly: false, lits: dedupe(lits), re: body, prefix: null };
  }

  const stripped = p.replace(/^[\^*]+/, '').replace(/[\^*|]+$/, '');
  if (stripped === '') {
    return { host, hostOnly: true, lits: [], re: null, prefix: null };
  }
  // Host-anchored: `re` already starts with the path (or a separator class), so the anchor
  // ends right after host[:port] — no extra separator, or we would require two slashes.
  const anchor = `^https?:\\/\\/([^/?#]*\\.)?${escapeRe(host)}(?::\\d+)?`;
  return { host, hostOnly: false, lits: dedupe(lits), re: anchor + re, prefix: literalPrefix(stripped) };
}

function literalPrefix(rest) {
  // `||host/path` without wildcards -> "/path" is pinned to the start of the request path
  if (!rest.startsWith('/') || /[*^\\[]/.test(rest)) return null;
  return rest.length >= 2 ? rest.toLowerCase() : null;
}

function splitOptions(line) {
  for (let i = line.length - 1; i > 0; i--) {
    if (line[i] !== '$' || line[i - 1] === '\\') continue;
    const rest = line.slice(i + 1);
    if (!rest || rest.length > 260) continue;
    if (/https?:\/\//i.test(rest)) continue;
    if (!/^[A-Za-z0-9~=,._*!$|/:+\-%&[\](){}'"?@^ ]+$/.test(rest)) continue;
    if (!/^~?[a-z][a-z0-9_.*-]*([=,].*)?$/i.test(rest.split(',')[0])) continue;
    return [line.slice(0, i), rest];
  }
  return [line, ''];
}

/* ------------------------------------------------------------------ */
/*  cosmetic rules                                                     */
/* ------------------------------------------------------------------ */

const COSMETIC_UNSUPPORTED = /:style\(|:upward\(|:has-text\(|:matches-|:xpath\(|:remove|:nth-ancestor|:if\b|#\?#/;
const TOO_GENERIC = /^(body|html|\*|a|div|span|p|img|iframe|table|tr|li)$/;

export function parseCosmetic(line) {
  let idx = -1;
  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] !== '#') continue;
    const nxt = line[i + 1];
    if (nxt === '#' || nxt === '@' || nxt === '$') { idx = i; break; }
  }
  if (idx < 0) return null;
  let unhide = false;
  let consumed = 2;
  if (line[idx + 1] === '@' && line[idx + 2] === '#') { unhide = true; consumed = 3; }
  else if (line[idx + 1] === '#') { if (line[idx + 2] === '$') return null; }
  else return null;

  const domPart = line.slice(0, idx);
  const selector = line.slice(idx + consumed).trim();
  if (!selector || selector.length > 300) return null;
  if (COSMETIC_UNSUPPORTED.test(selector)) return null;
  if (/[{}]/.test(selector) || /javascript:/i.test(selector)) return null;
  if (TOO_GENERIC.test(selector)) return null;
  const domains = domPart ? domPart.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : [];
  if (domains.some((d) => !/^~?[a-z0-9.*_-]+$/i.test(d))) return null;
  // "^domain" = exception-only rule, "~domain" = negated scope: too easy to over-block here
  if (domains.some((d) => d.startsWith('~') || d.startsWith('^'))) return null;
  return { unhide, selector, domains: domains.map((d) => d.replace(/^\*\./, '')) };
}

/* ------------------------------------------------------------------ */
/*  network rules                                                      */
/* ------------------------------------------------------------------ */

export function parseNetwork(line, ctx = { bump() {}, badfilters: new Set() }) {
  let exc = false;
  let body = line;
  if (body.startsWith('@@')) { exc = true; body = body.slice(2); }
  const [pattern, optionsRaw] = splitOptions(body);
  if (!pattern) { ctx.bump('emptyPattern'); return null; }

  const opt = {
    dom: null, domNot: null, tp: 0, imp: false, only: 0, excl: 0,
    badfilter: false, ghide: false, shide: false, unknown: 0,
  };
  if (optionsRaw) {
    for (let token of optionsRaw.split(',')) {
      token = token.trim();
      if (!token) { opt.unknown++; continue; }
      const neg = token[0] === '~';
      const name = (neg ? token.slice(1) : token).split('=')[0].toLowerCase();
      if (!KNOWN_OPTIONS.has(name)) { opt.unknown++; continue; }
      if (name === 'domain') {
        for (const part of token.slice(token.indexOf('=') + 1).split('|')) {
          if (!part) continue;
          let bare = (part[0] === '~' ? part.slice(1) : part).replace(/^\^|\^$/g, '').toLowerCase();
          // "^*.example.com" / "example.com/*" style: keep the plain domain, our matcher
          // already treats it as "this domain and everything below it".
          bare = bare.replace(/^\*\.?/, '').replace(/\/.*$/, '').replace(/^\^|\^$/g, '');
          if (!/^[a-z0-9._-]*[a-z0-9][a-z0-9._-]*$/.test(bare)) continue;
          if (part[0] === '~') (opt.domNot ??= []).push(bare);
          else (opt.dom ??= []).push(bare);
        }
        continue;
      }
      if (name === 'third-party' || name === '3p' || name === 'strict3p') { opt.tp = neg ? 2 : 1; continue; }
      if (name === 'first-party' || name === '1p' || name === 'strict1p') { opt.tp = neg ? 1 : 2; continue; }
      if (name === 'important') { opt.imp = !neg; continue; }
      if (name === 'badfilter') { opt.badfilter = true; continue; }
      if (name === 'generichide') { opt.ghide = true; continue; }
      if (name === 'specifichide') { opt.shide = true; continue; }
      if (name === 'match-case' || name === 'duplicate' || name === 'instructions' || name === 'elemhide') continue;
      const bit = TYPE_BIT.get(name);
      if (bit !== undefined) { if (bit) { if (neg) opt.excl |= bit; else opt.only |= bit; } continue; }
      opt.unknown++;
    }
    if (opt.unknown) { ctx.bump('unsupportedOption'); return null; }
  }

  const conv = translatePattern(pattern);
  if (!conv) { ctx.bump('pattern'); return null; }
  const raw = pattern + (optionsRaw ? '$' + optionsRaw : '');
  if (opt.badfilter) { ctx.badfilters.add(normPattern(pattern)); return null; }
  if (opt.ghide || opt.shide) {
    if (!exc) return null;
    return { cosmeticException: true, host: conv.host, dom: opt.dom, raw };
  }
  if (!conv.hostOnly && !conv.lits.length && !conv.re) { ctx.bump('useless'); return null; }
  const onlyDocument = opt.only !== 0 && (opt.only & 1) === opt.only;
  if (!exc && onlyDocument && !opt.imp) { ctx.bump('documentOnly'); return null; }

  return {
    raw,
    exc,
    host: conv.host,
    hostOnly: !!conv.hostOnly,
    prefix: conv.prefix ?? null,
    lits: dedupe(conv.lits.filter((l) => l.length >= 2 && !/^\.\w{1,4}$/.test(l))),
    re: conv.re || null,
    tp: opt.tp,
    imp: opt.imp ? 1 : 0,
    only: opt.only,
    excl: opt.excl,
    dom: opt.dom,
    domNot: opt.domNot,
  };
}

function dedupe(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr) if (!seen.has(v)) { seen.add(v); out.push(v); }
  return out;
}

function normPattern(s) { return String(s ?? '').toLowerCase().replace(/\s+/g, ''); }

/* ------------------------------------------------------------------ */
/*  main compiler                                                      */
/* ------------------------------------------------------------------ */

export function compileFilters(listMap, opts = {}) {
  const maxGenericSelectors = opts.maxGenericHideSelectors ?? 900;
  const maxRulesPerBucket = opts.maxRulesPerHostBucket ?? 16;
  const maxCosmeticHosts = opts.maxCosmeticHosts ?? 9000;
  const maxRules = opts.maxRules ?? 24000;

  const counts = { network: 0, cosmetic: 0, skipped: 0 };
  const skipped = new Map();
  const bump = (k) => skipped.set(k, (skipped.get(k) ?? 0) + 1);

  const hosts = new Set();
  const hostAllow = new Set();
  const rules = [];
  const seenRule = new Map();
  const hostBucket = new Map();
  const pageBucket = new Map();
  const genericIds = [];
  const badfilters = new Set();
  const genericHide = new Map();
  const genericUnhide = new Set();
  const hideByHost = new Map();
  const unhideByHost = new Map();
  const noCosmetic = new Set();
  const sources = [];

  const pushBucket = (map, key, id) => {
    let arr = map.get(key);
    if (!arr) map.set(key, (arr = []));
    if (arr.length >= maxRulesPerBucket) { bump('bucketOverflow'); return; }
    arr.push(id);
  };

  const addRule = (rule) => {
    const key = normPattern(rule.raw);
    if (seenRule.has(key) || badfilters.has(key) || rules.length >= maxRules) {
      counts.skipped++;
      if (rules.length >= maxRules) bump('maxRules');
      return;
    }
    const id = rules.length;
    seenRule.set(key, id);
    rules.push(rule);
    counts.network++;
    if (rule.host) pushBucket(hostBucket, rule.host, id);
    else if (rule.dom) for (const d of rule.dom) pushBucket(pageBucket, d, id);
    else genericIds.push(id);
  };

  for (const [name, text] of Object.entries(listMap)) {
    const meta = { list: name, network: 0, cosmetic: 0, skipped: 0 };
    for (const rawLine of String(text).split('\n')) {
      const line = rawLine.trim();
      if (!line || line[0] === '!' || line[0] === '[') continue;
      let cos = null;
      let rule = null;
      try {
        cos = parseCosmetic(line);
        if (!cos) rule = parseNetwork(line, { bump, badfilters });
      } catch { cos = null; rule = null; }
      if (cos) {
        meta.cosmetic++;
        counts.cosmetic++;
        applyCosmetic(cos, { genericHide, genericUnhide, hideByHost, unhideByHost });
        continue;
      }
      if (!rule) { meta.skipped++; counts.skipped++; continue; }
      if (rule.hostOnly) {
        meta.network++;
        if (rule.exc) hostAllow.add(rule.host); else hosts.add(rule.host);
        continue;
      }
      if (rule.cosmeticException) {
        meta.network++;
        for (const d of rule.dom ?? []) noCosmetic.add(d);
        if (rule.host) noCosmetic.add(rule.host);
        continue;
      }
      meta.network++;
      addRule(rule);
    }
    sources.push(meta);
  }

  // anchors for the Aho-Corasick prefilter; unanchored rules must always be verified
  const anchors = new Map();
  const always = [];
  for (const id of genericIds) {
    const anchor = pickAnchor(rules[id]);
    if (anchor === null) { always.push(id); continue; }
    let s = anchors.get(anchor);
    if (!s) anchors.set(anchor, (s = new Set()));
    s.add(id);
  }

  const cosmetic = buildCosmetic({
    genericHide, genericUnhide, hideByHost, unhideByHost, noCosmetic,
    maxGenericSelectors, maxCosmeticHosts,
  });

  return {
    meta: {
      built: new Date().toISOString(),
      engine: 'chaos-ab-2',
      sources,
      counts: {
        blockedHosts: hosts.size,
        allowedHosts: hostAllow.size,
        networkRules: rules.length,
        hostBuckets: hostBucket.size,
        pageBuckets: pageBucket.size,
        genericRules: genericIds.length,
        alwaysRules: always.length,
        anchors: anchors.size,
        cosmeticHosts: Object.keys(cosmetic.domains).length,
        genericSelectors: cosmetic.generic ? cosmetic.generic.split(',').length : 0,
        skipped: counts.skipped,
      },
      skipped: Object.fromEntries(skipped),
    },
    hosts: [...hosts].sort().join('\n'),
    hostAllow: [...hostAllow].sort().join('\n'),
    rules: rules.map(serializeRule),
    anchors: Object.fromEntries([...anchors].map(([k, v]) => [k, [...v]])),
    always,
    hostBucket: Object.fromEntries([...hostBucket].map(([k, v]) => [k, [...new Set(v)]])),
    pageBucket: Object.fromEntries([...pageBucket].map(([k, v]) => [k, [...new Set(v)]])),
    cosmetic,
  };
}

function serializeRule(r) {
  const o = {};
  if (r.lits.length) o.l = r.lits;
  if (r.re) o.r = r.re;
  if (r.prefix) o.p = r.prefix;
  if (r.host) o.h = r.host;
  if (r.dom) o.d = r.dom;
  if (r.domNot) o.n = r.domNot;
  if (r.tp) o.t = r.tp;
  if (r.imp) o.i = 1;
  if (r.only) o.o = r.only;
  if (r.excl) o.x = r.excl;
  if (r.exc) o.e = 1;
  o.s = r.raw.length > 140 ? r.raw.slice(0, 140) : r.raw;
  return o;
}

function pickAnchor(r) {
  if (!r.lits.length) return null;
  let best = '';
  for (const l of r.lits) if (l.length > best.length) best = l;
  if (best.length < 5) return null;
  if (!/^[a-z0-9._\-/?=&%+:'"~@!*,;() \[\]{}]+$/.test(best)) return null;
  return best.length > 48 ? best.slice(0, 48) : best;
}

function applyCosmetic(cos, maps) {
  const plain = cos.domains.filter((d) => !d.startsWith('~') && !d.includes('*'));
  if (!plain.length) {
    if (cos.unhide) { maps.genericUnhide.add(cos.selector); return; }
    maps.genericHide.set(cos.selector, (maps.genericHide.get(cos.selector) ?? 0) + 1);
    return;
  }
  for (const h of plain) {
    const map = cos.unhide ? maps.unhideByHost : maps.hideByHost;
    let s = map.get(h);
    if (!s) map.set(h, (s = new Set()));
    if (s.size < 80) s.add(cos.selector);
  }
}

function buildCosmetic(a) {
  const ranked = [...a.genericHide.entries()]
    .filter(([sel]) => !a.genericUnhide.has(sel))
    .sort((x, y) => y[1] - x[1] || x[0].length - y[0].length)
    .map(([sel]) => sel)
    .slice(0, a.maxGenericSelectors);
  const domains = {};
  let n = 0;
  for (const h of [...a.hideByHost.keys()].sort()) {
    if (n >= a.maxCosmeticHosts) break;
    const hide = [...a.hideByHost.get(h)];
    const unhide = [...(a.unhideByHost.get(h) ?? [])].filter((s) => !hide.includes(s));
    let css = '';
    if (hide.length) css += hide.map((s) => `${s}{display:none!important}`).join(';');
    if (unhide.length) css += ';' + unhide.map((s) => `${s}{display:block}`).join(';');
    if (css) { domains[h] = css; n++; }
  }
  return {
    generic: ranked.length ? `${ranked.join(',')}{display:none!important}` : '',
    genericAllow: [...a.genericUnhide].slice(0, 500).map((s) => `${s}{display:block}`).join(';'),
    domains,
    noCosmetic: [...a.noCosmetic].sort().join('\n'),
  };
}

/** Compile a small blob of rules (used for user-defined rules at runtime). */
export function compileRuleText(text) {
  return compileFilters({ 'user-rules.txt': text });
}

export { SEP_CLASS };
