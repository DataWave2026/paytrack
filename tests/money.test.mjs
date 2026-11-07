import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobWages, estWages, dayPay, wageCoverage, wagesRemaining, owedFor, paidEvents,
  applyGearPayment, gearInv } from '../js/money.js';

const kit = (amt) => [{ type: 'Kit/box rental', amount: amt }];
const st = (amt, hrs = 10) => [{ type: 'Straight time', hours: hrs, rate: amt / hrs, amount: amt }];
const job = (o) => ({ id: 'j', start_date: '2026-03-02', end_date: '2026-03-06', wages_status: 'unpaid',
  gear_status: 'na', gear_total: null, rate_amount: 700, rate_hours: 10, work_dates: [], travel_dates: [], ...o });
const by = (j, stubs) => ({ [j.id]: stubs });

test('gear paid across several checks reaches paid, and owed tracks what is left', () => {
  const j = job({ gear_total: 1000, gear_status: 'unpaid', wages_status: 'paid' });
  assert.equal(applyGearPayment(j, 500, 0), 'partial');
  assert.equal(owedFor(j, by(j, [{ gross: 500, earnings: kit(500) }])).gear, 500);
  assert.equal(applyGearPayment(j, 500, 500), 'paid');
  assert.equal(owedFor(j, by(j, [{ gross: 500, earnings: kit(500) }, { gross: 500, earnings: kit(500) }])).gear, 0);
});

test('a gear check marks weekly invoices paid oldest-first; nothing is both paid and owed', () => {
  const inv = (s, e) => ({ start: s, end: e, amount: 500, status: 'sent' });
  const j = job({ gear_status: 'unpaid', gear_invoices: [inv('2026-03-02', '2026-03-08'), inv('2026-03-09', '2026-03-15'), inv('2026-03-16', '2026-03-22')] });
  applyGearPayment(j, 500);
  assert.deepEqual(j.gear_invoices.map(i => i.status), ['paid', 'sent', 'sent']);
  assert.equal(j.gear_status, 'partial');
  const stubs = [{ gross: 500, earnings: kit(500), check_date: '2026-03-20', paid_to: 'company' }];
  assert.equal(owedFor(j, by(j, stubs)).gear, 1000);
  const paid = paidEvents([j], by(j, stubs)).filter(e => e.kind === 'gear').reduce((a, e) => a + e.amt, 0);
  assert.equal(paid, 500);                       // counted once, not twice
});

test('invoices marked paid by hand still count after a gear check is added', () => {
  const inv = (s, e) => ({ start: s, end: e, amount: 500, status: 'paid' });
  const j = job({ gear_status: 'paid', gear_invoices: [inv('2026-03-02', '2026-03-08'), inv('2026-03-09', '2026-03-15'), inv('2026-03-16', '2026-03-22')] });
  const stubs = [{ gross: 500, earnings: kit(500), check_date: '2026-03-25' }];
  const paid = paidEvents([j], by(j, stubs)).filter(e => e.kind === 'gear').reduce((a, e) => a + e.amt, 0);
  assert.equal(paid, 1500);
  assert.equal(owedFor(j, by(j, stubs)).gear, 0);
});

test('weekly checks: partial until every day is covered; owed = uncovered worked days', () => {
  const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];
  const j = job({ work_dates: days, wages_status: 'partial' });
  const s1 = { gross: 2100, earnings: st(2100, 30), work_dates: days.slice(0, 3) };
  const cov = wageCoverage(j, [s1]);
  assert.equal(cov.tracked, true);
  assert.deepEqual(cov.unpaid, days.slice(3));
  assert.equal(cov.paidOnJob, 3);
  assert.equal(owedFor(j, by(j, [s1])).wages, 1400);
  assert.equal(wagesRemaining(j, [s1]), 1400);
  assert.equal(wagesRemaining({ ...j, wages_status: 'paid' }, [s1]), 0);   // manual "paid" wins
});

test('a check without recorded days makes coverage untrusted (no phantom owed)', () => {
  const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];
  const j = job({ work_dates: days, wages_status: 'paid' });
  const stubs = [{ gross: 1750, earnings: st(1750, 25) }, { gross: 1750, earnings: st(1750, 25), work_dates: days.slice(0, 2) }];
  assert.equal(wageCoverage(j, stubs).tracked, false);
  assert.equal(owedFor(j, by(j, stubs)).wages, 0);
  assert.equal(wagesRemaining(j, stubs), 0);
});

test('job with no specific days: unpaid days capped by days worked, not the calendar span', () => {
  const j = job({ start_date: '2026-03-02', end_date: '2026-03-13', days_worked: 10, wages_status: 'partial' });
  const wk1 = { gross: 3500, earnings: st(3500, 50), work_dates: ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'] };
  const cov = wageCoverage(j, [wk1]);
  assert.equal(cov.total, 10);
  assert.equal(cov.unpaid.length, 5);            // 10 worked − 5 paid, not 7 span days
  assert.equal(owedFor(j, by(j, [wk1])).wages, 3500);
});

test('travel days use the 4-hour minimum everywhere', () => {
  const days = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'];
  const j = job({ work_dates: days, days_worked: 5, travel_dates: ['2026-03-06'], wages_status: 'partial' });
  assert.equal(dayPay(j, '2026-03-06'), 280);
  assert.equal(estWages(j), 3080);
  const s1 = { gross: 1400, earnings: st(1400, 20), work_dates: days.slice(0, 2) };
  assert.equal(owedFor(j, by(j, [s1])).wages, 700 + 700 + 280);
});

test('a small non-gear line on a gear check does not erase the wage estimate', () => {
  const j = job({ days_worked: 5, gear_total: 1000, gear_status: 'unpaid' });
  const stubs = [{ gross: 1050, earnings: [{ type: 'Box rental', amount: 1000 }, { type: 'Mileage', amount: 50 }] }];
  assert.deepEqual(jobWages(j, by(j, stubs)), { amount: 50, actual: true });
  assert.equal(owedFor(j, by(j, stubs)).wages, 3450);   // estimate 3500 − 50 received
  assert.equal(owedFor(j, by(j, stubs)).gear, 0);
});

test('paid money lands in the month of the check, attributed to its payee', () => {
  const j = job({ start_date: '2026-09-28', end_date: '2026-10-02', wages_status: 'partial', paid_via: 'me' });
  const stubs = [{ gross: 2000, earnings: st(2000, 20), check_date: '2026-10-08', paid_to: 'company' }];
  assert.deepEqual(paidEvents([j], by(j, stubs)), [{ m: '2026-10', kind: 'wages', amt: 2000, via: 'company' }]);
  assert.deepEqual(paidEvents([{ ...j, job_status: 'hold' }], by(j, stubs)), []);
  assert.equal(gearInv(j), null);
});

test('owed money sits in the month the work was done, not the job start month', async () => {
  const { owedEvents } = await import('../js/money.js');
  const days = []; for (let d = 2; d <= 20; d++) days.push(`2026-10-${String(d).padStart(2, '0')}`);
  days.push('2026-11-02', '2026-11-03');
  const j = job({ start_date: '2026-10-02', end_date: '2026-11-03', work_dates: days, days_worked: days.length, wages_status: 'partial', rate_amount: 849.97 });
  const s1 = { gross: 10000, earnings: st(10000, 100), work_dates: days.slice(0, 19), check_date: '2026-10-25' };
  const ev = owedEvents([j], by(j, [s1]));
  assert.deepEqual(ev.map(e => e.m), ['2026-11', '2026-11']);
  assert.equal(ev.reduce((a, e) => a + e.amt, 0), 1699.94);
});
