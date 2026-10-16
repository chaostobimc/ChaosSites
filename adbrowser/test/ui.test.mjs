/**
 * The chrome: no browser needed, but these are the invariants that decide whether the user sees a
 * page or an empty dark rectangle. Both tests below correspond to bugs that were actually shipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ui = (f) => readFileSync(fileURLToPath(new URL('../src/ui/' + f, import.meta.url)), 'utf8');
const indexHtml = ui('index.html');
const appCss = ui('app.css');
const appJs = ui('app.js');
const startHtml = ui('start.html');

test('a [hidden] layer with its own display rule cannot stay painted over the page', () => {
  const guard = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(appCss);
  const hiddenIds = [...indexHtml.matchAll(/<(?:div|section|aside)[^>]*\bid="([\w-]+)"[^>]*\bhidden\b/g)].map((m) => m[1]);
  assert.ok(hiddenIds.length >= 2, 'expected the overlay layers to exist: ' + hiddenIds.join(','));
  const dangerous = [];
  for (const id of hiddenIds) {
    const rule = appCss.match(new RegExp('#' + id + '\\s*\\{([^}]*)\\}'));
    if (rule && /display:\s*(?!none)/.test(rule[1])) dangerous.push(id);
  }
  // #empty is position:absolute;inset:0 with a dark background — if it ever beats [hidden], every
  // tab is covered by it forever and "searching shows a black page".
  assert.ok(dangerous.length === 0 || guard,
    `layers [${dangerous.join(',')}] set display but rely on the hidden attribute → need a [hidden]!important guard`);
});

test('every element the chrome queries exists in the markup it ships', () => {
  // A typo in a selector is a silent failure in the browser: no error page, no toast, nothing.
  const ids = new Set([...(indexHtml + startHtml + appJs).matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
  const wanted = [...appJs.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length > 15, 'selector scan found ' + wanted.length + ' ids');
  const missing = [...new Set(wanted)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'app.js queries ids that no markup defines: ' + missing.join(', '));
});

test('a frame is revealed even when the page never fires load', () => {
  assert.match(appJs, /state\.loading\.add\(tab\.id\)/);
  assert.match(appJs, /revealT = setTimeout\(\(\) => frame\.classList\.add\('on'\)/,
    'without a reveal timer a slow page keeps the tab black');
  assert.match(appJs, /stallT = setTimeout\(\(\) => showStall\(tab\)/);
  assert.match(appJs, /settleFrame\(tab\)/);
  assert.match(appJs, /showEmpty\(false\)/, 'newTab must drop the "kein Tab" layer');
});

test('navigation and api failures reach the user instead of dying in a promise', () => {
  assert.match(appJs, /toast\('Adresse konnte nicht aufgelöst werden/);
  assert.match(appJs, /toast\('Tab konnte nicht geöffnet werden/);
});
