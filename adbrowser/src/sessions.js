/**
 * Profiles and tabs.
 *
 * A *profile* is one browser (identified by an HttpOnly cookie on our own origin) and owns the
 * cookie jar, history and settings — just like a real browser profile. A *tab* (session id) is
 * a single iframe with its own document stack, referrer and stats. Tabs of one profile share
 * cookies, tabs of different profiles never do.
 *
 * Everything is in-memory and bounded, so the container's footprint stays flat over days.
 */

import { randomBytes } from 'node:crypto';
import { CookieJar } from './cookies.js';
import { log, BoundedMap } from './util.js';

export const DEFAULT_SETTINGS = {
  adblock: true,
  cosmetic: true,
  enhanced: true,
  images: true,
  media: true,
  websockets: true,
  desktopUa: true,
  stripTracking: true,
  autoSkipAds: true,
  scripts: 'allow', // 'allow' | 'ads-only' | 'block'
  strictDocs: false,
};

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid',
  'msclkid', 'mc_eid', 'mkt_tok', 'igshid', 'ref_src', 'igsh', '_hsenc', '_hsmi', 'vero_id',
];

export const stripTrackingParams = (url) => {
  try {
    const u = new URL(url);
    let hit = false;
    for (const p of TRACKING_PARAMS) {
      if (u.searchParams.has(p)) { u.searchParams.delete(p); hit = true; }
    }
    return hit ? u.href : url;
  } catch {
    return url;
  }
};

export class Store {
  constructor({ ttlMs = 12 * 3600 * 1000, maxTabs = 24, maxHistory = 200, maxProfiles = 5000 } = {}) {
    this.profiles = new BoundedMap(Math.max(maxProfiles * 2, 1000));
    this.byTab = new Map();
    this.ttlMs = ttlMs;
    this.maxTabs = maxTabs;
    this.maxHistory = maxHistory;
    // a hard ceiling: a client that never stores the profile cookie would otherwise mint one
    // profile per request and keep it until the TTL expires
    this.maxProfiles = maxProfiles;
    this.startedAt = Date.now();
    this.sweeper = setInterval(() => this.sweep(), 60000);
    this.sweeper.unref?.();
  }

  newId(len = 16) { return randomBytes(len / 2).toString('hex'); }

  profile(cid, { create = false } = {}) {
    if (cid) {
      const p = this.profiles.get(cid);
      if (p) { p.lastSeen = Date.now(); return p; }
      if (!create) return null;
    }
    const id = cid || this.newId(24);
    if (this.profiles.size >= this.maxProfiles) this.sweep(true);
    const profile = {
      id,
      jar: new CookieJar(),
      settings: { ...DEFAULT_SETTINGS },
      history: [],
      tabs: new Map(),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      stats: { blocked: 0, requests: 0, bytes: 0, savedBytes: 0 },
    };
    this.profiles.set(id, profile);
    return profile;
  }

  tab(profile, { url = null, title = '', parent = null } = {}) {
    if (profile.tabs.size >= this.maxTabs) {
      const oldest = [...profile.tabs.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) this.closeTab(oldest.id);
    }
    const tab = {
      id: this.newId(16),
      profileId: profile.id,
      url,
      title,
      referrer: null,
      parent: parent ?? null,
      openedAt: Date.now(),
      lastSeen: Date.now(),
      stats: { requests: 0, blocked: 0, bytes: 0, savedBytes: 0, hosts: new Map(), startedAt: Date.now() },
      frameStack: [],
    };
    profile.tabs.set(tab.id, tab);
    this.byTab.set(tab.id, tab);
    return tab;
  }

  /**
   * The sweeper may have pruned a profile while the user still has that tab open.
   * Re-adopt the id so the browser keeps a working session instead of a dead end.
   */
  adoptTab(sid, profile) {
    if (!profile) profile = this.profile(null, { create: true });
    const tab = this.tab(profile, {});
    this.byTab.delete(tab.id);
    profile.tabs.delete(tab.id);
    tab.id = sid;
    profile.tabs.set(sid, tab);
    this.byTab.set(sid, tab);
    return tab;
  }

  tabById(sid) {
    const t = this.byTab.get(sid);
    if (t) t.lastSeen = Date.now();
    return t ?? null;
  }

  closeTab(sid) {
    const t = this.byTab.get(sid);
    if (!t) return false;
    const p = this.profiles.get(t.profileId);
    p?.tabs.delete(sid);
    this.byTab.delete(sid);
    return true;
  }

  touch(sid, patch = {}) {
    const tab = this.tabById(sid);
    if (!tab) return null;
    Object.assign(tab, patch, { lastSeen: Date.now() });
    const profile = this.profiles.get(tab.profileId);
    if (profile) profile.lastSeen = Date.now();
    if (patch.url && profile) {
      const last = profile.history[profile.history.length - 1];
      if (!last || last.url !== patch.url || Date.now() - last.at > 5000) {
        profile.history.push({ url: patch.url, title: patch.title ?? tab.title ?? '', at: Date.now() });
        if (profile.history.length > this.maxHistory) profile.history.shift();
      } else if (patch.title) last.title = patch.title;
    }
    return tab;
  }

  countBlock(tab, host, bytesSaved = 0) {
    tab.stats.blocked++;
    tab.stats.savedBytes += bytesSaved;
    const profile = this.profiles.get(tab.profileId);
    if (profile) { profile.stats.blocked++; profile.stats.savedBytes += bytesSaved; }
    const n = (tab.stats.hosts.get(host) ?? 0) + 1;
    if (tab.stats.hosts.size < 400) tab.stats.hosts.set(host, n);
  }

  countRequest(tab, bytes = 0) {
    tab.stats.requests++;
    tab.stats.bytes += bytes;
    const profile = this.profiles.get(tab.profileId);
    if (profile) { profile.stats.requests++; profile.stats.bytes += bytes; }
  }

  /**
   * Drop idle profiles; `force` also drops the oldest ones until the ceiling is met again.
   */
  sweep(force = false) {
    const cutoff = Date.now() - this.ttlMs;
    const drop = (id, p) => {
      for (const sid of p.tabs.keys()) this.byTab.delete(sid);
      this.profiles.delete(id);
    };
    let dropped = 0;
    for (const [id, p] of this.profiles) {
      if (p.lastSeen < cutoff) { drop(id, p); dropped++; }
    }
    if (force && this.profiles.size >= this.maxProfiles) {
      const byAge = [...this.profiles.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      const over = this.profiles.size - this.maxProfiles + Math.ceil(this.maxProfiles * 0.25);
      for (let i = 0; i < over; i++) { drop(byAge[i][0], byAge[i][1]); dropped++; }
    }
    if (dropped) log.debug(`pruned ${dropped} idle profiles`);
  }

  summary(profile) {
    return {
      id: profile.id,
      settings: profile.settings,
      tabs: [...profile.tabs.values()].map((t) => ({
        id: t.id, url: t.url, title: t.title, stats: statsOf(t),
      })),
      history: profile.history.slice(-40).reverse(),
      stats: profile.stats,
      cookies: profile.jar.size,
    };
  }
}

export function statsOf(tab) {
  return {
    requests: tab.stats.requests,
    blocked: tab.stats.blocked,
    bytes: tab.stats.bytes,
    savedBytes: tab.stats.savedBytes,
    seconds: Math.max(0.001, (Date.now() - tab.stats.startedAt) / 1000),
    top: [...tab.stats.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([host, n]) => ({ host, n })),
  };
}

export { TRACKING_PARAMS };
