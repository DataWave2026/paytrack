import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchStub, rateVariants } from '../js/match.js';

const jobs = [
  { id: 'a', project: 'Ritual', start_date: '2026-08-16', end_date: '2026-08-22',
    rate_amount: 900, rate_hours: 11, wages_status: 'unpaid' },
  { id: 'b', project: 'Solace', start_date: '2026-07-01', end_date: '2026-07-03',
    rate_amount: 955, rate_hours: 10, wages_status: 'paid' },
  { id: 'c', project: 'Cover for Matt', start_date: '2026-08-20', end_date: '2026-08-20',
    rate_amount: 700, rate_hours: 8, wages_status: 'unpaid' },
];

test('rate variants include day-rate / hours', () => {
  const v = rateVariants(900, 11);
  assert.ok(v.some(x => Math.abs(x - 81.82) < 0.5));
});

test('stub with name + dates + rate picks the right job', () => {
  const stub = {
    project_name: 'Ritual', employer: 'Example Pictures',
    period_start: '2026-08-16', period_end: '2026-08-22',
    hourly_rates: [81.82, 90, 122.73, 163.64],
  };
  const m = matchStub(stub, jobs);
  assert.equal(m[0].job.id, 'a');
  assert.ok(m[0].score >= 90, `score was ${m[0].score}`);
});

test('no project name: dates + rate still find it', () => {
  const stub = {
    project_name: '', employer: 'Some Payroll Co',
    period_start: '2026-08-17', period_end: '2026-08-21',
    hourly_rates: [81.82],
  };
  const m = matchStub(stub, jobs);
  assert.equal(m[0].job.id, 'a');
});

test('irrelevant stub matches nothing strongly', () => {
  const stub = {
    project_name: 'Totally Different Show', employer: 'Elsewhere Inc',
    period_start: '2025-01-05', period_end: '2025-01-09',
    hourly_rates: [55],
  };
  const m = matchStub(stub, jobs);
  assert.ok(m.length === 0 || m[0].score < 30);
});

test('gear-only stub matches via gear amount + dates', () => {
  const withGear = [...jobs, { id: 'g', project: 'Gear Show', start_date: '2026-08-16',
    end_date: '2026-08-22', gear_total: 1000, gear_status: 'unpaid', wages_status: 'paid' }];
  const stub = {
    project_name: '', employer: 'Some Payroll',
    period_start: '2026-08-17', period_end: '2026-08-18',
    hourly_rates: [], gear_amount: 1000,
  };
  const m = matchStub(stub, withGear);
  assert.equal(m[0].job.id, 'g');
  assert.ok(m[0].reasons.includes('gear amount matches'));
  assert.ok(m[0].score >= 70);
});

test('deleted jobs are never candidates', () => {
  const withDeleted = [...jobs, { id: 'd', project: 'Ritual', deleted: true,
    start_date: '2026-08-16', end_date: '2026-08-22', rate_amount: 900, rate_hours: 11 }];
  const m = matchStub({ project_name: 'Ritual', period_start: '2026-08-16',
    period_end: '2026-08-22', hourly_rates: [81.82] }, withDeleted);
  assert.ok(m.every(c => c.job.id !== 'd'));
});
