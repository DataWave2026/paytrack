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
  assert.equal(p.payee, 'ExampleMedia LLC');
  assert.equal(p.classification, 'Loan Out');
  assert.equal(p.paid_to, 'company');
  assert.equal(p.earnings.length, 5);
  assert.deepEqual(p.earnings[0], { type: 'Straight Time', hours: 8, rate: 81.82, amount: 654.55 });
  assert.deepEqual(p.earnings[2], { type: 'OT x1.5', hours: 4, rate: 122.73, amount: 490.91 });
  const mp = p.earnings[4];
  assert.match(mp.type, /Meal Penalt/i);
  assert.equal(mp.hours, null);
  assert.equal(mp.amount, 81.82);
});

test('column-style OCR (label block then value block) pairs correctly', () => {
  const text = `WRAPBOOK
Check Date
Aug 25, 2026
Project
Work Period Start Date
Work Period End Date
Days Worked
Ritual
Aug 16, 2026
Aug 22, 2026
2
Controlling Employer
Payroll Employer
Example Pictures, 1 Studio Way, Malibu, CA
TakeOne Network Corp. DBA Wrapbook
Straight Time
8.0 hours
$81.82/hr
Gross Earnings:
Total Deductions:
Net Earnings:
$1,759.10
$0.00
$1,759.10
Total Hours Worked
17.5
Paid by Check #1001262960 on Aug 25, 2026`;
  const p = parseStub(text);
  assert.equal(p.project_name, 'Ritual');
  assert.equal(p.period_start, '2026-08-16');
  assert.equal(p.period_end, '2026-08-22');
  assert.equal(p.day_count, 2);
  assert.match(p.employer, /Example Pictures/);
  assert.equal(p.gross, 1759.10);
  assert.equal(p.net, 1759.10);
  assert.equal(p.check_date, '2026-08-25');
});

test('real photographed-stub OCR order (giant label column, missing values)', () => {
  // Structure mirrors an actual Vision/Drive OCR of a photographed Wrapbook
  // stub: ALL labels first, then values, with stray lines interleaved and
  // the "Loan Out" classification value missing entirely.
  const text = `support@wrapbook.com
1 (833) 977-2665
W WRAPBOOK
Check Date
Name
Address
Classification
Job Title
Loan Out Company
Controlling Employer
Payroll Employer
Project
Work Period Start Date
Work Period End Date
Days Worked
Earning Type
Straight Time
Straight Time
OT ×1.5
OT x2.0
Meal Penalties
Total Hours Worked
Aug 25, 2026
ExampleMedia LLC (Doe, Jane M.), XX-XXX
123 Example St, Los Angeles, CA, 90000-1111
Digital Imaging Tech
ExampleMedia LLC, 123 Example St, Los Angeles, CA, 90000-1111
FEIN#: XX-XXX
Example Pictures, 1 Studio Way, Malibu, CA, 90265
TakeOne Network Corp. DBA Wrapbook, 228 Park Ave S #36206
New York, NY, 10003-1502, FEIN#: 82-4462453
Ritual
Aug 16, 2026
Aug 22, 2026
2
Time Worked
8.0 hours
5.0 hours
4.0 hours
0.5 hours
Rate Work Location
$81.82/hr Los Angeles, CA
$90.00/hr Los Angeles, CA
$122.73/hr Los Angeles, CA
$163.64/hr Los Angeles, CA
17.5
Amount
$654.55
$450.00
$490.91
$81.82
$81.82
Gross Earnings:
Total Deductions:
Net Earnings:
Amount
$1,759.10
$0.00
$1,759.10
Payments
Primary Account:
Paid by Check #1001262960 on Aug 25, 2026
Amount
$1,759.10`;
  const p = parseStub(text);
  assert.equal(p.vendor, 'Wrapbook');
  assert.equal(p.project_name, 'Ritual');
  assert.equal(p.payee, 'ExampleMedia LLC');
  assert.equal(p.job_title, 'Digital Imaging Tech');
  assert.equal(p.classification, 'Loan Out');   // inferred from loan-out company
  assert.equal(p.employer, 'Example Pictures');
  assert.equal(p.period_start, '2026-08-16');
  assert.equal(p.period_end, '2026-08-22');
  assert.equal(p.check_date, '2026-08-25');
  assert.equal(p.day_count, 2);
  assert.equal(p.gross, 1759.10);
  assert.equal(p.earnings.length, 5);
  assert.deepEqual(p.earnings[0], { type: 'Straight Time', hours: 8, rate: 81.82, amount: 654.55 });
  assert.deepEqual(p.earnings[3], { type: 'OT x2.0', hours: 0.5, rate: 163.64, amount: 81.82 });
  assert.equal(p.earnings[4].amount, 81.82);
  assert.equal(p.earnings[4].hours, null);
});

