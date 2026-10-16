/**
 * The <head> payload injected into every proxied document.
 *
 * Order matters: config object → element hiding CSS → runtime. All three must be parsed before
 * the page's own scripts run, otherwise half the patches are too late (that is exactly what makes
 * naive proxies feel broken on modern sites).
 */

import config from '../config.js';

const CLIENT_PATH = '/assets/up.js';

/** base64url of the origin is built once per origin by the client too, so keep it server-side */
export function bootstrapFor(tab, profile, data) {
  const { docUrl, origin, cookies, css, settings } = data;
  const doc = docUrl.replace(/#.*$/, '');
  const state = {
    sid: tab.id,
    px: proxyPrefix(tab.id),
    doc,
    origin,
    cookies: cookies || {},
    settings: {
      autoSkip: settings.autoSkipAds !== false,
      cosmetic: !!settings.cosmetic,
      adblock: !!settings.adblock,
    },
  };
  // </script> inside JSON strings would break out of the tag
  const json = JSON.stringify(state).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  const style = sanitizeCss(css || '');
  return `<script>window.__UP=${json}</script>`
    + (style ? `<style id="__chaos-ab-css">${style}</style>` : '')
    + `<script src="${CLIENT_PATH}" data-chaos="runtime"></script>`;
}

export function proxyPrefix(sid) {
  const iso = config.isolateOrigin?.(sid);
  return `${iso || ''}/b/${sid}/`;
}

function sanitizeCss(css) {
  return String(css)
    .replace(/<\/\s*style/gi, '<\\/style')
    .replace(/@import[^;]*;/gi, '') // never let a filter list pull external CSS
    .replace(/expression\s*\(/gi, 'expression(') // no-op guard, kept for clarity
    .slice(0, 480 * 1024);
}

export { CLIENT_PATH };
