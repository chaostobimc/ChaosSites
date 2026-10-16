/**
 * WebSocket tunnel.
 *
 * Frames are *not* parsed: we replay the client's `Upgrade` request against the real host (with
 * the correct Host/Origin/Cookie from the session jar) and then pipe raw bytes both ways. That is
 * both the fastest and the most compatible option — extensions like permessage-deflate and any
 * sub-protocol keep working, and CPU cost per message is zero.
 */

import net from 'node:net';
import tls from 'node:tls';
import { Buffer } from 'node:buffer';

import { log } from '../util.js';
import { parseProxied } from '../encode.js';
import { hostOf } from '../util.js';

const IDLE_MS = Number(process.env.CHAOS_WS_IDLE_MS ?? 5 * 60 * 1000);
const FORWARDED = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version',
  'sec-websocket-protocol', 'sec-websocket-extensions', 'origin', 'cookie', 'authorization',
  'user-agent', 'cache-control', 'pragma', 'sec-websocket-subprotocol-info']);

export function attachWebSocketTunnel(server, { store, engine }) {
  const tunnels = new Set();

  server.on('upgrade', (req, clientSocket, head) => {
    if (req.__chaosUpgrade) return; // another upgrade handler (the demo echo) owns this socket
    const parsed = parseProxied(req.url ?? '/');
    if (!parsed || parsed.kind !== 'w') {
      return reject(clientSocket, 404, 'not a websocket proxy route');
    }
    const tab = store.tabById(parsed.sid);
    if (!tab) return reject(clientSocket, 400, 'unknown session');
    const profile = store.profile(tab.profileId, { create: false });
    const settings = profile?.settings ?? {};
    if (!settings.websockets) return reject(clientSocket, 503, 'websockets disabled');

    const target = parsed.realUrl.replace(/^http/, 'ws');
    let u;
    try { u = new URL(target); } catch { return reject(clientSocket, 400, 'bad websocket url'); }
    const isSecure = u.protocol === 'wss:';
    const realHttpUrl = (isSecure ? 'https://' : 'http://') + u.host + u.pathname + (u.search ?? '');

    if (settings.adblock && engine?.opts.enabled) {
      const blocked = engine.match({
        url: realHttpUrl,
        host: u.hostname.toLowerCase(),
        pageHost: hostOf(tab.url ?? '').toLowerCase(),
        type: 'websocket',
        topLevel: false,
      });
      if (blocked) return reject(clientSocket, 403, 'blocked by ad filter: ' + blocked.rule);
    }

    const host = u.hostname;
    const port = u.port ? Number(u.port) : isSecure ? 443 : 80;
    const headers = buildHeaders(req, u, profile, tab);
    const socket = isSecure
      ? tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port });
    socket.setNoDelay(true);

    let settled = false;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      log.debug(`ws ${target} -> ${why}`);
      socket.destroy();
      reject(clientSocket, 502, why);
    };
    socket.setTimeout(15000, () => fail('connect timeout'));
    socket.on('error', (err) => fail(err.message));

    socket.on(isSecure ? 'secureConnect' : 'connect', () => {
      settled = true;
      socket.write(headToRequest(req, u, headers));
      if (head && head.length) socket.write(head);
      pipe(socket, clientSocket, target);
      tunnels.add({ socket, clientSocket });
    });

    clientSocket.on('error', () => socket.destroy());
    clientSocket.on('close', () => socket.destroy());
  });

  return {
    count: () => tunnels.size,
    closeAll() {
      for (const t of tunnels) { t.socket.destroy(); t.clientSocket.destroy(); }
      tunnels.clear();
    },
  };
}

function buildHeaders(req, u, profile, tab) {
  const out = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    const lower = name.toLowerCase();
    if (!FORWARDED.has(lower)) continue;
    if (lower === 'origin' || lower === 'referer') continue;
    if (lower === 'cookie') continue;
    if (lower === 'sec-websocket-extensions' && /permessage-deflate/i.test(value)) {
      out.push([name, value]); // the target may or may not accept it; the browser tolerates both
      continue;
    }
    out.push([name, value]);
  }
  out.push(['Origin', u.origin]);
  if (tab.url) {
    try { out.push(['Referer', new URL(tab.url).origin + '/']); } catch { /* skip */ }
  }
  const cookie = profile?.jar.header((u.protocol === 'wss:' ? 'https://' : 'http://') + u.host + u.pathname, {});
  if (cookie) out.push(['Cookie', cookie]);
  return out;
}

function headToRequest(req, u, headers) {
  const target = (u.pathname || '/') + (u.search ?? '');
  const lines = [`${req.method ?? 'GET'} ${target} HTTP/1.1`];
  const hostValue = u.host;
  lines.push(`Host: ${hostValue}`);
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'host') continue;
    lines.push(`${name}: ${value}`);
  }
  return lines.join('\r\n') + '\r\n\r\n';
}

function pipe(from, to, label) {
  let idle = null;
  const bump = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => { from.destroy(); to.destroy(); }, IDLE_MS);
    idle.unref?.();
  };
  from.on('data', (chunk) => { bump(); if (!to.writableEnded) to.write(chunk); });
  to.on('data', (chunk) => { bump(); if (!from.writableEnded) from.write(chunk); });
  const end = () => { if (idle) clearTimeout(idle); from.destroy(); to.destroy(); };
  from.on('close', end);
  from.on('error', end);
  to.on('close', () => { if (idle) clearTimeout(idle); from.destroy(); });
  bump();
}

function reject(socket, status, reason) {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason.replace(/\r?\n/g, ' ')}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
  } catch { /* already gone */ }
  socket.destroy();
}

export { Buffer };
