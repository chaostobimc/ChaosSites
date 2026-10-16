#!/usr/bin/env node
/**
 * build-filters.mjs
 * ----------------
 * Downloads the public filter lists that Chaos ADBrowser ships with and compiles them into
 * `data/adblock.json.gz` (a single payload the server mmaps at boot).
 *
 *   node scripts/build-filters.mjs            # fetch + compile
 *   node scripts/build-filters.mjs --offline  # compile whatever is already in data/lists
 *   node scripts/build-filters.mjs --full     # also pull the bigger optional lists
 *
 * The download uses the GitHub tarball endpoint (codeload) so that it works from build
 * environments where only a proxy to github.com is available (typical CI / Docker builds).
 * If nothing can be fetched, the bundled seed list in `data/lists/` is used, so the build
 * never fails and the browser always has *some* filter set.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { compileFilters } from '../src/adblock/compile.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LISTS_DIR = join(ROOT, 'data', 'lists');
const OUT = join(ROOT, 'data', 'adblock.json.gz');

/** name -> [source url, path inside the source archive] */
const SOURCES = [
  {
    name: 'easylist',
    repo: 'easylist/easylist',
    ref: 'master',
    files: {
      'easylist_adservers.txt': 'easylist/easylist_adservers.txt',
      'easylist_general_block.txt': 'easylist/easylist_general_block.txt',
      'easylist_specific_block.txt': 'easylist/easylist_specific_block.txt',
      'easylist_allowlist.txt': 'easylist/easylist_allowlist.txt',
      'easylist_general_hide.txt': 'easylist/easylist_general_hide.txt',
      'easylist_specific_hide.txt': 'easylist/easylist_specific_hide.txt',
      'easylist_allowlist_general_hide.txt': 'easylist/easylist_allowlist_general_hide.txt',
      'easyprivacy_general.txt': 'easyprivacy/easyprivacy_general.txt',
      'easyprivacy_specific.txt': 'easyprivacy/easyprivacy_specific.txt',
      'easyprivacy_thirdparty.txt': 'easyprivacy/easyprivacy_thirdparty.txt',
      'easyprivacy_trackingservers.txt': 'easyprivacy/easyprivacy_trackingservers.txt',
      'easyprivacy_allowlist.txt': 'easyprivacy/easyprivacy_allowlist.txt',
      'fanboy_annoyance_general_block.txt': 'fanboy-addon/fanboy_annoyance_general_block.txt',
      'fanboy_annoyance_general_hide.txt': 'fanboy-addon/fanboy_annoyance_general_hide.txt',
      'fanboy_annoyance_specific_hide.txt': 'fanboy-addon/fanboy_annoyance_specific_hide.txt',
    },
    extraFilesFull: {
      'fanboy_social_general_hide.txt': 'fanboy-addon/fanboy_social_general_hide.txt',
      'fanboy_social_general_block.txt': 'fanboy-addon/fanboy_social_general_block.txt',
      'fanboy_newsletter_general_hide.txt': 'fanboy-addon/fanboy_newsletter_general_hide.txt',
      'easylist_adservers_popup.txt': 'easylist/easylist_adservers_popup.txt',
      'easylist_general_hide_popup.txt': 'easylist/easylist_general_hide_popup.txt',
    },
  },
];

const RAW_FALLBACK_BASES = [
  'https://raw.githubusercontent.com',
  'https://github.com',
];

const args = new Set(process.argv.slice(2));
const offline = args.has('--offline');
const full = args.has('--full');

function log(...a) { console.log('[filters]', ...a); }

async function fetchViaShell(url, timeoutMs = 90000) {
  // Sandboxed/CI images sometimes MITM TLS with a CA that Node doesn't know about, while
  // curl/wget use the system trust store. Retry through them before giving up.
  for (const bin of ['curl', 'wget']) {
    try {
      const out = bin === 'curl'
        ? execFileSync('curl', ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), url],
          { maxBuffer: 128 * 1024 * 1024 })
        : (() => {
            const tmp = mkTmp('chaos-dl-');
            execFileSync('wget', ['-q', '-O', join(tmp, 'f'), url], { timeout: timeoutMs });
            return readFileSync(join(tmp, 'f'));
          })();
      return Buffer.from(out);
    } catch { /* next */ }
  }
  return null;
}

