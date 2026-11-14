import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchStub, rateVariants, isTie } from '../js/match.js';

const jobs = [
  { id: 'a', project: 'Riverton', start_date: '2026-08-16', end_date: '2026-08-22',
    rate_amount: 900, rate_hours: 11, wages_status: 'unpaid' },
  { id: 'b', project: 'Seaside', start_date: '2026-07-01', end_date: '2026-07-03',
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
    project_name: 'Riverton', employer: 'Example Pictures',
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

test('hourly-quoted job matches the stub hourly directly', () => {
  const hourly = [...jobs, { id: 'h', project: 'Hourly Gig', start_date: '2026-09-01',
    end_date: '2026-09-02', rate_amount: 1740, rate_hours: 20, rate_hourly: 87,
    wages_status: 'unpaid' }];
  const stub = {
    project_name: '', employer: 'Some Payroll Co',
    period_start: '2026-09-01', period_end: '2026-09-02',
    hourly_rates: [87],
  };
  const m = matchStub(stub, hourly);
  assert.equal(m[0].job.id, 'h');
  assert.ok(m[0].reasons.includes('rate matches'));
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

test('gear check dated after worked days still auto-matches by exact name', () => {
  // Job trimmed to actual worked days (Aug 9–13); gear check period Aug 15.
  const withJob = [...jobs, { id: 'ya', project: 'Brand Social Day',
    start_date: '2026-08-09', end_date: '2026-08-13', wages_status: 'paid',
    gear_total: null, gear_status: 'unpaid' }];
  const stub = {
    project_name: 'Brand Social Day', employer: 'Streamline Media, LLC',
    period_start: '2026-08-15', period_end: '2026-08-15',
    hourly_rates: [], gear_amount: 2400,
  };
  const m = matchStub(stub, withJob);
  assert.equal(m[0].job.id, 'ya');
  assert.ok(m[0].score >= 70, `score was ${m[0].score}`);   // auto-select bar
});

test('deleted jobs are never candidates', () => {
  const withDeleted = [...jobs, { id: 'd', project: 'Riverton', deleted: true,
    start_date: '2026-08-16', end_date: '2026-08-22', rate_amount: 900, rate_hours: 11 }];
  const m = matchStub({ project_name: 'Riverton', period_start: '2026-08-16',
    period_end: '2026-08-22', hourly_rates: [81.82] }, withDeleted);
  assert.ok(m.every(c => c.job.id !== 'd'));
});

test('a bare check matches by company + date window + gear amount', () => {
  const withGear = [...jobs, { id: 'chk', project: 'Night Shoot', company: 'Streamline Media LLC',
    start_date: '2026-08-25', end_date: '2026-08-26', gear_total: 1000,
    gear_status: 'unpaid', wages_status: 'paid' }];
  // A check has NO work period — only an issue date, the payer company at
  // the top, and an amount.
  const stub = { project_name: '', employer: 'Streamline Media LLC', job_title: 'memo: EQ rental',
    period_start: '', period_end: '', check_date: '2026-09-20',
    hourly_rates: [], gear_amount: 1000 };
  const m = matchStub(stub, withGear);
  assert.equal(m[0].job.id, 'chk');
  assert.ok(m[0].score >= 70, `score was ${m[0].score} (needs >= 70 to auto-preselect)`);
});

test('a check far outside payment terms does not date-match', () => {
  const withGear = [{ id: 'old', project: 'Old Show', company: 'Streamline Media LLC',
    start_date: '2026-01-05', end_date: '2026-01-06', gear_total: 500,
    gear_status: 'paid', wages_status: 'paid' }];
  const stub = { project_name: '', employer: 'Other Co', job_title: '',
    period_start: '', check_date: '2026-09-20', hourly_rates: [], gear_amount: 999 };
  const m = matchStub(stub, withGear);
  assert.ok(m.length === 0 || m[0].score < 30);
});

test('show title matches a job logged by its acronym', async () => {
  const { acronym } = await import('../js/match.js');
  assert.equal(acronym('AGE OF ATTRACTION - SEASON 2'), 'aoa2');
  const js = [{ id: 'a', project: 'AoA2', start_date: '2026-12-01', end_date: '2026-12-02' },
    { id: 'b', project: 'Other Show', start_date: '2026-12-01', end_date: '2026-12-02' }];
  const m = matchStub({ project_name: 'AGE OF ATTRACTION - SEASON 2',
    period_start: '2026-12-01', period_end: '2026-12-02', hourly_rates: [] }, js);
  assert.equal(m[0].job.id, 'a');
  assert.ok(m[0].reasons.includes('name matches'));
});

// ---- audit regressions ----
test('the job a pay period mostly falls in beats its neighbour', () => {
  const js = [{ id: 'r1', project: 'Riverton', start_date: '2026-09-14', end_date: '2026-09-27' },
    { id: 'r2', project: 'Riverton (part 2)', start_date: '2026-09-28', end_date: '2026-10-02' }];
  const m = matchStub({ project_name: 'Riverton', period_start: '2026-09-27', period_end: '2026-10-03', hourly_rates: [] }, js);
  assert.equal(m[0].job.id, 'r2');
});

test('short acronyms and tiny names do not create confident matches', () => {
  const js = [{ id: 'x', project: 'Top Chef', start_date: '2026-09-20', end_date: '2026-09-26' },
    { id: 'y', project: 'El', start_date: '2026-09-20', end_date: '2026-09-26' }];
  const m = matchStub({ project_name: 'THE OTHER PROJECT', period_start: '2026-09-20', period_end: '2026-09-26', hourly_rates: [] }, js);
  assert.ok(m.every(c => c.score < 70), JSON.stringify(m.map(c => [c.job.project, c.score])));
  const n = matchStub({ project_name: 'Next Level Chef', period_start: '2026-09-20', period_end: '2026-09-26', hourly_rates: [] }, js);
  assert.ok(n.find(c => c.job.id === 'y').score < 70);
});

// C2: a late gear check from a repeat client must not be handed to the most
// recent job on the company name alone — two same-company jobs with the
// same unpaid gear total are a tie the user breaks.
const repeatClient = [
  { id: 'A', project: 'Summer Spot', company: 'Bright Future LLC', start_date: '2026-07-20',
    end_date: '2026-07-24', gear_total: 1000, gear_status: 'unpaid', wages_status: 'paid' },
  { id: 'B', project: 'Fall Spot', company: 'Bright Future LLC', start_date: '2026-09-14',
    end_date: '2026-09-18', gear_total: 1000, gear_status: 'unpaid', wages_status: 'paid' },
];
const lateGearCheck = { project_name: '', employer: 'BRIGHT FUTURE, LLC', job_title: '', memo: 'Inv #2629',
  period_start: '', period_end: '', check_date: '2026-09-22', hourly_rates: [], gear_amount: 1000 };

test('bare check: company name alone scores at most 25', () => {
  const m = matchStub(lateGearCheck, repeatClient);
  for (const c of m) assert.ok(c.parts.n <= 25, `${c.job.id} name score ${c.parts.n}`);
  // Both jobs are still plausible candidates (name + gear amount + dates).
  assert.equal(m.length, 2);
});

test('bare check from a repeat client: recent job gets no decisive lead', () => {
  const m = matchStub(lateGearCheck, repeatClient);
  const a = m.find(c => c.job.id === 'A'), b = m.find(c => c.job.id === 'B');
  assert.ok(a && b);
  assert.ok(b.score - a.score < 10, `B ${b.score} vs A ${a.score}`);   // app treats <10 as a tie
  assert.ok(isTie(m), 'top two are the same company with the same gear total');
  assert.ok(isTie(m, lateGearCheck));                                   // amount-based variant
});

test('isTie is false when the company or the gear total differs', () => {
  const otherCo = repeatClient.map(j => j.id === 'A' ? { ...j, company: 'Other Pictures Inc' } : j);
  assert.equal(isTie(matchStub(lateGearCheck, otherCo)), false);
  const otherGear = repeatClient.map(j => j.id === 'A' ? { ...j, gear_total: 1500 } : j);
  assert.equal(isTie(matchStub(lateGearCheck, otherGear)), false);
  assert.equal(isTie([]), false);
  assert.equal(isTie(matchStub(lateGearCheck, repeatClient.slice(1))), false);   // one candidate
});

// C14: entity suffixes never decide a name match.
test('company names match exactly regardless of LLC / comma / case', () => {
  const js = [{ id: 'bf', project: 'Fall Spot', company: 'Bright Future LLC',
    start_date: '2026-09-14', end_date: '2026-09-18', gear_total: 1000, gear_status: 'unpaid' }];
  const withPeriod = { project_name: '', period_start: '2026-09-14', period_end: '2026-09-18', hourly_rates: [] };
  assert.equal(matchStub({ ...withPeriod, employer: 'BRIGHT FUTURE, LLC' }, js)[0].parts.n, 40);
  assert.equal(matchStub({ ...withPeriod, employer: 'Bright Future LLC' }, js)[0].parts.n, 40);
  assert.equal(matchStub({ ...withPeriod, employer: 'BRIGHT FUTURE' }, js)[0].parts.n, 40);   // parser trims after the comma
  assert.equal(matchStub({ ...withPeriod, employer: 'Bright Future, Inc.' }, js)[0].parts.n, 40);
  // A different company with the same suffix is still different.
  assert.ok(matchStub({ ...withPeriod, employer: 'Dark Past LLC' }, js)[0].parts.n < 25);
});
