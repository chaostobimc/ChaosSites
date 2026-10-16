/**
 * Body decoding for the buffered (rewritten) path.
 *
 * undici hands us the raw bytes and does *not* apply `content-encoding`, and the browser is only
 * allowed to see bytes that match the headers we put on the response. So when a document cannot be
 * decoded cleanly we must never re-emit the compressed bytes as if they were text — to the user that
 * is not "an error", it is a black page: Chrome parses a few thousand bytes of binary noise as HTML,
 * finds nothing renderable and shows an empty frame.
 *
 * Real-world reasons for a broken `content-encoding`, all seen in the wild:
 *   - `deflate` served as *raw* deflate (no zlib wrapper) — `inflateSync` throws, `inflateRawSync` works
 *   - `gzip, gzip` / `br, gzip` — a CDN and the origin both compressed
 *   - a middlebox decompressed the body but left the header in place
 *   - `zstd`/`compress` when the Node build has no codec for it
 *   - a truncated stream (server died mid-response)
 *
 * `decodeBody()` therefore tries every token it can, sniffs the magic bytes when the header is
 * missing or wrong, and reports `ok:false` (never silent garbage) when the result is not trustworthy.
 */

import zlib from 'node:zlib';

const hasZstd = typeof zlib.zstdDecompressSync === 'function';

/** gzip magic */
const isGzip = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
/** brotli streams almost always start with these bits; no reliable magic, so we only try on request */
const isZlib = (b) => b.length > 2 && b[0] === 0x78 && (b[1] === 0x9c || b[1] === 0xda || b[1] === 0x01 || b[1] === 0x5e);
const isRawDeflate = (b) => b.length > 2 && b[0] === 0x08 && b[1] === 0x00; // rare, but some stacks emit it

function inflateOne(buf, token) {
  if (!buf.length) return buf; // an empty body has nothing to decode, and zlib throws on it
  try {
    switch (token) {
      case 'gzip': case 'x-gzip': return zlib.gunzipSync(buf);
      case 'br': case 'brotli': return zlib.brotliDecompressSync(buf);
      case 'deflate': case 'zlib': {
        try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
      }
      case 'zstd': return hasZstd ? zlib.zstdDecompressSync(buf) : null;
      default: return null; // compress/x-compress: we never offer it, so treat as unsupported
    }
  } catch {
    return null;
  }
}

/** `content-encoding: gzip, br` → ['gzip','br'] (left to right, i.e. the order they were applied) */
export function encodingTokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .split(',')
    .map((s) => s.trim())
    .filter((t) => t && t !== 'identity' && t !== 'none' && t !== '*');
}

/**
 * @returns {{buf: Buffer, ok: boolean, decoded: string[], why?: string}}
 *  `ok:false` means "these bytes are not the document" — the caller must not rewrite them.
 */
export function decodeBody(buf, contentEncoding) {
  const tokens = encodingTokens(contentEncoding);
  const decoded = [];
  let out = buf;
  // RFC 9110: the *last* listed coding was applied last, so it has to be removed first.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    const next = inflateOne(out, t);
    if (next === null) {
      // Header claims a coding we cannot apply. If the bytes are plainly text anyway, the header is
      // simply wrong (a middlebox already decoded) — that is a success, not a failure.
      if (looksTextual(out)) return { buf: out, ok: true, decoded };
      return { buf: out, ok: false, decoded, why: `content-encoding "${t}" lässt sich nicht entpacken` };
    }
    out = next;
    decoded.push(t);
  }
  if (!tokens.length && isGzip(out)) {
    // body compressed but nothing announced it: never hand binary to the browser — if it inflates,
    // use the result, otherwise it was a coincidence and the bytes stay as they are.
    const next = inflateOne(out, 'gzip');
    if (next && looksTextual(next)) return { buf: next, ok: true, decoded: ['gzip(sniffed)'] };
  }
  if (out.length && !isGzip(out) && !tokens.length && (isZlib(out) || isRawDeflate(out))) {
    const next = inflateOne(out, 'deflate');
    if (next && looksTextual(next)) return { buf: next, ok: true, decoded: ['deflate(sniffed)'] };
  }
  return { buf: out, ok: true, decoded };
}

/**
 * Cheap "is this text" test. Runs on a 4 KiB window: NUL bytes or a lot of unprintables mean the
 * buffer is still compressed/binary and must not be rendered as HTML.
 */
export function looksTextual(buf) {
  if (!buf || !buf.length) return true; // an empty text document is legal
  const n = Math.min(buf.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  return bad / n < 0.06;
}

/** Header values must be latin1-safe and single-line, or Node throws and the request dies. */
export function headerText(value, max = 240) {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, (c) => (c.charCodeAt(0) <= 0xff ? c : '?'))
    .slice(0, max);
}

export { hasZstd as zstdAvailable };
