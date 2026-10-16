import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { AdBlocker } from '../src/adblock/engine.js';
import { FILTERS_FILE } from '../src/config.js';

let ab;
before(async () => {
  const payload = AdBlocker.fromFile(FILTERS_FILE);
  ab = new AdBlocker(payload);
});

const hits = (urls, opts = {}) => urls.map((u) => {
  const url = new URL(u);
  return [u, !!ab.match({
    url: u,
    host: url.hostname.toLowerCase(),
    pageHost: (opts.pageHost ?? url.hostname).toLowerCase(),
    type: opts.type ?? 'script',
    topLevel: opts.topLevel ?? false,
    thirdParty: opts.thirdParty ?? true,
  })];
});

test('payload is loaded and sized', () => {
  assert.ok(ab.info.meta.counts.blockedHosts > 40_000, 'hosts: ' + ab.info.meta.counts.blockedHosts);
  assert.ok(ab.info.meta.counts.networkRules > 5_000);
  assert.ok(ab.info.meta.counts.anchors > 1_000);
});

test('classic ad hosts are blocked', () => {
  for (const [u, blocked] of hits([
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://www.google-analytics.com/g/collect?v=2&t=pageview',
    'https://doubleclick.net/ddm/ad.x',
    'https://an.facebook.com/tracking/js',
    'https://static.doubleclick.net/instream/ad_status.js',
    'https://ad.doubleclick.net/N4589/adj/a/b',
    'https://cdn.taboola.com/libtrc/impl.js',
    'https://ads.pubmatic.com/MatchServer?r=1',
  ])) assert.ok(blocked, 'should block ' + u);
});

test('first-party content is never blocked', () => {
  for (const [u, blocked] of hits([
    'https://cdn.example.com/app.js',
    'https://example.com/api/posts',
    'https://fonts.googleapis.com/css2?family=Roboto',
    'https://s.ytimg.com/yts/jsbin/www-player-en_US-vflx.js',
    'https://i.vimeocdn.com/video/768969438_640x360.jpg',
    'https://de.wikipedia.org/static/images/logo.svg',
  ])) assert.ok(!blocked, 'should allow ' + u);
});

test('youtube: ads blocked, player traffic allowed', () => {
  for (const [u, blocked] of hits([
    'https://www.youtube.com/pagead/ad_status.js',
    'https://www.youtube.com/ptracking?video_id=x',
    'https://www.youtube.com/api/stats/ads?video_id=x',
  ], { pageHost: 'www.youtube.com', type: 'script' })) {
    assert.ok(blocked, 'should block ' + u);
  }
  for (const [u, blocked] of hits([
    'https://www.youtube.com/api/stats/watchtime?video_id=x',
    'https://www.youtube.com/youtubei/v1/player?key=x',
    'https://www.youtube.com/s/player/abc/www-player.css',
  ], { pageHost: 'www.youtube.com', type: 'xhr' })) {
    assert.ok(!blocked, 'should allow ' + u);
  }
});

test('path-pattern rules match regardless of host', () => {
  for (const [u, blocked] of hits([
    'https://random-blog.example/adserver/track.js',
    'https://random-blog.example/pagead/spots/x.js',
    'https://shop.example/banner/prebid.js',
    'https://news.example/static/-ad-banner.gif',
  ])) assert.ok(blocked, 'should block ' + u);
});

