import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, today, earliestNagDay } from '../js/store.js';

test('addDays is correct in any timezone and never throws', () => {
  for (const tz of ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'UTC']) {
    process.env.TZ = tz;
    assert.equal(addDays('2026-11-05', 1), '2026-11-06', tz);
    assert.equal(addDays('2026-11-05', 0), '2026-11-05', tz);
    assert.equal(addDays('2026-11-01', -1), '2026-10-31', tz);
    assert.equal(addDays('2026-03-08', 1), '2026-03-09', tz);   // DST start
    assert.equal(addDays('2026-12-31', 1), '2027-01-01', tz);
  }
  assert.equal(addDays('11/5/2026', 1), '11/5/2026');           // bad input returned, not thrown
  assert.equal(addDays('2026-11-05T09:00:00', 1), '2026-11-06');
});

test('today is the LOCAL calendar date', () => {
  process.env.TZ = 'America/Los_Angeles';
  const d = new Date();
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(today(), local);
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('earliestNagDay: today only while the 08:45 alert can still fire', () => {
  process.env.TZ = 'America/Los_Angeles';
  const at = (h, m) => { const d = new Date(2026, 10, 14, h, m, 0); return earliestNagDay(d); };
  assert.equal(at(0, 5), '2026-11-14');
  assert.equal(at(7, 59), '2026-11-14');
  assert.equal(at(8, 30), '2026-11-14');
  assert.equal(at(8, 44), '2026-11-14');
  assert.equal(at(8, 45), '2026-11-15');
  assert.equal(at(8, 54), '2026-11-15');
  assert.equal(at(9, 10), '2026-11-15');
  assert.equal(at(23, 59), '2026-11-15');
  assert.equal(earliestNagDay(new Date(2026, 11, 31, 12, 0)), '2027-01-01');
});
