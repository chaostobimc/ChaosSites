/**
 * Bounded in-memory object cache for proxied sub-resources (images, fonts, css, js, wasm).
 *
 * Purpose: browsing through a proxy should not re-fetch a 40-asset page every time the user
 * flips back and forth. Cached entries are *already processed* (rewritten CSS, original bytes for
 * everything else), so a hit costs a Map lookup plus one res.end(buffer) — no upstream, no
 * decompression, no regex. Entries are per-proxy-URL (which contains the session id), so one
 * tab can never serve another tab's cookies or rewritten document.
 */

import { ByteBudget, log } from '../util.js';

export class Cache {
  constructor({ maxBytes = 192 * 1024 * 1024, maxObjectBytes = 6 * 1024 * 1024, defaultTtlMs = 300000, maxSize = 8000 } = {}) {
    this.map = new Map();
    this.budget = new ByteBudget(maxBytes);
    this.maxBytes = maxBytes;
    this.maxObjectBytes = maxObjectBytes;
    this.defaultTtlMs = defaultTtlMs;
    this.maxSize = maxSize;
    this.hits = 0;
    this.misses = 0;
    this.skipped = 0;
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) { this.misses++; return null; }
    if (e.expires <= Date.now()) { this.delete(key); this.misses++; return null; }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e;
  }

  set(key, entry) {
    const bytes = entry.bytes ?? entry.body?.length ?? 0;
    if (!bytes || bytes > this.maxObjectBytes) { this.skipped++; return false; }
    if (this.map.has(key)) this.delete(key);
    while (this.budget.used + bytes > this.budget.max && this.map.size) {
      const oldest = this.map.keys().next().value;
      this.delete(oldest);
    }
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.delete(oldest);
    }
    entry.bytes = bytes;
    entry.expires ??= Date.now() + this.defaultTtlMs;
    this.map.set(key, entry);
    this.budget.claim(bytes);
    return true;
  }

  delete(key) {
    const e = this.map.get(key);
    if (!e) return false;
    this.map.delete(key);
    this.budget.release(e.bytes ?? 0);
    return true;
  }

  get stats() {
    return {
      entries: this.map.size,
      bytes: this.budget.used,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      skipped: this.skipped,
      hitRate: this.hits + this.misses ? Math.round((this.hits / (this.hits + this.misses)) * 100) : 0,
    };
  }

  clear() {
    this.map.clear();
    this.budget.used = 0;
  }
}

export default Cache;
