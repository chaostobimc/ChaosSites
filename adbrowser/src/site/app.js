/**
 * Demo page script. Everything here is designed to be observable from the outside:
 * `window.__chaosDemo` reports what the page managed to do, which makes the whole thing testable
 * without a browser driver.
 */
(function () {
  'use strict';
  var api = {
    relativeAssetWorks: false,
    blockedStub: null,
    cookieWritten: false,
    cookieEcho: null,
    localStorageOk: false,
    hrefLooksReal: false,
    adDisplay: null,
    imageSizes: {},
    notes: [],
  };
  window.__chaosDemo = api;

  function json(url, opts) {
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) { return { status: r.status, type: r.headers.get('content-type'), body: t.slice(0, 400) }; });
    });
  }

  // 1) a relative sibling asset must still resolve inside the proxy
  json('img/photo.svg').then(function (r) {
    api.relativeAssetWorks = r.status === 200 && /svg/.test(r.type || '');
  }).catch(function (e) { api.notes.push('relative asset: ' + e.message); });

  // 2) an ad-path request must come back as the "blocked" stub, not as a JS file
  json('adserver/track.js').then(function (r) {
    api.blockedStub = r;
  });

  // 3) cookies round-trip through the proxy jar
  try {
    document.cookie = 'chaos_demo=ok; path=/; SameSite=Lax';
    api.cookieWritten = /chaos_demo=ok/.test(document.cookie);
  } catch (e) { api.notes.push('cookie: ' + e.message); }

  // 4) localStorage is namespaced per real origin
  try {
    localStorage.setItem('demo', 'x');
    api.localStorageOk = localStorage.getItem('demo') === 'x' && localStorage.length === 1;
  } catch (e) { api.notes.push('storage: ' + e.message); }

  // 5) links must look like the real site to page scripts
  try {
    var a = document.createElement('a');
    a.href = '/site/index.html';
    api.hrefLooksReal = /^https?:\/\/[^/]+\/site\/index\.html$/.test(a.href) && a.href.indexOf('/b/') < 0;
  } catch (e) { api.notes.push('anchor: ' + e.message); }

  // 6) cosmetic filtering: measure one ad slot
  try {
    var ad = document.querySelector('.ad-container') || document.querySelector('#ad-top');
    if (ad) api.adDisplay = getComputedStyle(ad).display;
  } catch (e) { api.notes.push('cosmetic: ' + e.message); }

  // 7) image dimensions: blocked ads answer with a 1x1 gif
  function probeImage(src, key) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = img.onerror = function () {
        api.imageSizes[key] = img.naturalWidth + 'x' + img.naturalHeight;
        resolve();
      };
      img.src = src;
    });
  }
  Promise.all([
    probeImage('img/photo.svg', 'real'),
    probeImage('https://tpc.googlesyndication.com/sadbundle/300x250.png', 'ad'),
  ]).catch(function () {});

  // form: echo the POST through the proxy
  var form = document.getElementById('demo');
  if (form) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var body = new URLSearchParams(new FormData(form)).toString();
      json('echo', { method: 'POST', body: body, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
        .then(function (r) {
          api.cookieEcho = r;
          var out = document.getElementById('echo-out');
          out.hidden = false;
          out.className = 'report';
          out.textContent = r.body;
        });
    });
  }

  // status readout
  var status = document.getElementById('status');
  function paint() {
    if (!status) return;
    var rows = [
      ['relatives Asset', api.relativeAssetWorks ? 'ok' : 'fehlgeschlagen'],
      ['Ad-Request', api.blockedStub ? (/blocked/.test(api.blockedStub.body) ? 'blockiert' : 'durchgelassen') : '…'],
      ['Cookie geschrieben', api.cookieWritten ? 'ok' : 'nein'],
      ['localStorage isoliert', api.localStorageOk ? 'ok' : 'nein'],
      ['href verschleiert', api.hrefLooksReal ? 'ok' : 'nein'],
      ['Ad-Container display', api.adDisplay || '…'],
      ['Bild real / ad', (api.imageSizes.real || '…') + ' / ' + (api.imageSizes.ad || '…')],
    ];
    status.innerHTML = rows.map(function (r) {
      return '<div>' + r[0] + ': <b>' + r[1] + '</b></div>';
    }).join('');
  }
  setInterval(paint, 400);
  paint();

  // "Assets abfragen" button: show exactly which sub-resources got stubbed
  var probe = document.getElementById('probe');
  if (probe) {
    probe.addEventListener('click', function () {
      var targets = [
        ['app.js', 'lokales Skript', 'muss laden'],
        ['adserver/track.js', 'Ad-Pfad /adserver/', 'muss blockiert sein'],
        ['pagead/spot.js', 'Ad-Pfad /pagead/', 'muss blockiert sein'],
        ['https://static.doubleclick.net/instream/ad_status.js', 'doubleclick', 'muss blockiert sein'],
      ];
      var tbody = document.querySelector('#probetable tbody');
      tbody.innerHTML = targets.map(function () { return ''; }).join('');
      var out = document.getElementById('probe-out');
      out.textContent = '…';
      Promise.all(targets.map(function (t) {
        return json(t[0]).then(function (r) { return { t: t, r: r }; }, function (e) { return { t: t, r: { error: e.message } }; });
      })).then(function (rs) {
        document.getElementById('probetable').hidden = false;
        tbody.innerHTML = rs.map(function (x) {
          var blocked = /blocked/.test(x.r.body || '');
          var local = x.r.status === 200 && !blocked;
          var verdict = blocked ? '<span class="ok">blockiert</span>'
            : local ? '<span class="ok">geladen</span>' : '<span class="fail">' + (x.r.status ?? x.r.error ?? '?') + '</span>';
          return '<tr><td><code>' + x.t[0] + '</code><br><span class="muted">' + x.t[1] + '</span></td>'
            + '<td>' + x.t[2] + '</td><td>' + verdict + '</td></tr>';
        }).join('');
        out.textContent = 'fertig';
      });
    });
  }
})();