async function fetchUrl(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'chaos-adbrowser-filters/1.0', accept: '*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const viaShell = await fetchViaShell(url, timeoutMs);
    if (viaShell) return viaShell;
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function downloadTarball(source) {
  const url = `https://codeload.github.com/${source.repo}/tar.gz/refs/heads/${source.ref}`;
  log(`fetching ${source.repo}@${source.ref} …`);
  return await fetchUrl(url, 90000);
}

function extract(tarball, wanted) {
  const dir = mkTmp('chaos-filters-');
  execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: 'ignore' });
  // archives carry a top-level directory (easylist-master/) – index by repo-relative path
  const index = new Map();
  const walk = (cur, depth) => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) { if (depth > 0) walk(full, depth - 1); continue; }
      const rel = relative(dir, full);
      const stripped = rel.split('/').slice(1).join('/'); // drop the archive root folder
      if (!index.has(stripped)) index.set(stripped, full);
    }
  };
  walk(dir, 2);
  const out = {};
  for (const [name, rel] of Object.entries(wanted)) {
    const p = index.get(rel);
    if (p && statSync(p).isFile()) out[name] = readFileSync(p, 'utf8');
    else log(`  ! missing in archive: ${rel}`);
  }
  return out;
}

function mkTmp(prefix) {
  const dir = join(tmpdir(), prefix + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function fetchOneFile(repo, ref, rel) {
  for (const base of RAW_FALLBACK_BASES) {
    const url = base.includes('raw.githubusercontent.com')
      ? `${base}/${repo}/refs/heads/${ref}/${rel}`
      : `${base}/${repo}/raw/refs/heads/${ref}/${rel}`;
    try {
      return await fetchUrl(url, 20000);
    } catch { /* try next */ }
  }
  return null;
}

function readLocalLists() {
  const out = {};
  if (!existsSync(LISTS_DIR)) return out;
  for (const f of readdirSync(LISTS_DIR)) {
    if (!f.endsWith('.txt')) continue;
    out[f] = readFileSync(join(LISTS_DIR, f), 'utf8');
  }
  return out;
}

async function main() {
  mkdirSync(LISTS_DIR, { recursive: true });
  let fetched = {};

  if (!offline) {
    for (const source of SOURCES) {
      const wanted = { ...source.files, ...(full ? source.extraFilesFull : {}) };
      let extracted = null;
      try {
        const tarball = await downloadTarball(source);
        const tb = join(mkTmp('chaos-tar-'), 'src.tgz');
        writeFileSync(tb, tarball);
        extracted = extract(tb, wanted);
        log(`tarball ok — ${Object.keys(extracted).length}/${Object.keys(wanted).length} lists`);
      } catch (err) {
        log(`tarball failed (${err.message}) — falling back to per-file download`);
        extracted = {};
        for (const [name, rel] of Object.entries(wanted)) {
          const buf = await fetchOneFile(source.repo, source.ref, rel);
          if (buf) { extracted[name] = buf.toString('utf8'); log(`  + ${name}`); }
          else log(`  - ${name} unavailable`);
        }
      }
      Object.assign(fetched, extracted);
    }
  }

  const seedPath = join(ROOT, 'data', 'seed.txt');
  const seed = existsSync(seedPath) ? readFileSync(seedPath, 'utf8') : '';
  const local = readLocalLists();
  // the seed is always compiled in: it covers the gaps when a list is stale or unavailable
  const lists = { 'seed.txt': seed, ...local, ...fetched };
  for (const [name, text] of Object.entries(fetched)) {
    writeFileSync(join(LISTS_DIR, name), text);
  }
  const t0 = Date.now();
  const payload = compileFilters(lists, {
    maxGenericHideSelectors: full ? 1400 : 900,
    maxCosmeticHosts: full ? 16000 : 9000,
    maxRules: full ? 34000 : 24000,
  });
  const json = JSON.stringify(payload);
  const gz = gzipSync(Buffer.from(json), { level: 9 });
  writeFileSync(OUT, gz);
  const c = payload.meta.counts;
  log(`compiled in ${Date.now() - t0} ms`);
  log(`  lists            : ${Object.keys(lists).join(', ')}`);
  log(`  blocked hosts    : ${c.blockedHosts}`);
  log(`  allowed hosts    : ${c.allowedHosts}`);
  log(`  network rules    : ${c.networkRules} (${c.genericRules} generic, ${c.alwaysRules} unanchored)`);
  log(`  rule anchors     : ${c.anchors}  (host buckets ${c.hostBuckets}, page buckets ${c.pageBuckets})`);
  log(`  cosmetic hosts   : ${c.cosmeticHosts}, generic selectors ${c.genericSelectors}`);
  log(`  payload          : ${fmt(json.length)} raw / ${fmt(gz.length)} gz -> ${OUT.replace(ROOT, '.')}`);
  if (Object.keys(payload.meta.skipped).length) {
    log('  dropped by design:', JSON.stringify(payload.meta.skipped));
  }
}

function fmt(n) { return n > 1024 * 1024 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 102.4) / 10 + ' KB'; }

main().catch((err) => { console.error('[filters] build failed:', err); process.exit(1); });
