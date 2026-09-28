// Paystub text parsing. Input is OCR text (fuzzy!) from any payroll vendor.
// Strategy: detect a known vendor and use its template, then fill gaps with
// the generic extractor. Everything lands in a confirm/edit screen — the
// parser only pre-fills, it is never trusted blindly.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseDate(s) {
  if (!s) return '';
  s = s.trim();
  let m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);       // Aug 25, 2026
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  m = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);                   // 08/25/2026
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);                               // 2026-08-25
  if (m) return m[0];
  return '';
}

export function parseMoney(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/[,\s]/g, '').match(/\$?(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

const lines = (text) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

// Lines that are themselves field labels. Photographed stubs often OCR as a
// label column followed by a value column, so values must be paired by
// block position, not just "next line".
const LABEL_PHRASES = /(project|work\s+period\s+(start|end)\s+date|days\s+worked|controlling\s+employer|payroll\s+employer|check\s+date|name|address|classification|job\s+title|loan\s+out\s+company|earning\s+type|time\s+worked|rate|work\s+location|amount|gross\s+earnings|total\s+deductions|net\s+earnings|payments|primary\s+account|total\s+hours\s+worked|pay\s+(date|period)|employee|date|notes)/gi;

// A "label line" may be ONE label or SEVERAL fused together — Google's OCR
// merges adjacent cells ("Work Period End Date Days Worked"). A line is
// labelly when nothing remains after stripping label phrases.
const LABELY = {
  test(l) {
    if (!l) return false;
    return l.replace(LABEL_PHRASES, '').replace(/[\s:]+/g, '') === '';
  },
};

// Find "Label ... value". Layouts seen in the wild: value after the label on
// the same line; value on the next line; or a stacked label block followed by
// a stacked value block in the same order (photographed stubs OCR that way).
// Candidates are tried in layout-likelihood order against `valid`.
function labeled(ls, labelRe, valid = (v) => !!v) {
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(labelRe);
    if (!m) continue;
    const rest = ls[i].slice(m.index + m[0].length).replace(/^[:\s]+/, '').trim();
    let before = 0;
    while (i - 1 - before >= 0 && LABELY.test(ls[i - 1 - before])) before++;
    let after = 0;
    while (i + 1 + after < ls.length && LABELY.test(ls[i + 1 + after])) after++;
    const next = ls[i + 1];
    const block = ls[i + 1 + after + before];
    const stacked = after > 0 || before > 0;
    const candidates = [rest, ...(stacked ? [block, next] : [next, block])];
    for (const c of candidates) {
      if (c && !LABELY.test(c) && valid(c)) return c;
    }
    return '';
  }
  return '';
}

const isDate = (v) => !!parseDate(v);
const isMoney = (v) => parseMoney(v) !== null;

function allDates(text) {
  const found = [];
  const re = /([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})|(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/g;
  let m;
  while ((m = re.exec(text))) {
    const iso = parseDate(m[0]);
    if (iso) found.push(iso);
  }
  return found;
}

function hourlyRates(text) {
  const rates = new Set();
  const re = /\$?\s?(\d{1,4}(?:\.\d{1,2})?)\s*\/\s*(?:hr|hour)/gi;
  let m;
  while ((m = re.exec(text))) rates.add(parseFloat(m[1]));
  return [...rates].sort((a, b) => a - b);
}

export function blankParse() {
  return {
    vendor: '', project_name: '', employer: '', period_start: '', period_end: '',
    hourly_rates: [], hours: null, gross: null, net: null,
    check_no: '', check_date: '', day_count: null, earnings: [],
    payee: '', classification: '', job_title: '', payroll_employer: '',
    deductions: [], total_deductions: null, memo: '',
    paid_to: '',               // 'company' | 'me' | '' unknown
  };
}

const EARN_TYPES = /\b(straight\s+time|overtime|ot\s*[x×]?\s*[12](?:[.,]\d)?|meal\s+penalt(?:y|ies)|holiday|vacation|sick|kit\s+(?:rental|fee)|box\s+(?:rental|fee)|[a-z]+\s+rental|per\s+diem|mileage|night\s+premium|[67]th\s+day|rest\s+invasion|wardrobe|idle\s+day|travel|wrap|prep)\b/i;

// Gear money riding on a wage stub: Kit Fee, Box Rental, Equipment/Drive
// Rental etc. Returns the summed amount of those earnings lines.
export function gearOnStub(earnings) {
  return (earnings || [])
    .filter(e => /kit|box|equip|gear|rental/i.test(e.type || ''))
    .reduce((s, e) => s + (e.amount || 0), 0);
}

// Catalog the earnings table: type, hours, rate, amount per line. Handles
// row-per-line layouts AND column-style OCR (all types, then all hours, then
// all rates, then all amounts — zipped back together by position).
export function parseEarnings(text) {
  let seg = text;
  const start = text.search(/earning\s+type/i);
  if (start >= 0) {
    seg = text.slice(start);
    // Cut at gross earnings, NOT at "Total Hours Worked" — in column-style
    // OCR that label appears before the values do.
    const end = seg.search(/gross\s+earnings/i);
    if (end > 0) seg = seg.slice(0, end);
  }
  const ls = seg.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [], types = [], hoursCol = [], ratesCol = [], amountsCol = [];
  for (const l of ls) {
    if (/^(earning\s+type|time\s+worked|rate(\s+work\s+location)?|work\s+location|amount|total\s+hours(\s+worked)?)$/i.test(l)) continue;
    const t = l.match(EARN_TYPES);
    if (t) {
      const rest = l.slice(t.index + t[0].length);
      if (/\$|\d/.test(rest)) {
        // whole row on one line
        const hrs = rest.match(/([\d.]+)\s*(?:hours?|hrs?)\b/i);
        const rate = rest.match(/\$\s?([\d,.]+)\s*\/\s*(?:hr|hour)/i);
        const amts = [...rest.matchAll(/\$\s?([\d,]+\.?\d*)/g)].map(m => parseMoney(m[1]));
        entries.push({
          type: t[0].trim(), hours: hrs ? parseFloat(hrs[1]) : null,
          rate: rate ? parseMoney(rate[1]) : null,
          amount: amts.length ? amts[amts.length - 1] : null,
        });
      } else types.push(t[0].trim());
    } else if (/^([\d.]+)\s*(?:hours?|hrs?)\s+\$/.test(l)) {
      // hours and rate merged onto one line: "0.5 hours $163.64/hr …"
      const m = l.match(/^([\d.]+)\s*(?:hours?|hrs?)\s+\$\s?([\d,.]+)\s*\/\s*(?:hr|hour)\b/i);
      if (m) { hoursCol.push(parseFloat(m[1])); ratesCol.push(parseMoney(m[2])); }
    } else if (/^([\d.]+)\s*(?:hours?|hrs?)$/i.test(l)) {
      hoursCol.push(parseFloat(l));
    } else if (/^\$?\s?[\d,.]+\s*\/\s*(?:hr|hour)\b/i.test(l)) {
      // rate lines often merge with the location column ("$81.82/hr Los Angeles, CA")
      ratesCol.push(parseMoney(l));
    } else if (/^\$\s?[\d,]+\.?\d*$/.test(l)) {
      amountsCol.push(parseMoney(l));
    }
  }
  if (!entries.length && types.length) {
    types.forEach((type, i) => entries.push({
      type,
      hours: hoursCol[i] ?? null,
      rate: ratesCol[i] ?? null,
      amount: amountsCol[i] ?? null,
    }));
  }
  return entries;
}

// Deduction line items: taxes, union dues, Social Security, Medicare,
// pension/health, etc. Same tolerance as earnings: amount on the line, or a
// label column zipped against an amount column.
const DEDUCT_TYPES = /\b(federal\s+(?:income\s+)?tax|fed(?:eral)?\s+w\/?h|state\s+(?:income\s+)?tax|state\s+w\/?h|local\s+tax|social\s+security|oasdi|medicare|fica|ca\s*sdi|sdi|s\.d\.i\.?|union\s+dues|iatse|local\s+\d+\s+dues|pension|mpip[hp]?p?|health\s+(?:&|and)\s+welfare|health\s+ins(?:urance)?|dental|vision|401\(?k\)?|retirement|garnishment|vacation\s+fund|holiday\s+fund)\b/i;

export function parseDeductions(text) {
  let seg = text;
  const start = text.search(/deduction|withholding|taxes\s+withheld/i);
  if (start >= 0) {
    seg = text.slice(start);
    const end = seg.search(/net\s+(earnings|pay)|payments\b/i);
    if (end > 0) seg = seg.slice(0, end);
  }
  const ls = seg.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const entries = [], types = [], amounts = [];
  for (const l of ls) {
    const t = l.match(DEDUCT_TYPES);
    if (t) {
      const amts = [...l.matchAll(/\$?\s?([\d,]+\.\d{2})\b/g)].map(m => parseMoney(m[1]));
      if (amts.length) entries.push({ type: t[0].trim(), amount: amts[amts.length - 1] });
      else types.push(t[0].trim());
    } else if (/^\$?\s?[\d,]+\.\d{2}$/.test(l)) {
      amounts.push(parseMoney(l));
    }
  }
  if (!entries.length && types.length) {
    types.forEach((type, i) => entries.push({ type, amount: amounts[i] ?? null }));
  }
  return entries;
}

function parseGenericInto(p, text) {
  const ls = lines(text);
  if (!p.gross) p.gross = parseMoney(labeled(ls, /gross\s+(earnings|pay|wages|amount)/i, isMoney));
  if (!p.net) p.net = parseMoney(labeled(ls, /net\s+(earnings|pay|amount)/i, isMoney));
  if (!p.check_date) p.check_date = parseDate(labeled(ls, /check\s+date|pay\s+date|date\s+of\s+payment/i, isDate));
  if (!p.check_no) {
    const m = text.match(/check\s*#?\s*(\d{5,})/i);
    if (m) p.check_no = m[1];
  }
  if (!p.period_start) {
    p.period_start = parseDate(labeled(ls, /(work\s+)?period\s+(start|begin(ning)?)(\s+date)?/i, isDate));
    p.period_end = p.period_end || parseDate(labeled(ls, /(work\s+)?period\s+end(ing)?(\s+date)?/i, isDate));
  }
  if (!p.period_start) {
    const m = text.match(/period[:\s]+([^\n]+?)\s*(?:-|to|through|–)\s*([^\n]+)/i);
    if (m) { p.period_start = parseDate(m[1]); p.period_end = parseDate(m[2]); }
  }
  if (!p.period_start) {
    // Fallback: earliest/latest dates on the stub, excluding the check date.
    const ds = allDates(text).filter(d => d !== p.check_date).sort();
    if (ds.length >= 2) { p.period_start = ds[0]; p.period_end = ds[ds.length - 1]; }
    else if (ds.length === 1) { p.period_start = ds[0]; p.period_end = ds[0]; }
  }
  if (!p.hourly_rates.length) p.hourly_rates = hourlyRates(text);
  if (!p.earnings.length) p.earnings = parseEarnings(text);
  if (!p.deductions.length) p.deductions = parseDeductions(text);
  if (p.total_deductions === null) {
    p.total_deductions = parseMoney(labeled(ls, /total\s+deductions/i, isMoney));
  }
  // Invoice-style stubs bury Gross among stray lines — the earnings sum is it.
  if (p.gross === null && p.earnings.length) {
    const s = p.earnings.reduce((a, e) => a + (e.amount || 0), 0);
    if (s) p.gross = s;
  }
  if (p.hours === null) {
    const m = text.match(/total\s+hours(\s+worked)?[:\s]+(\d+(?:\.\d+)?)/i);
    if (m) p.hours = parseFloat(m[2]);
  }
  if (p.day_count === null) {
    const m = text.match(/days\s+worked[:\s]+(\d+)/i);
    if (m) p.day_count = parseInt(m[1], 10);
    else {
      const v = labeled(ls, /days\s+worked/i, x => /^\d{1,2}(\.\d+)?$/.test(x.trim()));
      if (v) p.day_count = parseInt(v, 10);
    }
  }
  if (!p.project_name) {
    p.project_name = labeled(ls, /^project(\s+name)?\b/i, projectish);
  }
  if (!p.payee) {
    p.payee = labeled(ls, /paid\s+to|payee|payable\s+to/i)
      || labeled(ls, /^employee(\s+name)?\b/i);
    p.payee = p.payee.replace(/,.*$/, '');
  }
  if (!p.employer) {
    p.employer = labeled(ls, /controlling\s+employer|production\s+company|client|employer\s+name/i)
      .replace(/,.*$/, '');
  }
  return p;
}

// Earning-type-ish text (kit/box fee, rentals, penalties…) is never a
// project title or job title, no matter where OCR drops it.
const earnyText = (l) => EARN_TYPES.test(l) || /\b(fees?|rentals?)\b/i.test(l);

// A plausible project title: not a date, not an address/FEIN line.
const projectish = (v) => !parseDate(v.slice(0, 20)) && !/\d{5}|FEIN/i.test(v) && v.split(',').length <= 2;

const isStandaloneDate = (l) =>
  /^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4})$/.test(l.trim());

// Photographed Wrapbook stubs OCR as one giant label column followed by all
// the values, with stray lines interleaved — so fields are anchored on what
// the VALUES look like, not on positions relative to labels.
function parseWrapbook(text) {
  const p = blankParse();
  p.vendor = 'Wrapbook';
  const ls = lines(text);

  const chk = text.match(/check\s*#?\s*(\d+)\s+on\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i);
  if (chk) { p.check_no = chk[1]; p.check_date = parseDate(chk[2]); }
  if (!p.check_date) p.check_date = parseDate(labeled(ls, /check\s+date/i, isDate));

  // Work period = dates on date-only lines that aren't the check date.
  // OCR can merge both period dates onto ONE line ("Aug 16, 2026 Aug 22, 2026").
  const DATE_G = /([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})|(\d{1,2}[\/-]\d{1,2}[\/-]\d{4})/g;
  const dateLines = [];
  ls.forEach((l, i) => {
    const found = [...l.matchAll(DATE_G)].map(m => parseDate(m[0])).filter(Boolean);
    if (found.length && l.replace(DATE_G, '').replace(/[\s,]+/g, '') === '') {
      dateLines.push({ i, dates: found });
    }
  });
  const period = dateLines.flatMap(x => x.dates).filter(d => d !== p.check_date).sort();
  if (period.length) {
    p.period_start = period[0];
    p.period_end = period[period.length - 1];
  }
  // Gear/invoice stubs list work dates as "Aug 15, 2026 Kit/box fee" rows —
  // a date followed by a note, with no Work Period labels at all.
  if (!p.period_start) {
    const noted = [];
    for (const l of ls) {
      const m = l.match(/^([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{4})\s+\S/);
      if (m) {
        const d = parseDate(m[1]);
        if (d && d !== p.check_date && !/\bcheck\b/i.test(l)) noted.push(d);
      }
    }
    if (noted.length) {
      noted.sort();
      p.period_start = noted[0];
      p.period_end = noted[noted.length - 1];
      if (p.day_count === null) p.day_count = noted.length;
    }
  }

  // Project: the line right before the period-start date. Days worked: the
  // small integer right after the period-end date.
  const startLine = dateLines.find(x => x.dates.includes(p.period_start) && !x.dates.every(d => d === p.check_date));
  if (startLine) {
    const prev = ls[startLine.i - 1] || '';
    if (prev && !LABELY.test(prev) && !parseDate(prev) && !earnyText(prev)) p.project_name = prev;
  }
  if (!p.project_name) {
    p.project_name = labeled(ls, /^project\b/i, projectish);
  }
  const endLine = [...dateLines].reverse().find(x => x.dates.includes(p.period_end) && !x.dates.every(d => d === p.check_date));
  if (endLine && /^\d{1,2}$/.test((ls[endLine.i + 1] || '').trim())) {
    p.day_count = parseInt(ls[endLine.i + 1], 10);
  }

  // Payee from the Name value. "Company (Last, First M.), id" = paid to the
  // company (the person is listed UNDER it); a bare personal name = paid to
  // the person directly.
  let payeeIdx = -1;
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(/^(.{2,50}?)\s*\([A-Za-z].*\)/);
    if (m && !LABELY.test(ls[i])) {
      p.payee = m[1].trim();
      p.paid_to = 'company';
      payeeIdx = i;
      break;
    }
  }
  if (!p.payee) {
    const nameVal = labeled(ls, /^name$/i, v => !parseDate(v) && !/\$/.test(v));
    const cleaned = nameVal.replace(/,\s*[Xx\d-]+\s*$/, '').trim();
    if (cleaned && !/\d|\b(llc|inc|corp|ltd|media|productions?|pictures|films?|studios?)\b/i.test(cleaned)) {
      p.payee = cleaned;
      p.paid_to = 'me';
    }
  }

  if (ls.some(l => /^loan[\s-]*out$/i.test(l.trim()))) p.classification = 'Loan Out';
  if (!p.paid_to && p.classification === 'Loan Out') p.paid_to = 'company';

  const companyAddr = (l) => {
    if (isStandaloneDate(l) || parseDate(l.slice(0, 20)) || /\bcheck\b|paid\s+by/i.test(l)) return null;
    // Company then address. "1234FilmCo, 500 …" counts (digits glued to
    // letters); "500 Main St, …" is a street address and doesn't. An entity
    // suffix may sit between the name and the address: "Acme Media, LLC, 1 …".
    return l.match(/^((?:\d+[A-Za-z]|[A-Za-z])[^,]{0,45}?(?:,?\s*(?:LLC|L\.L\.C\.?|Inc\.?|Corp\.?|Ltd\.?|Co\.))?),\s*\d/i);
  };
  const squash = (s) => (s || '').replace(/\s/g, '').toLowerCase();

  // After the name: job title is the first short no-digit line; the payee's
  // own company reappearing with an address marks a loan-out.
  if (payeeIdx >= 0) {
    let loanOutCo = '';
    let projFallback = '';
    for (let i = payeeIdx + 1; i < ls.length; i++) {
      const l = ls[i];
      if (LABELY.test(l) || parseDate(l)) continue;
      // The payee's own company reappearing with an address = loan-out company
      // (compared by name so it works for companies starting with digits).
      const pref = l.split(',')[0];
      if (l.includes(',') && squash(pref) === squash(p.payee)) { loanOutCo = pref; continue; }
      const shortText = !/[\d@]/.test(l) && !/^loan[\s-]*out$/i.test(l)
        && !earnyText(l) && l.split(/\s+/).length <= 5 && l !== p.project_name;
      if (!p.job_title && shortText) p.job_title = l;
      else if (p.job_title && !projFallback && shortText && l !== p.job_title) projFallback = l;
      if (loanOutCo && p.job_title && projFallback) break;
    }
    if (loanOutCo && !p.classification) p.classification = 'Loan Out';
    // Gear/invoice stubs park the project title far from its label — the
    // next short titled line after the job title is the best candidate.
    if (!p.project_name && projFallback) p.project_name = projFallback;
  }

  // Controlling employer: first company-with-address that isn't the payee's
  // company and isn't the payroll processor.
  for (const l of ls) {
    const ca = companyAddr(l);
    if (!ca) continue;
    // Skip only when the payroll processor is the company NAME itself — OCR
    // may merge the employer's line with the payroll company's line.
    if (/wrapbook|payroll|\bdba\b/i.test(ca[1])) {
      if (!p.payroll_employer) p.payroll_employer = ca[1].replace(/\s+DBA\b.*$/i, '').trim();
      continue;
    }
    // Never pick the payee's own (loan-out) company, even on a partial match.
    const a = squash(ca[1]), b = squash(p.payee);
    if (b && (a.includes(b) || b.includes(a))) continue;
    p.employer = ca[1].trim();
    break;
  }
  // Payroll employer: the "X DBA Wrapbook" company, wherever the OCR put it.
  if (!p.payroll_employer) {
    const dba = text.match(/([A-Za-z][A-Za-z0-9 .&-]{2,40}?)\s+DBA\b/);
    if (dba) p.payroll_employer = dba[1].trim();
  }
  parseGenericInto(p, text);
  // The generic label fallback can misfire on scrambled OCR — the employer
  // must never be the payee's own company.
  const ea = squash(p.employer), eb = squash(p.payee);
  if (ea && eb && (ea.includes(eb) || eb.includes(ea))) p.employer = '';
  return p;
}

const VENDORS = [
  { re: /wrapbook/i, fn: parseWrapbook },
  // Cast & Crew / Entertainment Partners / GreenSlate templates get added
  // here as real stubs from those vendors arrive; generic covers them until then.
  { re: /cast\s*&?\s*crew/i, fn: t => parseGenericInto({ ...blankParse(), vendor: 'Cast & Crew' }, t) },
  { re: /entertainment\s+partners|\bEP\s+payroll/i, fn: t => parseGenericInto({ ...blankParse(), vendor: 'Entertainment Partners' }, t) },
  { re: /greenslate/i, fn: t => parseGenericInto({ ...blankParse(), vendor: 'GreenSlate' }, t) },
  { re: /media\s+services/i, fn: t => parseGenericInto({ ...blankParse(), vendor: 'Media Services' }, t) },
];

// ---- Printed / e-checks (Deluxe eChecks etc.) ----
// A payment document, not an itemized stub: "PAY TO THE ORDER OF", one
// amount, a check number, a memo. Whole-check classification comes from the
// memo (equipment words = gear payment).
function looksLikeCheck(t) {
  return /pay\s+to\s+the\s+order\s+of/i.test(t)
    || (/void\s+after\s+\d+\s+days/i.test(t) && /\$?\s*[\d,]+\.\d{2}/.test(t))
    || (/\be-?check\b/i.test(t) && /memo|amount/i.test(t));
}

export function parseCheck(text) {
  const p = blankParse();
  p.vendor = 'check';
  // Junk pre-filter: photos taken over a keyboard OCR the KEYS as lines
  // ("command", "option", stray letters) — drop keyboard words and 1-2
  // character fragments before any field logic runs.
  const junky = /^(option|command|control|ctrl|shift|alt|return|enter|tab|caps\s*lock|fn|delete|del|esc|escape|home|end)(\s+[A-Za-z])?$/i;
  const ls = lines(text).filter(l => !junky.test(l) && l.replace(/[^A-Za-z0-9$*]/g, '').length > 2);
  const payIdx = ls.findIndex(l => /pay\s+to\s+the\s+order\s+of/i.test(l));
  const boiler = /^(e-?check|cheque|check|no\.?\b|date|issued|void|memo|pay\b|amount|dollars?|authorized|signature|description|invoice)/i;
  // Address lines: street words, a state+zip pair, or a phone number —
  // a bare digit-run (an account number fused onto a company line) is NOT
  // an address.
  const addressy = /\b(st|street|ave|avenue|blvd|boulevard|suite|ste|unit|rd|road|dr|drive|floor|fl)\b|\b[A-Z]{2}\s+\d{5}(-\d{4})?\b|\d{3}[-.\s]\d{3}[-.\s]\d{4}/i;
  const banky = /\b(bank|banking|n\.?a\.?|fdic|routing|account|deluxe)\b|payable\s+through/i;
  // Printed-check security boilerplate ("HOLD TO LIGHT…WATERMARK…") is never
  // a company name.
  const securityish = /waterm[au]r|security|heat\s|sensitive|hold\s+to\s+light|to\s+light\s+to|lock\b|signatures?\s+required|details?\s+on\s+back|micro\s*print|void\b|when\s+(heated|wated)/i;
  if (payIdx >= 0) {
    const tail = ls[payIdx].replace(/.*order\s+of\s*:?\s*/i, '').trim();
    // The payee is the next REAL line — skip label lines ("MEMO") that OCR
    // interleaves between the label and the name.
    let next = '';
    for (let k = payIdx + 1; k < Math.min(ls.length, payIdx + 4); k++) {
      if (boiler.test(ls[k])) continue;
      next = ls[k]; break;
    }
    p.payee = (/[A-Za-z0-9]/.test(tail) ? tail : next)
      .replace(/\s*\$\s*[\d,.]+.*$/, '').replace(/,.*$/, '').trim();
  }
  // Payer: business checks print the clean company name wherever the
  // remittance stub sits — search the WHOLE page for a company-suffix line
  // (LLC/Pictures/Media/…) that isn't the payee, the bank, an address, or
  // security boilerplate. Fall back to the block above "pay to the order of".
  const sqz = (s) => (s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const payeeSq = sqz(p.payee);
  const companyish = (l) =>
    /[A-Za-z]{3}/.test(l)
    && !boiler.test(l) && !addressy.test(l) && !banky.test(l) && !securityish.test(l)
    && !parseDate(l) && !/[\d,]+\.\d{2}/.test(l)
    && !(payeeSq && (sqz(l).includes(payeeSq) || payeeSq.includes(sqz(l))));
  const suffixy = /\b(llc|inc|ltd|corp|co|company|pictures?|productions?|media|studios?|films?|entertainment|network|group|partners)\b\.?/i;
  const topLines = ls.slice(0, payIdx > 0 ? payIdx : 6).filter(companyish);
  p.employer = (ls.filter(companyish).find(l => suffixy.test(l))
    || topLines.find(l => l.replace(/[^A-Za-z]/g, '').length >= 6)
    || '').replace(/,.*$/, '')
    // Fused account digits ("GIFTED YOUTH1163965430") are not part of a name.
    .replace(/(\D)\d{6,}.*$/, '$1').trim();
  // Amount: labeled, else the largest money figure on the page — checks
  // print it $-prefixed, asterisk-protected (******2,000.00), or bare.
  let amt = parseMoney(labeled(ls, /amount/i, isMoney));
  if (amt === null) {
    const all = [...text.matchAll(/(?:\$|\*+|^|\s)([\d,]+\.\d{2})\b/gm)]
      .map(m => parseFloat(m[1].replace(/,/g, '')));
    if (all.length) amt = Math.max(...all);
  }
  p.gross = amt; p.net = amt;
  // Check number: labeled, else a standalone 3-6 digit line (corner number).
  const num = text.match(/(?:check|cheque)\s*(?:no\.?|number|#)?\s*[:#]?\s*(\d{3,10})\b/i)
    || text.match(/\bno\.?\s*[:#]?\s*(\d{3,10})\b/i);
  if (num) p.check_no = num[1];
  if (!p.check_no) {
    const solo = ls.find(l => /^#?\d{3,6}$/.test(l.trim()));
    if (solo) p.check_no = solo.trim().replace(/^#/, '');
  }
  // Check date: the date printed NEXT TO the check number wins — the first
  // date on the page is often an invoice date on the remittance stub.
  let cdate = '';
  if (p.check_no) {
    const near = ls.find(l => l.includes(p.check_no) && allDates(l).length);
    if (near) cdate = allDates(near)[0];
  }
  p.check_date = cdate
    || parseDate(labeled(ls, /issued?|check\s+date/i, isDate))
    || allDates(text)[0] || '';
  // Memo / invoice references — often say what the check pays. The memo
  // match must NOT cross a line break: an empty MEMO box would swallow
  // whatever line OCR put next (the bank name, in the wild).
  const memoM = text.match(/memo[ \t:.,_-]*([^\n]*)/i);
  let memo = memoM ? memoM[1].trim() : '';
  if (/\b(bank|banking|n\.?a\.?|fdic)\b/i.test(memo) || /^\d[\d\s/]*$/.test(memo)) memo = '';
  // Joint payments list SEVERAL invoices on one line, interleaved with their
  // dates ("INVOICE# 09/08/2026 2629 09/14/2026 2630") — strip the dates,
  // then every remaining 3-6 digit number is an invoice.
  let invoices = [];
  const invIdx = ls.findIndex(l => /\binv(oice)?s?\b\s*#?/i.test(l));
  if (invIdx >= 0) {
    // OCR splits table cells run-to-run: the numbers can sit ON the label
    // line or on the following lines — read the label line plus the next
    // two as one zone. Dates and money figures are stripped first so
    // neither invoice dates nor amounts masquerade as invoice numbers.
    // The numbers can trail SEVERAL lines below the label (OCR emits the
    // whole remittance table column by column) — scan up to 6 lines, SKIP
    // section headers rather than stopping at them.
    const zoneLines = [ls[invIdx]];
    for (let k = invIdx + 1; k < Math.min(ls.length, invIdx + 7); k++) {
      if (/^(description|payment|date|dollars?|memo|amount)\b/i.test(ls[k])) continue;
      zoneLines.push(ls[k]);
    }
    const stripped = zoneLines.join(' ')
      .replace(/\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/g, ' ')   // dates
      .replace(/[\d,]*\.\d{2}\b/g, ' ')                   // money
      .replace(/[A-Za-z]+-[\d-]+/g, ' ')                  // job codes (CO-12345-051)
      .replace(/inv(oice)?s?\s*#?/ig, ' ');
    invoices = [...new Set([...stripped.matchAll(/\b(\d{3,6})\b/g)].map(m => m[1]))]
      .filter(n => n !== p.check_no);
  }
  // Memo gets its own field (a check has no job title) — invoice numbers
  // and any memo text, shown under Company on the confirm screen.
  p.memo = [invoices.length ? 'Inv ' + invoices.map(n => `#${n}`).join(', ') : '', memo]
    .filter(Boolean).join(' · ');
  // Whole-check classification: checks are short documents, so equipment
  // words anywhere (memo or remittance description) mean a gear payment.
  const gearish = /\b(equip\w*|gear|rental|kit|box|digitech)\b/i.test(text) || /\beq\b/i.test(memo);
  p.earnings = [{ type: gearish ? 'Equipment rental (check)' : 'Check payment',
    hours: null, rate: null, amount: p.gross }];
  return p;
}

export function parseStub(text) {
  for (const v of VENDORS) {
    if (v.re.test(text)) return v.fn(text);
  }
  // A bare check has no earnings table — a stub WITH an attached check
  // portion still parses as a full stub.
  if (looksLikeCheck(text) && !EARN_TYPES.test(text)) return parseCheck(text);
  return parseGenericInto(blankParse(), text);
}

// ---- The user's calendar-note convention ----
// e.g. "$955/10 paid, $1200/gear paid" / "Scale paid, $1000/gear not yet paid"
export function parseJobNote(note) {
  const out = { rate_amount: null, rate_hours: null, rate_text: '', gear_total: null,
    gear_rate: null, gear_period: null, wages_status: null, gear_status: null };
  if (!note) return out;

  // "$1200/gear paid", "$1250/day gear not yet paid", "$1500/wk for gear"
  const gear = note.match(/\$?\s?([\d,]+(?:\.\d{2})?)\s*(\/\s*(?:day|wk|week))?\s*(?:\/|for)?\s*\bgear\b([^,;.]*)/i);
  if (gear) {
    if (gear[2]) {
      out.gear_rate = parseMoney(gear[1]);
      out.gear_period = /w(k|eek)/i.test(gear[2]) ? 'week' : 'day';
    } else out.gear_total = parseMoney(gear[1]);
    out.gear_status = /not\s+yet|unpaid|pending|waiting/i.test(gear[3]) ? 'unpaid'
      : /paid/i.test(gear[3]) ? 'paid' : 'unpaid';
  } else {
    const bare = note.match(/\bgear\b([^,;.]*)/i);
    if (bare && /paid|not\s+yet|unpaid/i.test(bare[1])) {
      out.gear_status = /not\s+yet|unpaid/i.test(bare[1]) ? 'unpaid' : 'paid';
    }
  }
  const noteNoGear = gear ? note.replace(gear[0], '') : note;

  const rate = noteNoGear.match(/\$\s?([\d,]+(?:\.\d{2})?)\s*\/\s*(\d{1,2})\b([^,;.]*)/);
  if (rate) {
    out.rate_amount = parseMoney(rate[1]);
    out.rate_hours = parseInt(rate[2], 10);
    out.rate_text = `$${rate[1]}/${rate[2]}`;
    out.wages_status = /not\s+yet|unpaid|pending|waiting/i.test(rate[3]) ? 'unpaid'
      : /paid/i.test(rate[3]) ? 'paid' : 'unpaid';
  } else if (/scale/i.test(noteNoGear)) {
    out.rate_text = 'scale';
    const wages = noteNoGear.match(/scale([^,;.]*)/i);
    out.wages_status = wages && /not\s+yet|unpaid|pending|waiting/i.test(wages[1]) ? 'unpaid'
      : wages && /paid/i.test(wages[1]) ? 'paid' : 'unpaid';
  } else {
    // "$87/hr 8 hr guar. paid", "$1000/day?" — hourly/daily styles
    const alt = noteNoGear.match(/\$\s?([\d,]+(?:\.\d{2})?)\s*\/\s*(hr|hour|day)\b([^,;.]*)/i);
    if (alt) {
      out.rate_text = `$${alt[1]}/${alt[2].toLowerCase()}`;
      if (/day/i.test(alt[2])) out.rate_amount = parseMoney(alt[1]);
      out.wages_status = /not\s+yet|unpaid|pending|waiting/i.test(alt[3]) ? 'unpaid'
        : /paid/i.test(alt[3]) ? 'paid' : null;
    }
    if (!out.wages_status) {
      if (/wages?\s+paid/i.test(noteNoGear)) out.wages_status = 'paid';
      else if (/not\s+yet\s+paid|unpaid/i.test(noteNoGear)) out.wages_status = 'unpaid';
      else if (/\bpaid\b/i.test(noteNoGear)) out.wages_status = 'paid';
    }
  }
  return out;
}

// Does a calendar event look like one of the user's job entries?
export function looksLikeJob(summary, description) {
  const s = `${summary || ''} ${description || ''}`;
  return /\$\s?\d{2,4}(?:\.\d{2})?\s*\/\s*\d{1,2}\b/.test(s)   // $955/10
    || /\$\s?\d{2,5}\s*\/\s*(day|wk|week|hr|hour)/i.test(s)    // $1000/day, $87/hr
    || /\/\s?gear|gear\s+(paid|rental|not)/i.test(s)
    || /\bscale\s+(paid|not)/i.test(s)
    || /\bwages?\s+(paid|not|unpaid)/i.test(s)
    || /\b(wrap|shoot)\s+day\s+paid\b/i.test(s)
    // Hand-written holds have no money on them yet, but they ARE jobs —
    // they import as holds ("Hold for Netflix shoot", "Fullwell Show Hold").
    || /^\s*hold(\b|:)/i.test(summary || '')
    || /\bshow\s+hold\b|\bhold\s+for\b/i.test(summary || '');
}

// Render a job back into the user's readable note style.
export function jobToNote(job, checks = {}) {
  const parts = [];
  const w = job.wages_status === 'paid' ? 'paid'
    : job.wages_status === 'partial' ? 'partially paid' : 'not yet paid';
  const wRef = checks.wages && job.wages_status !== 'unpaid' ? ` (check #${checks.wages})` : '';
  if (job.rate_amount && job.rate_hours) parts.push(`$${job.rate_amount}/${job.rate_hours} ${w}${wRef}`);
  else if (job.rate_text) parts.push(`${job.rate_text} ${w}${wRef}`);
  else parts.push(`wages ${w}${wRef}`);
  if (job.gear_total || job.gear_status !== 'na') {
    const g = job.gear_status === 'paid' ? 'paid'
      : job.gear_status === 'partial' ? 'partially paid' : 'not yet paid';
    const gRef = checks.gear && job.gear_status !== 'unpaid' ? ` (check #${checks.gear})` : '';
    parts.push(`${job.gear_total ? '$' + job.gear_total + '/' : ''}gear ${g}${gRef}`);
  }
  return parts.join(', ') + '\n[PayTrack]';
}
