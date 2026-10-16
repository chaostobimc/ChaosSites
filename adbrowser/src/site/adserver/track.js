/* If this file executes in a proxied page, the filter is NOT working:
   a request to a path containing /adserver/ must be answered with the block stub. */
window.__chaosAdServerLoaded = true;
try { navigator.sendBeacon('/adserver/ping', 'beacon'); } catch (e) {}
console.warn('[demo] ad server script loaded — that should not happen');
