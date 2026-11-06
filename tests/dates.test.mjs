import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, today } from '../js/store.js';

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
