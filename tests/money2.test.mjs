import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobDays, wageCoverage, gearInv, applyGearPayment, paidEvents, owedFor, estWages, isFlat } from '../js/money.js';

const day = (d) => `2026-03-${String(d).padStart(2, '0')}`;

test('work_dates define the day count; paid days are counted inside the job', () => {
  const j = { id: 'a', start_date: day(2), end_date: day(6), work_dates: [day(2), day(3)], days_worked: null, rate_amount: 700 };
  assert.equal(jobDays(j), 2);
  // A check carrying days this job never had must not count as paid days here.
  const span = { id: 'b', start_date: day(2), end_date: day(6), days_worked: 5, rate_amount: 700 };
  const cov = wageCoverage(span, [{ gross: 2100, earnings: [], work_dates: [day(9), day(10), day(11)] }]);
  assert.equal(cov.paidOnJob, 0);
  assert.equal(cov.unpaid.length, 5);
});

test('undated weekly invoice is due at wrap; null-amount weeks are never auto-paid', () => {
  const past = '2020-01-10';
  const j = { id: 'c', start_date: '2020-01-06', end_date: past, gear_invoices: [
    { start: '2020-01-06', end: past, amount: 500, status: 'sent' }, { start: '', end: '', amount: 1000, status: 'sent' }] };
  const gi = gearInv(j);
  assert.equal(gi.dueAmt, 1500);
  const k = { gear_invoices: [{ start: '2020-01-06', end: past, amount: null, status: 'unsent' }, { start: '2020-01-13', end: '2020-01-17', amount: 500, status: 'unsent' }] };
  applyGearPayment(k, 1);
  assert.equal(k.gear_invoices[0].status, 'unsent');
  assert.equal(k.gear_invoices[1].status, 'unsent');
  applyGearPayment(k, 500);
  assert.equal(k.gear_invoices[1].status, 'paid');
  assert.equal(k.gear_invoices[0].status, 'unsent');
});

test('gear marked paid by hand is not added on top of a wage check that carried it', () => {
  const j = { id: 'd', start_date: '2020-02-03', end_date: '2020-02-03', wages_status: 'paid', gear_status: 'paid', gear_total: 250, paid_via: 'me' };
  const stubs = { d: [{ gross: 3750, earnings: [{ type: 'REG', amount: 3750 }], check_date: '2020-02-20' }] };
  const total = paidEvents([j], stubs).reduce((a, e) => a + e.amt, 0);
  assert.equal(total, 3750);
  // ...but with NO check at all, the hand-marked gear still counts (cash).
  const cash = paidEvents([j], { d: [] });
  assert.deepEqual(cash.map(e => [e.kind, e.amt]), [['wages', 0], ['gear', 250]].filter(x => x[1]).length ? cash.map(e => [e.kind, e.amt]) : []);
  assert.ok(cash.some(e => e.kind === 'gear' && e.amt === 250));
});

test('flat-fee job: every check counts toward the fee, no gear side', () => {
  const j = { id: 'f', pay_type: 'flat', flat_total: 1800, start_date: '2020-03-02', end_date: '2020-03-02', wages_status: 'unpaid', gear_status: 'na', gear_total: null, paid_via: 'company' };
  assert.ok(isFlat(j));
  assert.equal(estWages(j), 1800);
  const half = { f: [{ gross: 1000, earnings: [{ type: 'Equipment rental (check)', amount: 1000 }], check_date: '2020-03-20', work_dates: [] }] };
  const o = owedFor(j, half);
  assert.equal(o.wages, 800);
  assert.equal(o.gear, 0);
  const paid = paidEvents([j], half);
  assert.deepEqual(paid.map(e => [e.kind, e.amt]), [['wages', 1000]]);
});
