/**
 * CSS url() rewriting.
 *
 * Used twice: on standalone stylesheets (`@import`, `url(/img/x.png)`) and inline on the
 * `style="…"` attributes / `<style>` blocks inside a document. Only the url tokens are touched,
 * so source maps, `@font-face` metrics and everything else survive byte-identical.
 */

import { toProxied } from '../encode.js';

const URL_RE = /url\(\s*(["']?)([^)"']*)\1\s*\)/gi;
const IMPORT_RE = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi;

/**
 * @param {string} css
 * @param {{sid:string, docUrl:URL, origin:string, kind:string, resolve?:(raw:string)=>string|null}} ctx
 */
export function rewriteCss(css, ctx) {
  if (!css || css.length > 8_000_000) return css;
  const resolve = ctx.resolve ?? ((raw) => {
    const value = raw.trim();
    if (!value || /^(data|blob):/i.test(value)) return null;
    try {
      return toProxied(ctx.sid, new URL(value, ctx.docUrl).href, ctx.kind);
    } catch {
      return null;
    }
  });
  let out = css.replace(URL_RE, (match, quote, raw) => {
    const next = resolve(raw);
    return next ? `url(${quote}${next}${quote})` : match;
  });
  out = out.replace(IMPORT_RE, (match, quote, raw) => {
    const next = resolve(raw);
    return next ? `@import ${quote}${next}${quote}` : match;
  });
  return out;
}

export { URL_RE, IMPORT_RE };
