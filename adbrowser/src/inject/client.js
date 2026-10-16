/**
 * Chaos ADBrowser – injected page runtime (served as /assets/up.js)
 * ----------------------------------------------------------------
 * Runs *inside* every proxied document, before any of the page's own scripts. Responsibilities:
 *
 *   1. keep URLs inside the proxy: every API a page can use to reach a network resource is
 *      wrapped so that relative, root-relative and absolute URLs are converted to proxied ones.
 *      Reads go the other way, so the page still believes it lives on its own origin
 *      (location.href, a.href, getAttribute('src') … all report the *real* URL).
 *   2. per-site storage isolation: localStorage / sessionStorage / IndexedDB / Cache API are
 *      namespaced by the real origin so proxied sites cannot collide with each other or with the
 *      browser UI itself. Cookies are emulated against a server-side jar snapshot.
 *   3. quality of life: reports the live URL/title to the browser chrome, opens popups as tabs,
 *      disables service workers (they would hijack our origin), and strips YouTube ad breaks
 *      from the player response + clicks "Skip ad".
 *
 * Every patch is individually guarded: if one API is non-patchable in this browser, the rest
 * of the page keeps working.
 */
(function () {
  'use strict';
  var U = window.__UP;
  if (!U || window.__upReady) return;
  window.__upReady = 1;

  var PREFIX = U.px;                       // "/b/<sid>/"
  var ROOT = PREFIX.slice(0, -1);          // "/b/<sid>"
  // Our own origin, captured *before* location gets faked: everything that has to build a proxy
  // URL (websockets, popups, relative fallbacks) uses these, never the faked location.*.
  var PROXY_ORIGIN = location.origin;
  var PROXY_HOST = location.host;
  var PROXY_TLS = location.protocol === 'https:';
  // The native accessors stay reachable, so we can still read the true proxied location.
  var NATIVE = {};
  (function () {
    var Loc = W.Location && W.Location.prototype;
    if (!Loc) return;
    var parts = 'href pathname search hash host hostname port protocol origin'.split(' ');
    for (var i = 0; i < parts.length; i++) {
      var d = Object.getOwnPropertyDescriptor(Loc, parts[i]);
      if (d && d.get) NATIVE[parts[i]] = d;
    }
  })();
  function raw(part) {
    var d = NATIVE[part];
    try { return d ? String(d.get.call(location)) : String(location[part]); } catch (e) { return ''; }
  }
  var W = window;
  var D = document;
  var encCache = Object.create(null);
  var originTag = (function () {
    try { return new URL(U.doc).hostname; } catch (e) { return 'site'; }
  })();

  /* ------------------------------------------------------------------ *
   *  URL helpers
   * ------------------------------------------------------------------ */
  function b64u(str) {
    var bytes = new TextEncoder().encode(str), bin = '', i;
    for (i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64u(seg) {
    try {
      var b = atob(seg.replace(/-/g, '+').replace(/_/g, '/'));
      var out = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
      return new TextDecoder().decode(out);
    } catch (e) { return null; }
  }
  function encOrigin(o) { return encCache[o] || (encCache[o] = b64u(o)); }

  function realBase() {
    return U.doc || (PROXY_ORIGIN + ROOT + '/');
  }

  /** parsed *real* URL of the current document, memoised per underlying proxied location */
  var _key = '', _u = null, _done = false;
  function realUrl() {
    var key = raw('pathname') + raw('search') + raw('hash');
    if (key === _key && _done) return _u;
    _key = key; _done = true; _u = null;
    var r = fromProxy(key);
    if (!r && U.doc) r = U.doc;
    if (r) { try { _u = new URL(r); } catch (e) { _u = null; } }
    return _u;
  }
  function realProto() {
    var u = realUrl();
    return (u && u.protocol) || (PROXY_TLS ? 'https:' : 'http:');
  }

  /** any href the page gives us -> proxied path (or null when it must stay untouched) */
  function toProxy(href) {
    if (href == null) return null;
    var s = String(href).trim();
    if (!s || s.charAt(0) === '#') return null;
    if (/^(data|blob|about:blank|javascript|mailto|tel|sms|file|filesystem|chrome|view-source):/i.test(s)) return null;
    if (s.indexOf(PREFIX) === 0) return null;                      // already inside the proxy
    var abs;
    try {
      if (/^https?:\/\//i.test(s)) abs = s;
      else if (/^\/\//.test(s)) abs = realProto() + s;
      else abs = new URL(s, realBase()).href;
    } catch (e) { return null; }
    var u;
    try { u = new URL(abs); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    return ROOT + '/p/' + encOrigin(u.origin) + (u.pathname || '/') + (u.search || '') + (u.hash || '');
  }

  /** proxied path/URL -> real URL, or null when the value is not ours */
  function fromProxy(value) {
    if (!value) return null;
    var s = String(value);
    var i = s.indexOf(ROOT + '/p/');
    if (i < 0) return null;
    var rest = s.slice(i + ROOT.length + 4);
    var slash = rest.indexOf('/');
    if (slash < 0) return null;
    var origin = unb64u(rest.slice(0, slash));
    if (!origin || !/^https?:\/\//.test(origin)) return null;
    var tail = rest.slice(slash);
    var hashIdx = tail.indexOf('#');
    var hash = '';
    if (hashIdx >= 0) { hash = tail.slice(hashIdx); tail = tail.slice(0, hashIdx); }
    return origin + tail + hash;
  }

  function isProxied(value) { return value && String(value).indexOf(ROOT + '/p/') >= 0; }

  function currentRealHref() {
    var u = realUrl();
    return (u && u.href) || U.doc || raw('href');
  }

  /** used by every patch: keep data:/#/already-proxied alone, everything else gets wrapped */
  function fix(value) {
    var p = toProxy(value);
    return p === null ? value : p;
  }

  /* ------------------------------------------------------------------ *
   *  chrome <-> page channel
   * ------------------------------------------------------------------ */
  var reportTimer = 0;
  function report(kind, extra) {
    if (reportTimer) return;
    reportTimer = setTimeout(function () {
      reportTimer = 0;
      try {
        parent.postMessage({
          __chaos: 1, kind: kind || 'nav',
          url: currentRealHref(),
          title: D.title || '',
          extra: extra || null,
        }, '*');
      } catch (e) { /* top-frame may be gone */ }
    }, 60);
  }
  W.__upReport = report;

  /* ------------------------------------------------------------------ *
   *  network: fetch / XHR / beacons / WebSockets / EventSource
   * ------------------------------------------------------------------ */
  function patchFetch() {
    if (!W.fetch) return;
    var orig = W.fetch.bind(W);
    W.fetch = function (input, init) {
      try {
        if (typeof input === 'string' || typeof input === 'undefined') input = fix(input || currentRealHref());
        else if (typeof Request !== 'undefined' && input instanceof Request) {
          if (!isProxied(input.url)) input = new Request(toProxy(input.url) || input.url, input);
        } else if (input && typeof input.url === 'string') {
          input = toProxy(input.url) || input;
        }
      } catch (e) { /* keep original */ }
      return orig(input, init);
    };
  }

  function patchXhr() {
    if (!W.XMLHttpRequest) return;
    var XP = XMLHttpRequest.prototype;
    var open = XP.open;
    XP.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      try {
        if (typeof url === 'string') { args[1] = fix(url); this.__upUrl = String(url); }
      } catch (e) {}
      return open.apply(this, args);
    };
  }

  function patchBeacon() {
    if (!navigator || !navigator.sendBeacon) return;
    var orig = navigator.sendBeacon.bind(navigator);
    try {
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        value: function (url, data) { return orig(fix(url), data); },
      });
    } catch (e) {}
  }

  function toProxyWs(url) {
    var s = String(url);
    if (s.indexOf(ROOT + '/w/') === 0) return s;
    var abs;
    try { abs = new URL(s, realBase()).href.replace(/^http/, 'ws'); } catch (e) { return s; }
    if (!/^wss?:/.test(abs)) return s;
    var u = new URL(abs);
    return (PROXY_TLS ? 'wss:' : 'ws:') + '//' + PROXY_HOST + ROOT + '/w/'
      + encOrigin(u.protocol === 'wss:' ? 'https://' + u.host : 'http://' + u.host)
      + (u.pathname || '/') + (u.search || '');
  }

  function patchSocket() {
    if (!W.WebSocket) return;
    var Native = W.WebSocket;
    function WS(url, protocols) {
      var target = toProxyWs(url);
      return protocols === undefined ? new Native(target) : new Native(target, protocols);
    }
    WS.prototype = Native.prototype;
    WS.CONNECTING = Native.CONNECTING; WS.OPEN = Native.OPEN;
    WS.CLOSING = Native.CLOSING; WS.CLOSED = Native.CLOSED;
    try { W.WebSocket = WS; } catch (e) {}
    if (W.EventSource) {
      var ES = W.EventSource;
      function ESupd(url, cfg) { return new ES(toProxy(url), cfg); }
      ESupd.prototype = ES.prototype;
      try { W.EventSource = ESupd; } catch (e) {}
    }
  }

  /* ------------------------------------------------------------------ *
   *  element / attribute level URL patching
   * ------------------------------------------------------------------ */
  var URL_ATTRS = {
    href: 1, src: 1, action: 1, formaction: 1, poster: 1, background: 1, cite: 1,
    'xlink:href': 1, 'data-src': 1, 'data-href': 1, 'data-original': 1, 'data-url': 1,
    srcset: 1, 'data-srcset': 1, imagesrcset: 1,
  };
  var URL_PROPS = [
    [W.HTMLAnchorElement, 'href'], [W.HTMLAreaElement, 'href'], [W.HTMLLinkElement, 'href'],
    [W.HTMLScriptElement, 'src'], [W.HTMLImageElement, 'src'], [W.HTMLIFrameElement, 'src'],
    [W.HTMLMediaElement, 'src'], [W.HTMLMediaElement, 'currentSrc'], [W.HTMLMediaElement, 'poster'],
    [W.HTMLSourceElement, 'src'], [W.HTMLTrackElement, 'src'], [W.HTMLInputElement, 'src'],
    [W.HTMLFormElement, 'action'], [W.HTMLQuoteElement, 'cite'], [W.HTMLEmbedElement, 'src'],
  ];

  function patchAttrs() {
    var ep = Element.prototype;
    var setA = ep.setAttribute;
    var getA = ep.getAttribute;
    ep.setAttribute = function (name, value) {
      try {
        var n = String(name).toLowerCase();
        if (URL_ATTRS[n] && typeof value === 'string') {
          if (n === 'srcset' || n === 'data-srcset' || n === 'imagesrcset') {
            value = value.split(',').map(function (part) {
              var m = /^(\s*)(\S+)(\s+\S+)?$/.exec(part);
              if (!m) return part;
              return (m[1] || '') + (fix(m[2])) + (m[3] || '');
            }).join(',');
          } else value = fix(value);
        }
      } catch (e) {}
      return setA.call(this, name, value);
    };
    ep.getAttribute = function (name) {
      var v = getA.call(this, name);
      try {
        if (v && URL_ATTRS[String(name).toLowerCase()]) {
          var r = fromProxy(v);
          if (r) return r;
        }
      } catch (e) {}
      return v;
    };

    URL_PROPS.forEach(function (pair) {
      var ctor = pair[0], prop = pair[1];
      if (!ctor) return;
      var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
      if (!d || !d.set || !d.get) return;
      try {
        Object.defineProperty(ctor.prototype, prop, {
          configurable: true,
          enumerable: d.enumerable,
          get: function () {
            var v = d.get.call(this);
            if (!v) return v;
            var r = fromProxy(v);
            return r === null ? v : r;
          },
          set: function (v) {
            var next = v == null ? v : fix(String(v));
            d.set.call(this, next);
            if (prop === 'href' || prop === 'src') {
              try { this.setAttribute('data-' + prop, String(v)); } catch (e) {}
            }
          },
        });
      } catch (e) {}
    });

    // document.write of markup containing URLs (still used by ad tags and some CMS widgets)
    var write = D.write;
    var writeln = D.writeln;
    function rewriteMarkup(s) {
      return String(s).replace(/\b(href|src|action|poster|background)\s*=\s*("|')([^"']*)\2/gi, function (m, a, q, v) {
        var p = toProxy(v);
        return p ? a + '=' + q + p + q : m;
      });
    }
    if (write) {
      D.write = function () {
        var args = Array.prototype.slice.call(arguments).map(rewriteMarkup);
        return write.apply(D, args);
      };
    }
    if (writeln) D.writeln = function () { return writeln.apply(D, Array.prototype.slice.call(arguments).map(rewriteMarkup)); };
  }

  /** safety net: anything that slipped through the static rewrite must not escape the proxy */
  function patchClicks() {
    D.addEventListener('click', function (ev) {
      var el = ev.target;
      for (var i = 0; i < 6 && el; i++, el = el.parentElement) {
        if (!el.tagName) continue;
        var tag = el.tagName.toUpperCase();
        if (tag !== 'A' && tag !== 'AREA') continue;
        var raw = el.getAttribute('href') || '';
        if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel|data):/i.test(raw)) return;
        if (el.hasAttribute('download')) return;
        if (isProxied(el.href) || isProxied(raw)) return;
        var next = toProxy(el.href || raw);
        if (!next) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (el.target === '_blank' || ev.metaKey || ev.ctrlKey || ev.shiftKey) {
          popup(next, el.href);
        } else {
          el.setAttribute('href', next);
          el.target = '';
          location.href = next;
        }
        return;
      }
    }, true);
  }

  function popup(proxiedPath, realUrl) {
    try {
      parent.postMessage({ __chaos: 1, kind: 'popup', url: realUrl, proxied: proxiedPath }, '*');
    } catch (e) {}
  }

  W.open = function (url, name, features) {
    if (url === undefined || url === '' || /^about:(blank|srcdoc)/i.test(String(url))) {
      try { return W.open('', name, features); } catch (e) { return null; }
    }
    var real = String(url);
    var proxied = toProxy(real) || real;
    // every popup becomes a tab in our chrome — a nested window we could not sandbox or filter
    popup(proxied, real);
    var fake = {
      closed: false, opener: null, location: { href: real },
      focus: function () {}, blur: function () {}, close: function () { this.closed = true; },
      // pages do w.document.write(html) on the window they got back; a no-op beats a TypeError
      document: { write: function () {}, writeln: function () {}, open: function () {}, close: function () {} },
    };
    return fake;
  };

  /* ------------------------------------------------------------------ *
   *  location / history
   * ------------------------------------------------------------------ */
  function patchLocation() {
    var Loc = W.Location && W.Location.prototype;
    if (Loc) {
      var RP = ['pathname', 'search', 'hash', 'host', 'hostname', 'port', 'protocol', 'origin'];
      var d = Object.getOwnPropertyDescriptor(Loc, 'href');
      if (d && d.configurable) {
        try {
          Object.defineProperty(Loc, 'href', {
            configurable: true,
            enumerable: d.enumerable,
            get: function () { return currentRealHref(); },
            set: function (v) { location.href = fix(String(v)); },
          });
        } catch (e) {}
      }
      ['assign', 'replace'].forEach(function (m) {
        var orig = Loc[m];
        if (!orig) return;
        try {
          Loc[m] = function (url) { return orig.call(this, fix(String(url))); };
        } catch (e) {}
      });
      // Pages route on location.pathname — if that still said "/b/<sid>/p/<enc>/…" every SPA
      // would 404 on itself, so the whole surface reports the real URL.
      RP.forEach(function (part) {
        var d = Object.getOwnPropertyDescriptor(Loc, part);
        if (!d || !d.configurable || !d.get) return;
        try {
          Object.defineProperty(Loc, part, {
            configurable: true, enumerable: d.enumerable,
            get: function () {
              var u = realUrl();
              if (!u) { try { return d.get.call(location); } catch (e) { return ''; } }
              return part === 'origin' && u.origin === 'null' ? u.protocol + '//' + u.host : u[part];
            },
            set: (part === 'pathname' || part === 'search' || part === 'hash') ? function (v) {
              var u = realUrl(); if (!u) return;
              var val = String(v == null ? '' : v);
              if (part === 'pathname') u.pathname = val || '/';
              else if (part === 'search') u.search = val ? (val.charAt(0) === '?' ? val : '?' + val) : '';
              else u.hash = val ? (val.charAt(0) === '#' ? val : '#' + val) : '';
              location.href = u.href;                    // patched setter -> fix()
            } : d.set,
          });
        } catch (e) {}
      });
    }
    try {
      Object.defineProperty(D, 'URL', { configurable: true, get: function () { return currentRealHref(); } });
      Object.defineProperty(D, 'documentURI', { configurable: true, get: function () { return currentRealHref(); } });
      Object.defineProperty(D, 'baseURI', { configurable: true, get: function () { return currentRealHref(); } });
    } catch (e) {}
    if (W.history) {
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        if (!orig) return;
        history[m] = function (state, title, url) {
          var args = Array.prototype.slice.call(arguments);
          if (typeof url === 'string' && url) args[2] = fix(url);
          var r = orig.apply(this, args);
          U.doc = currentRealHref();
          report('nav');
          return r;
        };
      });
    }
    addEventListener('popstate', function () { U.doc = currentRealHref(); report('nav'); });
    addEventListener('hashchange', function () { report('hash'); });
    addEventListener('pagehide', function () { flushCookies(); });
  }

  /* ------------------------------------------------------------------ *
   *  storage isolation + cookies
   * ------------------------------------------------------------------ */
  var cookieJar = Object.create(null);
  if (U.cookies) for (var ck in U.cookies) cookieJar[ck] = U.cookies[ck];

  function patchCookies() {
    function serialize() {
      var out = [];
      for (var k in cookieJar) out.push(k + '=' + cookieJar[k]);
      return out.join('; ');
    }
    try {
      Object.defineProperty(D, 'cookie', {
        configurable: true,
        enumerable: true,
        get: serialize,
        set: function (v) {
          var parts = String(v).split(';');
          var nv = parts[0];
          var eq = nv.indexOf('=');
          var name = (eq < 0 ? nv : nv.slice(0, eq)).trim();
          var value = eq < 0 ? '' : nv.slice(eq + 1).trim();
          var attrs = parts.slice(1).map(function (s) { return s.trim().toLowerCase(); });
          var expires = attrs.find(function (a) { return a.indexOf('expires=') === 0; });
          var past = false;
          if (expires) { var t = Date.parse(expires.slice(8)); past = !isNaN(t) && t < Date.now(); }
          if (/max-age=0\b/.test(attrs.join(';')) || past || value === '' && /expires/.test(attrs.join(';'))) delete cookieJar[name];
          else cookieJar[name] = value;
          queueFlush();
        },
      });
    } catch (e) {}
  }

  var flushTimer = 0;
  function queueFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushCookies, 60);
  }
  function flushCookies() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = 0; }
    var payload = JSON.stringify(cookieJar);
    if (payload === U.__lastCookies) return;
    U.__lastCookies = payload;
    var url = ROOT + '/api/cookies';
    try {
      if (navigator.sendBeacon) {
        var ok = navigator.sendBeacon(url, new Blob([payload], { type: 'application/json' }));
        if (ok) return;
      }
    } catch (e) {}
    try {
      (W.__upFetch || W.fetch).call(W, url, {
        method: 'POST', body: payload, keepalive: true, credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
      });
    } catch (e) {}
  }
  W.__upFetch = W.fetch; // capture the patched fetch for internal use
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushCookies();
  });

  function namespacedStorage(backing) {
    var prefix = '__up_' + originTag + '__';
    var real = null;
    try { real = W[backing]; } catch (e) { return null; }
    if (!real) return null;
    function each(fn) {
      for (var i = 0; i < real.length; i++) {
        var k = real.key(i);
        if (k && k.indexOf(prefix) === 0) fn(k.slice(prefix.length), k);
      }
    }
    var api = {
      get length() { var n = 0; each(function () { n++; }); return n; },
      key: function (idx) {
        var out = null, n = 0;
        each(function (name, full) { if (n === idx) { out = name; } n++; });
        return out;
      },
      getItem: function (k) { return real.getItem(prefix + k); },
      setItem: function (k, v) { try { real.setItem(prefix + k, String(v)); } catch (e) {} },
      removeItem: function (k) { real.removeItem(prefix + k); },
      clear: function () { var del = []; each(function (n, full) { del.push(full); }); del.forEach(function (f) { real.removeItem(f); }); },
    };
    return api;
  }

  function patchStorage() {
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      try {
        var fake = namespacedStorage(name);
        if (!fake) return;
        Object.defineProperty(W, name, { configurable: true, enumerable: true, get: function () { return fake; } });
      } catch (e) {}
    });
    try {
      if (W.IDBFactory && IDBFactory.prototype.open) {
        var oi = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (name, version) {
          return oi.call(this, '__up_' + originTag + '__' + name, version);
        };
        var od = IDBFactory.prototype.deleteDatabase;
        if (od) IDBFactory.prototype.deleteDatabase = function (name) { return od.call(this, '__up_' + originTag + '__' + name); };
      }
      if (W.Cache && caches && caches.open) {
        var oc = caches.open.bind(caches);
        caches.open = function (n) { return oc('__up_' + originTag + '__' + n); };
      }
    } catch (e) {}
    // service workers would take over *our* origin and cache other tabs
    try {
      if (navigator.serviceWorker) {
        Object.defineProperty(navigator, 'serviceWorker', {
          configurable: true,
          value: {
            register: function () { return Promise.reject(new Error('service workers are disabled in Chaos ADBrowser')); },
            getRegistration: function () { return Promise.resolve(undefined); },
            getRegistrations: function () { return Promise.resolve([]); },
            addEventListener: function () {},
            controller: null,
            ready: new Promise(function () {}),
          },
        });
      }
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ *
   *  YouTube: kill the ad break in the player response, click "Skip ad"
   * ------------------------------------------------------------------ */
  function patchPlayer() {
    var isYt = /(^|\.)youtube(-nocookie)?\.com$/.test(originTag);
    if (!isYt || !U.settings || U.settings.autoSkip === false) return;
    function scrub(json) {
      try {
        var pr = typeof json === 'string' ? JSON.parse(json) : json;
        if (!pr) return json;
        var dirty = false;
        if (pr.adPlacements) { delete pr.adPlacements; dirty = true; }
        if (pr.adSlots) { delete pr.adSlots; dirty = true; }
        if (pr.playerAds) { delete pr.playerAds; dirty = true; }
        if (pr.player && pr.player.adSlots) { delete pr.player.adSlots; dirty = true; }
        if (pr.attacks) { delete pr.attacks; dirty = true; }
        if (dirty) {
          try { return typeof json === 'string' ? JSON.stringify(pr) : pr; } catch (e) { return json; }
        }
        return json;
      } catch (e) { return json; }
    }
    // ytInitialPlayerResponse is assigned by an inline script *after* our bootstrap
    try {
      var stored = W.ytInitialPlayerResponse;
      Object.defineProperty(W, 'ytInitialPlayerResponse', {
        configurable: true,
        get: function () { return stored; },
        set: function (v) { stored = scrub(v); },
      });
    } catch (e) {}
    // XHR responses of innertube /player
    try {
      var d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseText');
      if (d && d.get) {
        Object.defineProperty(XMLHttpRequest.prototype, 'responseText', {
          configurable: true,
          get: function () {
            var t = d.get.call(this);
            if (!t || !/\/(youtubei\/v1\/player|get_video_watermark|ptracking)/.test(this.__upUrl || '')) return t;
            return scrub(t);
          },
        });
      }
    } catch (e) {}
    // skip buttons: keep the affordance visible (our CSS un-hides it) and press it for the user
    var SEL = '.ytp-ad-skip-button,.ytp-ad-skip-button-container,.ytp-ad-skip-button-modern,'
      + '.ytp-skip-ad-button,.ytp-ad-overlay-close-button,.closeButton,.ytp-ad-persistent-progress-bar-container ~ * .ytp-ad-skip-button';
    setInterval(function () {
      if (D.hidden) return;
      try {
        var nodes = D.querySelectorAll(SEL);
        for (var i = 0; i < nodes.length; i++) {
          var b = nodes[i];
          // note: no visibility check — our own CSS hides the ad layout, but a DOM click still
          // lands, so an ad that slipped past the network filter gets skipped without a flash.
          if (b.__upSkipped) continue;
          b.__upSkipped = 1;
          W.__chaosAutoSkipClicked = true;
          b.click();
          report('skipped-ad');
          return;
        }
      } catch (e) {}
    }, 600);
  }

  /* ------------------------------------------------------------------ */
  patchFetch();
  patchXhr();
  patchBeacon();
  patchSocket();
  patchAttrs();
  patchClicks();
  patchLocation();
  patchCookies();
  patchStorage();
  patchPlayer();

  new MutationObserver(function () { report('title'); }).observe(
    D.head || D.documentElement, { subtree: true, childList: true, characterData: true });

  report('load');
  addEventListener('load', function () { report('nav'); });
  // keep the real doc URL fresh so that relative URLs resolve against the *page*, not the proxy
  var urlTick = 0;
  setInterval(function () {
    var next = currentRealHref();
    if (next !== U.doc) { U.doc = next; report('nav'); }
  }, 1500);

  W.__up = { toProxy: toProxy, fromProxy: fromProxy, fix: fix, report: report, config: U };
})();
