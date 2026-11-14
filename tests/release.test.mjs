import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Release invariants: a version bump touches js/app.js AND sw.js together, and
// the offline shell lists every file the app needs (one missing file and the
// new service worker never installs, so long-lived tabs stop self-updating).
const root = fileURLToPath(new URL('..', import.meta.url));
const sw = fs.readFileSync(root + 'sw.js', 'utf8');
const app = fs.readFileSync(root + 'js/app.js', 'utf8');

test('sw.js CACHE version matches APP_VERSION', () => {
  const cache = sw.match(/CACHE = 'paytrack-(v\d+)'/);
  const ver = app.match(/APP_VERSION = '(v\d+)'/);
  assert.ok(cache && ver, 'version markers present');
  assert.equal(cache[1], ver[1]);
});

test('every SHELL entry exists and every js module is in SHELL', () => {
  const shellSrc = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const shell = [...shellSrc.matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(shell.includes('index.html'));
  for (const p of shell) if (p !== '.') assert.ok(fs.existsSync(root + p), `SHELL file missing on disk: ${p}`);
  for (const f of fs.readdirSync(root + 'js')) {
    if (f.endsWith('.js')) assert.ok(shell.includes('js/' + f), `js/${f} not in SHELL`);
  }
});