test('Google OCR order: fused labels, merged dates, employer glued to payroll co', () => {
  const text = `________________

W WRAPBOOK
Check Date
Name
Address
Classification
Job Title
Loan Out Company
Controlling Employer
Payroll Employer
Project
Work Period Start Date
Work Period End Date Days Worked
Aug 25, 2026
1234 Example Media (Doe, Jane M.), XX-XXX
123 Example St, Los Angeles, CA, 90000-1111
Loan Out
Digital Imaging Tech
1234 ExampleMedia, 123 Example St, Los Angeles, CA, 90000-1111 FEIN#: XX-XXX
Example Pictures, 1 Studio Way, Malibu, CA, 90265 TakeOne Network Corp. DBA Wrapbook, 228 Park Ave S #36206 New York, NY, 10003-1502, FEIN#: 82-4462453
Ritual
Aug 16, 2026 Aug 22, 2026
2
support@wrapbook.com
1 (833) 977-2665
Earning Type
Time Worked
Rate Work Location
Amount
Straight Time
8.0 hours
$81.82/hr Los Angeles, CA
$654.55
Straight Time
5.0 hours
$90.00/hr Los Angeles, CA
$450.00
OT x1.5
4.0 hours
$122.73/hr Los Angeles, CA
$490.91
OT X2.0
0.5 hours $163.64/hr Los Angeles, CA
$81.82
Meal Penalties
$81.82
Total Hours Worked
17.5
Gross Earnings: Total Deductions: Net Earnings:
Amount
$1,759.10
$0.00
$1,759.10
Payments
Amount
Primary Account:
Paid by Check #1001262960 on Aug 25, 2026
$1,759.10`;
  const p = parseStub(text);
  assert.equal(p.project_name, 'Ritual');
  assert.equal(p.payee, '1234 Example Media');
  assert.equal(p.job_title, 'Digital Imaging Tech');
  assert.equal(p.classification, 'Loan Out');
  assert.equal(p.employer, 'Example Pictures');
  assert.equal(p.period_start, '2026-08-16');
  assert.equal(p.period_end, '2026-08-22');
  assert.equal(p.check_date, '2026-08-25');
  assert.equal(p.day_count, 2);
  assert.equal(p.gross, 1759.10);
  assert.equal(p.net, 1759.10);
  assert.equal(p.paid_to, 'company');
  assert.equal(p.earnings.length, 5);
  assert.deepEqual(p.earnings[3], { type: 'OT X2.0', hours: 0.5, rate: 163.64, amount: 81.82 });
});

test('controlling employer with LLC suffix is the employer, never the loan-out co', () => {
  const text = `WRAPBOOK
Check Date
Name
Address
Classification
Job Title
Loan Out Company
Controlling Employer
Payroll Employer
Project
Work Period Start Date
Work Period End Date Days Worked
Aug 20, 2026
1234 Example Media (Doe, Jane M.), XX-XXX
123 Example St, Los Angeles, CA, 90000
Loan Out
Digital Imaging Tech
1234 ExampleMedia, 123 Example St, Los Angeles, CA, 90000
Netflix Media, LLC, 1000 Example Blvd, Los Angeles, CA, 90028 TakeOne Network Corp. DBA Wrapbook, 228 Park Ave S #36206
YA Social Content Day
Aug 9, 2026 Aug 15, 2026
2
Gross Earnings:
$1,922.73
Paid by Check #10012606 on Aug 20, 2026`;
  const p = parseStub(text);
  assert.equal(p.employer, 'Netflix Media, LLC');
  assert.equal(p.payroll_employer, 'TakeOne Network Corp.');
  assert.equal(p.payee, '1234 Example Media');
  assert.equal(p.paid_to, 'company');
  assert.equal(p.project_name, 'YA Social Content Day');
  assert.equal(p.period_start, '2026-08-09');
  assert.equal(p.period_end, '2026-08-15');
});

test('kit fee / box rental lines are recognized as gear payment', async () => {
  const { gearOnStub } = await import('../js/parse.js');
  const text = `WRAPBOOK
Check Date
Aug 25, 2026
Earning Type
Straight Time
8.0 hours
$81.82/hr Los Angeles, CA
$654.55
Kit Fee
$250.00
Box Rental
$150.00
Drive Rental
$300.00
Gross Earnings:
$1,354.55`;
  const p = parseStub(text);
  const types = p.earnings.map(e => e.type.toLowerCase());
  assert.ok(types.includes('kit fee'));
  assert.ok(types.includes('box rental'));
  assert.ok(types.includes('drive rental'));
  assert.equal(gearOnStub(p.earnings), 700);
});

test('bare personal name on the stub means paid to me', () => {
  const text = `WRAPBOOK
Check Date
Aug 25, 2026
Name
Doe, Jane M., XX-XXX
Address
123 Example St, Los Angeles, CA, 90000
Project
Ritual
Work Period Start Date
Aug 16, 2026
Gross Earnings: $1,200.00`;
  const p = parseStub(text);
  assert.equal(p.payee, 'Doe, Jane M.');
  assert.equal(p.paid_to, 'me');
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
