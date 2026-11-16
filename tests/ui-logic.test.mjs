import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payeeMatch, autoPick, cloneWeeks, inferHourlyMode, preselectCoveredDays } from '../js/ui-logic.js';
import { addDays } from '../js/store.js';

test('payeeMatch: exact, containment, word set, both-match suffix rule, unknown', () => {
  assert.equal(payeeMatch('Example Media Co', 'Example Media Co', 'Jane Doe'), 'company');
  assert.equal(payeeMatch('JANE DOE', 'Example Media Co', 'Jane Doe'), 'me');
  assert.equal(payeeMatch('DOE, JANE M.', 'Example Media Co', 'Jane Doe'), 'me');
  assert.equal(payeeMatch('EXAMPLE MEDIA CO LLC', 'Example Media Co', 'Jane Doe'), 'company');
  assert.equal(payeeMatch('Jane Doe Productions LLC', 'Jane Doe Productions', 'Jane Doe'), 'company');
  assert.equal(payeeMatch('Jane Doe', 'Jane Doe Productions', 'Jane Doe'), 'me');
  assert.equal(payeeMatch('Somebody Else', 'Example Media Co', 'Jane Doe'), '');
  assert.equal(payeeMatch('Somebody Else', '', ''), '');
});

test('autoPick: clear winner only', () => {
  const a = { job: { id: 'a' }, score: 90 }, b = { job: { id: 'b' }, score: 75 }, c = { job: { id: 'c' }, score: 85 };
  assert.equal(autoPick([a, b], {}, () => false), a.job);
  assert.equal(autoPick([a, c], {}, () => false), null);         // lead < 10
  assert.equal(autoPick([{ job: { id: 'x' }, score: 60 }], {}, () => false), null);
  assert.equal(autoPick([a, b], {}, () => true), null);          // same-company tie
  assert.equal(autoPick([], {}, () => false), null);
});

test('cloneWeeks shifts every date by 7 days per week and clears links', () => {
  const job = { id: 'j', project: 'Show', start_date: '2026-03-02', end_date: '2026-03-06', work_dates: ['2026-03-02', '2026-03-03'],
    travel_dates: ['2026-03-02'], expected_pay_date: '2026-03-20', gear_invoices: [{ start: '2026-03-02', end: '2026-03-06', amount: 500, status: 'unsent' }],
    calendar_event_id: 'old', calendar_event_ids: ['x'] };
  let n = 0;
  const out = cloneWeeks(job, 3, () => 'new' + (++n), addDays);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'j'); assert.equal(out[1].id, 'new1');
  assert.equal(out[1].project, 'Show (Week 2)');
  assert.equal(out[2].start_date, '2026-03-16'); assert.equal(out[2].end_date, '2026-03-20');
  assert.deepEqual(out[1].work_dates, ['2026-03-09', '2026-03-10']);
  assert.deepEqual(out[1].travel_dates, ['2026-03-09']);
  assert.equal(out[1].expected_pay_date, ''); assert.equal(out[0].expected_pay_date, '2026-03-20');
  assert.equal(out[2].gear_invoices[0].start, '2026-03-16');
  assert.equal(out[1].calendar_event_id, ''); assert.deepEqual(out[1].calendar_event_ids, []);
  assert.equal(cloneWeeks(job, 1, () => 'z', addDays)[0].project, 'Show');
});

test('inferHourlyMode recognises union-style day rates', () => {
  assert.equal(inferHourlyMode({ rate_hourly: 50, rate_hours: 10, rate_amount: 550 }), 'union');   // 8 + 3 paid hours
  assert.equal(inferHourlyMode({ rate_hourly: 50, rate_hours: 10, rate_amount: 500 }), 'straight');
  assert.equal(inferHourlyMode({ rate_hourly: null, rate_hours: 10, rate_amount: 500 }), 'straight');
});

test('preselectCoveredDays: whole-range job capped at the stub day count, weekdays first', () => {
  const period = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'];
  const span = { start_date: '2026-03-02', end_date: '2026-03-13', work_dates: [] };
  assert.deepEqual(preselectCoveredDays(span, period, new Set(), 5), period.slice(0, 5));
  assert.deepEqual(preselectCoveredDays(span, period, new Set(['2026-03-02']), 5), period.slice(1, 6));
  // explicit day list: exactly those days, paid ones excluded, no cap
  const listed = { start_date: '2026-03-02', end_date: '2026-03-13', work_dates: ['2026-03-03', '2026-03-07'] };
  assert.deepEqual(preselectCoveredDays(listed, period, new Set(), 1), ['2026-03-03', '2026-03-07']);
  assert.deepEqual(preselectCoveredDays(null, period, new Set(), 5), []);
});
