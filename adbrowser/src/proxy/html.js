/**
 * HTML / CSS URL rewriter.
 *
 * Deliberately parser-free: one scan over the document with a single alternation regex,
 * skipping the *contents* of <script>/<style>… wait, <style> contents ARE rewritten (they hold
 * url() references) while <script> contents are left to the runtime patches. That keeps the
 * cost at roughly `O(document length)` with no DOM tree, which is what makes browsing through
 * the proxy feel local instead of "proxy-slow".
 */

import { rewriteUrlAttribute, toProxied } from '../encode.js';
import { rewriteCss } from './css.js';

const BLOCK_RE = /<(script|style|textarea)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<!--[\s\S]*?-->/gi;

/**
 * Branches:
 *   1                      <meta http-equiv=CSP> and SRI/crossorigin attrs -> dropped, they
 *                          would reject our injected <style>/<script> and rewritten URLs
 *   2,3,4                  href|src|…="…"  -> rewritten
 *   5,6                    style="…url(…)…" -> url() inside rewritten
 */
const SCAN_RE = /<meta[^>]*http-equiv\s*=\s*["']?(content-security-policy(?:-report-only)?|x-frame-options|expect-ct|report-to)["']?[^>]*>|\b(integrity|crossorigin|nonce)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)|\b(href|src|xlink:href|action|formaction|poster|background|cite|profile|codebase|data-src|data-srcset|data-original|data-href|data-url|srcset|imagesrcset)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)|\bstyle(\s*=\s*)("[^"]*"|'[^']*')/gi;

const META_REFRESH_RE = /<meta([^>]*?)http-equiv\s*=\s*["']?refresh["']?([^>]*)>/gi;

const SRCSET_ATTRS = new Set(['srcset', 'data-srcset', 'imagesrcset']);

export function rewriteAttrs(text, ctx) {
  if (!text || text.length > 4_000_000) return text;
  let out = text.replace(SCAN_RE, (match, ...groups) => {
    const [drop, dropName, dropEq, dropVal, name, eq, rawValue, styleEq, styleValue] = groups;
    if (drop !== undefined) return '';
    if (dropName !== undefined) return '';
    if (styleValue !== undefined) {
      const quote = styleValue[0];
      return `style${styleEq}${quote}${rewriteCssText(styleValue.slice(1, -1), ctx)}${quote}`;
    }
    const quote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '';
    const value = quote ? rawValue.slice(1, -1) : rawValue;
    if (!value) return match;
    if (SRCSET_ATTRS.has(name.toLowerCase())) {
      const next = rewriteSrcset(value, ctx);
      return next === null ? match : `${name}${eq}${quote}${next}${quote}`;
    }
    const next = rewriteUrlAttribute(value, ctx);
    return next ? `${name}${eq}${quote}${next}${quote}` : match;
  });
  // <meta http-equiv="refresh" content="0;url=…">
  out = out.replace(META_REFRESH_RE, (tag, a, b) => {
    const cm = /content\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!cm) return tag;
    const cv = (cm[2] ?? cm[3] ?? cm[4] ?? '').trim();
    const um = /^(\d+)\s*;\s*url\s*=\s*(.*)$/i.exec(cv);
    if (!um) return tag;
    const next = rewriteUrlAttribute(um[2], ctx);
    if (!next) return tag;
    return tag.replace(cm[0], `content="${um[1]};url=${next}"`);
  });
  return out;
}

function rewriteSrcset(value, ctx) {
  const parts = value.split(',');
  let changed = false;
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const m = /^(\s*)(\S+)(\s+[\d.]+[wx])?(\s*)$/.exec(seg);
    if (!m) continue;
    const next = rewriteUrlAttribute(m[2], ctx);
    if (next && next !== m[2]) { parts[i] = `${m[1]}${next}${m[3] ?? ''}${m[4] ?? ''}`; changed = true; }
  }
  return changed ? parts.join(',') : null;
}

/** inline style="…" and <style> blocks: same rule set as standalone stylesheets */
function rewriteCssText(css, ctx) {
  return rewriteCss(css, { ...ctx, resolve: (raw) => rewriteUrlAttribute(raw.trim(), ctx) });
}

export { rewriteCss };

/**
 * Rewrite a full document.
 * @param {string} html
 * @param {{sid:string, docUrl:URL, origin:string, kind:string, inject:string}} ctx
 */
export function rewriteHtml(html, ctx) {
  let out = '';
  let last = 0;
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(html)) !== null) {
    if (m.index > last) out += rewriteAttrs(html.slice(last, m.index), ctx);
    const [block, tag, attrs, body] = m;
    if (tag) {
      const lower = tag.toLowerCase();
      const newAttrs = rewriteAttrs(attrs ?? '', ctx);
      const newBody = lower === 'style' ? rewriteCssText(body ?? '', ctx) : body ?? '';
      out += `<${lower}${newAttrs}>${newBody}</${lower}>`;
    } else {
      out += block; // comments are passed through verbatim
    }
    last = m.index + block.length;
  }
  if (last < html.length) out += rewriteAttrs(html.slice(last), ctx);
  return injectHead(out, ctx.inject);
}

/** Put our bootstrap as the very first thing inside <head> so patches beat page scripts. */
export function injectHead(html, inject) {
  if (!inject) return html;
  let idx = html.search(/<head[^>]*>/i);
  if (idx >= 0) {
    const end = html.indexOf('>', idx) + 1;
    return html.slice(0, end) + inject + html.slice(end);
  }
  idx = html.search(/<html[^>]*>/i);
  if (idx >= 0) {
    const end = html.indexOf('>', idx) + 1;
    return html.slice(0, end) + '<head>' + inject + '</head>' + html.slice(end);
  }
  return inject + html;
}

/** Extract <title> without a parser (used for tab labels). */
export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title\s*>/i.exec(html);
  if (!m) return '';
  return m[1].replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
}

export { BLOCK_RE, SCAN_RE };
