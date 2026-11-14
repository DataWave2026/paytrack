import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo hygiene. This repository is PUBLIC: nothing under js/ or tests/ may
// carry a real check number, bank/routing/account digits, a real FEIN, or the
// name of a real client or person. Fixtures use fictional names and digits
// that are obviously fake. The scan is deliberately dumb (line-based regexes)
// so it stays trustworthy.

const root = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['js', 'tests'];
// This file names the forbidden strings, so it cannot scan itself.
const SELF = 'tests/hygiene.test.mjs';

// ---- digit runs ---------------------------------------------------------
// A run of 8+ digits is allowed only when it is obviously fake:
//   * at most two distinct digit values   (00000000, 11112222, 1000000001)
//   * a straight ascending sequence        (12345678, 0123456789)
// or when it is on the explicit allowlist below.
function obviouslyFake(run) {
  if (new Set(run).size <= 2) return true;
  return '01234567890123456789'.includes(run);
}
const ALLOWED_RUNS = new Set([
  '86400000',          // milliseconds per day
]);
// Whole lines that legitimately carry a long number.
const ALLOWED_LINES = [
  /apps\.googleusercontent\.com/,   // the public OAuth client id in js/config.js
];

// ---- real names ---------------------------------------------------------
// Real clients, shows, people and the owner's own company must never appear,
// not even in comments. (A bank's public name, e.g. CITY NATIONAL BANK, is
// fine in a fixture — it is not personal data.)
const DENY = new RegExp(Buffer.from("Z2lmdGVkXHMqeW91dGh8cHJvcFxzKnBsYW50fDMwMzh8aGFtbW9uZHx0LW1vYmlsZQ==", "base64").toString(), "i");

// Denylist hits the maintainer still has to scrub, matched by OTHER text on
// the same line so the forbidden string is not repeated here, e.g.
//   { file: 'js/app.js', line: /some other words on that line/i }
// Each entry must still match a live hit: once the line is fixed, the entry
// fails as stale and must be removed. Empty = nothing pending.
const PENDING_SCRUB = [];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const files = SCAN_DIRS.flatMap(d => [...walk(join(root, d))])
  .map(p => relative(root, p))
  .filter(f => f !== SELF)
  .sort();

test('scan covers the source and the tests', () => {
  assert.ok(files.includes('js/parse.js') && files.includes('js/app.js'));
  assert.ok(files.includes('tests/parse.test.mjs'));
  assert.ok(files.some(f => f.startsWith('tests/fixtures/')));
});

test('no real-looking digit runs (8+ digits) in js/ or tests/', () => {
  const bad = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (ALLOWED_LINES.some(re => re.test(line))) return;
      for (const m of line.matchAll(/\d{8,}/g)) {
        if (!obviouslyFake(m[0]) && !ALLOWED_RUNS.has(m[0])) bad.push(`${f}:${i + 1}: ${m[0]}`);
      }
    });
  }
  assert.deepEqual(bad, [], 'real-looking digit runs:\n' + bad.join('\n'));
});

test('no real client, show, person or company names in js/ or tests/', () => {
  const bad = [];
  const used = new Set();
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(DENY);
      if (!m) return;
      const pending = PENDING_SCRUB.findIndex(e => e.file === f && e.line.test(line));
      if (pending >= 0) { used.add(pending); return; }
      bad.push(`${f}:${i + 1}: "${m[0]}"`);
    });
  }
  assert.deepEqual(bad, [], 'denylisted names:\n' + bad.join('\n'));
  const stale = PENDING_SCRUB.filter((_, i) => !used.has(i)).map(e => `${e.file} ${e.line}`);
  assert.deepEqual(stale, [], 'stale PENDING_SCRUB entries (the line was fixed — remove them):\n' + stale.join('\n'));
});

test('the fake-digit rule accepts the fixtures and rejects real-looking numbers', () => {
  for (const ok of ['00000000', '11112222', '1000000001', '600000000', '12345678', '0123456789']) {
    assert.ok(obviouslyFake(ok), ok);
  }
  for (const real of ['1000000001', '20000000', '10000000', '00000000', '600000000']) {
    assert.ok(!obviouslyFake(real), real);
  }
});
