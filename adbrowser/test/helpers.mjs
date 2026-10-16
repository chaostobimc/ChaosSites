/**
 * Shared test plumbing: an isolated server on a free port + tiny http helpers.
 * Each test file gets its own process, so nothing leaks between suites.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export async function freePort() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  srv.close();
  return port;
}

export async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'chaos-data-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(port),
      CHAOS_LOG_LEVEL: process.env.CHAOS_LOG_LEVEL ?? 'warn',
      CHAOS_FILTERS_AUTO_UPDATE: '0',
      // never write into the repo: user rules + updated lists land in a temp profile
      CHAOS_DATA_DIR: dataDir,
      CHAOS_FILTERS_FILE: join(HERE, '..', 'data', 'adblock.json.gz'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) break;
    } catch { /* not up yet */ }
    await delay(100);
    if (i === 119) throw new Error('server did not start:\n' + log);
  }
  return {
    port,
    base,
    get log() { return log; },
    dataDir,
    async close() {
      await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      child.kill('SIGTERM');
      const [code] = await once(child, 'exit').catch(() => [null]);
      return code;
    },
  };
}

export async function get(base, path, opts = {}) {
  const r = await fetch(base + path, { redirect: 'manual', ...opts });
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    status: r.status,
    headers: Object.fromEntries([...r.headers.entries()]),
    headersRaw: r.headers,
    body: buf,
    text: buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8')),
  };
}

export async function post(base, path, obj, opts = {}) {
  const { headers, ...rest } = opts;
  return get(base, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: typeof obj === 'string' ? obj : JSON.stringify(obj),
    ...rest,
  });
}

/** cookie of a brand new "browser" — one profile, stable across calls */
export async function newProfile(base) {
  const r = await fetch(base + '/api/state', { redirect: 'manual' });
  const raw = r.headers.getSetCookie?.()[0] ?? r.headers.get('set-cookie') ?? '';
  return raw.split(';')[0];
}

/** open a proxy tab for a url and return {id, proxied, prefix, realUrl} */
export async function openTab(base, url, opts = {}) {
  const r = await post(base, '/api/tab', url ? { url } : {}, opts);
  const j = r.json();
  if (r.status !== 200) throw new Error('tab failed: ' + r.text);
  return { ...j, realUrl: j.url };
}