test('cosmetic css is scoped, generic selectors only when allowed', () => {
  const yt = ab.cosmeticCss('www.youtube.com');
  assert.ok(yt.length > 500, 'youtube gets the ad-player rules');
  assert.match(yt, /ytd-ad-slot-renderer/);
  const rnd = ab.cosmeticCss('example.org');
  assert.match(rnd, /\.ad-container|#ad-top|###googlead/);
  assert.ok(!/youtube/.test(rnd), 'youtube-only rules must not leak');
  // a generichide exception must suppress the generic junk on that host
  const hidden = ab.cosmeticCss('www.google.com');
  assert.ok(typeof hidden === 'string');
});

test('decision cache returns identical verdicts', () => {
  const url = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
  const first = ab.match({ url, host: 'pagead2.googlesyndication.com', pageHost: 'x.example', type: 'script', topLevel: false });
  const second = ab.match({ url, host: 'pagead2.googlesyndication.com', pageHost: 'x.example', type: 'script', topLevel: false });
  assert.deepEqual(first, second);
  assert.ok(ab.info.meta.counts.blockedHosts > 0);
});

test('user rules: block, exception and ## selectors', () => {
  const fresh = new AdBlocker(AdBlocker.fromFile(FILTERS_FILE));
  const r = fresh.applyUserRules([
    '||tracker.test^',
    '@@||allowed.tracker.test^',
    'example.org###chaos-unique-ad-9x7',
    '/ads-vendor/special.js',
  ].join('\n'));
  // ||host^ rules become host entries (not counted as network rules), path rules stay generic
  assert.equal(r.hosts, 1, JSON.stringify(r));
  assert.equal(r.cosmetic, 1, JSON.stringify(r));
  assert.ok(r.rules >= 1, JSON.stringify(r));
  const m = (u, type = 'script') => fresh.match({
    url: u, host: new URL(u).hostname, pageHost: 'other.example', type, topLevel: false,
  });
  assert.ok(m('https://tracker.test/pixel.gif'), 'blocked by user rule');
  assert.ok(!m('https://allowed.tracker.test/pixel.gif'), 'exception respected');
  assert.ok(m('https://anything.test/ads-vendor/special.js'), 'generic path rule');
  assert.ok(fresh.cosmeticCss('example.org').includes('#chaos-unique-ad-9x7{display:none'), 'host rule missing');
  assert.ok(!fresh.cosmeticCss('other.example').includes('chaos-unique-ad-9x7'), 'host-scoped rule leaked into generic css');
  assert.ok(fresh.cosmeticCss('other.example').includes('#banner-ad'), 'the payload generic block must survive the merge');
});

test('websocket and media types are filterable', () => {
  const m = (u, type) => ab.match({
    url: u, host: new URL(u).hostname, pageHost: 'news.example', type, topLevel: false,
  });
  assert.ok(m('wss://doubleclick.net/socket', 'websocket'));
  assert.ok(m('https://pubads.g.doubleclick.net/video/ad.mp4', 'media'));
  assert.ok(!m('https://de.wikipedia.org/video/normal.mp4', 'media'));
});

test('rule options are honoured: $third-party and domain= exceptions', () => {
  const m = (u, pageHost, type = 'script') => ab.match({
    url: u, host: new URL(u).hostname, pageHost, type, topLevel: false,
    thirdParty: new URL(u).hostname !== pageHost,
  });
  // ||zanox.com/ppv/$third-party — only ever fires from somebody else's page
  const zanox = 'https://zanox.com/ppv/x.gif';
  assert.equal(m(zanox, 'news.example', 'image')?.rule, '||zanox.com/ppv/$third-party');
  assert.equal(m(zanox, 'zanox.com', 'image'), null, 'first-party must not be blocked by a $third-party rule');
  // /prebid.$script,domain=~prebid.org — the exception has to remove *this* rule on that page
  const prebid = 'https://shop.example/static/prebid.js';
  assert.equal(m(prebid, 'other.example')?.rule, '/prebid.$script,domain=~prebid.org');
  assert.notEqual(m(prebid, 'prebid.org')?.rule, '/prebid.$script,domain=~prebid.org',
    'domain=~prebid.org must exempt prebid.org pages');
});

test('invalid or empty input does not throw', () => {
  assert.equal(ab.match({ url: 'not a url', host: '', type: 'script' }), null);
  const empty = new AdBlocker(null);
  assert.equal(empty.match({ url: 'https://x.example/a.js', host: 'x.example', type: 'script' }), null);
  assert.equal(empty.cosmeticCss('x.example'), '');
  assert.deepEqual(empty.applyUserRules(''), { rules: 0, hosts: 0, cosmetic: 0, cosmeticHosts: 0 });
});
