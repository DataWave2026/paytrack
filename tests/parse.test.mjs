import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStub, parseJobNote, looksLikeJob, jobToNote, parseDate, parseMoney } from '../js/parse.js';

const wrapbook = readFileSync(new URL('./fixtures/wrapbook-sample.txt', import.meta.url), 'utf8');

test('date and money primitives', () => {
  assert.equal(parseDate('Aug 25, 2026'), '2026-08-25');
  assert.equal(parseDate('08/25/2026'), '2026-08-25');
  assert.equal(parseDate('September 3, 2026'), '2026-09-03');
  assert.equal(parseMoney('$1,759.10'), 1759.10);
  assert.equal(parseMoney(''), null);
});

test('wrapbook stub parses', () => {
  const p = parseStub(wrapbook);
  assert.equal(p.vendor, 'Wrapbook');
  assert.equal(p.project_name, 'Ritual');
  assert.equal(p.period_start, '2026-08-16');
  assert.equal(p.period_end, '2026-08-22');
  assert.equal(p.check_date, '2026-08-25');
  assert.equal(p.check_no, '1001262960');
  assert.equal(p.gross, 1759.10);
  assert.equal(p.net, 1759.10);
  assert.equal(p.hours, 17.5);
  assert.equal(p.day_count, 2);
  assert.ok(p.hourly_rates.includes(81.82) && p.hourly_rates.includes(90));
  assert.match(p.employer, /Example Pictures/);
});

test('generic parser survives an unknown vendor', () => {
  const text = `ACME PAYROLL SERVICES
Pay Date: 09/04/2026
Pay Period: 08/24/2026 - 08/30/2026
Employee: Jane Doe
Gross Pay $2,100.00
Net Pay $1,850.55`;
  const p = parseStub(text);
  assert.equal(p.vendor, '');
  assert.equal(p.check_date, '2026-09-04');
  assert.equal(p.period_start, '2026-08-24');
  assert.equal(p.period_end, '2026-08-30');
  assert.equal(p.gross, 2100);
  assert.equal(p.net, 1850.55);
});

test('calendar note convention round-trips', () => {
  let n = parseJobNote('$955/10 paid, $1200/gear paid');
  assert.equal(n.rate_amount, 955);
  assert.equal(n.rate_hours, 10);
  assert.equal(n.wages_status, 'paid');
  assert.equal(n.gear_total, 1200);
  assert.equal(n.gear_status, 'paid');

  n = parseJobNote('Scale paid, $1000/gear not yet paid');
  assert.equal(n.rate_text, 'scale');
  assert.equal(n.wages_status, 'paid');
  assert.equal(n.gear_total, 1000);
  assert.equal(n.gear_status, 'unpaid');

  n = parseJobNote('Wages paid');
  assert.equal(n.wages_status, 'paid');
});

test('real-world note variants from the iCloud calendar', () => {
  let n = parseJobNote('$950/10 not yet paid, $1250/day gear not yet paid');
  assert.equal(n.rate_amount, 950);
  assert.equal(n.gear_rate, 1250);
  assert.equal(n.gear_total, null);
  assert.equal(n.gear_status, 'unpaid');

  n = parseJobNote('WAGES PAID, GEAR NOT YET PAID');
  assert.equal(n.wages_status, 'paid');
  assert.equal(n.gear_status, 'unpaid');

  n = parseJobNote('$87/hr 8 hr guar. paid, $650/gear paid');
  assert.equal(n.rate_text, '$87/hr');
  assert.equal(n.wages_status, 'paid');
  assert.equal(n.gear_total, 650);
  assert.equal(n.gear_status, 'paid');

  n = parseJobNote('Wrap day paid');
  assert.equal(n.wages_status, 'paid');

  n = parseJobNote('$1000/day?');
  assert.equal(n.rate_amount, 1000);
  assert.equal(n.wages_status, null);

  n = parseJobNote('Week 2 wages paid, gear not yet paid');
  assert.equal(n.wages_status, 'paid');
  assert.equal(n.gear_status, 'unpaid');
});

test('job-like event detection', () => {
  assert.ok(looksLikeJob('Solace with Mike G', '$955/10 paid, $1200/gear paid'));
  assert.ok(looksLikeJob('Hold for Batch', 'Wages paid'));
  assert.ok(looksLikeJob('cover for Matt', 'Scale paid, $1000/gear not yet paid'));
  assert.ok(looksLikeJob('Hold for data job', '$1000/day?'));
  assert.ok(looksLikeJob('Schooled WRAP', 'Wrap day paid'));
  assert.ok(!looksLikeJob('Judy duty', ''));
  assert.ok(!looksLikeJob('Amex Lululemon $75 quarterly purchase', ''));
  assert.ok(!looksLikeJob('Flight: DL 2929 from AUS to LAX', 'Confirmation Code: 75W6SJ'));
  assert.ok(!looksLikeJob('PAY CC BILLS', ''));
});

test('jobToNote renders the user style', () => {
  const note = jobToNote({
    rate_amount: 955, rate_hours: 10, wages_status: 'unpaid',
    gear_total: 1200, gear_status: 'paid',
  });
  assert.match(note, /\$955\/10 not yet paid/);
  assert.match(note, /\$1200\/gear paid/);
});
