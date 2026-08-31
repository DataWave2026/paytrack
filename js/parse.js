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

// Find "Label ... value": value on same line after the label, else next line.
function labeled(ls, labelRe) {
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(labelRe);
    if (m) {
      const rest = ls[i].slice(m.index + m[0].length).replace(/^[:\s]+/, '').trim();
      if (rest) return rest;
      if (ls[i + 1]) return ls[i + 1];
    }
  }
  return '';
}

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
    check_no: '', check_date: '', day_count: null,
  };
}

function parseGenericInto(p, text) {
  const ls = lines(text);
  if (!p.gross) p.gross = parseMoney(labeled(ls, /gross\s+(earnings|pay|wages|amount)/i));
  if (!p.net) p.net = parseMoney(labeled(ls, /net\s+(earnings|pay|amount)/i));
  if (!p.check_date) p.check_date = parseDate(labeled(ls, /check\s+date|pay\s+date|date\s+of\s+payment/i));
  if (!p.check_no) {
    const m = text.match(/check\s*#?\s*(\d{5,})/i);
    if (m) p.check_no = m[1];
  }
  if (!p.period_start) {
    p.period_start = parseDate(labeled(ls, /(work\s+)?period\s+(start|begin(ning)?)(\s+date)?/i));
    p.period_end = p.period_end || parseDate(labeled(ls, /(work\s+)?period\s+end(ing)?(\s+date)?/i));
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
  if (p.hours === null) {
    const m = text.match(/total\s+hours(\s+worked)?[:\s]+(\d+(?:\.\d+)?)/i);
    if (m) p.hours = parseFloat(m[2]);
  }
  if (p.day_count === null) {
    const m = text.match(/days\s+worked[:\s]+(\d+)/i);
    if (m) p.day_count = parseInt(m[1], 10);
  }
  if (!p.project_name) p.project_name = labeled(ls, /^project(\s+name)?\b/i);
  if (!p.employer) {
    p.employer = labeled(ls, /controlling\s+employer|production\s+company|client|employer\s+name/i)
      .replace(/,.*$/, '');
  }
  return p;
}

function parseWrapbook(text) {
  const p = blankParse();
  p.vendor = 'Wrapbook';
  const ls = lines(text);
  p.project_name = labeled(ls, /^project\b/i);
  p.period_start = parseDate(labeled(ls, /work\s+period\s+start\s+date/i));
  p.period_end = parseDate(labeled(ls, /work\s+period\s+end\s+date/i));
  p.check_date = parseDate(labeled(ls, /check\s+date/i));
  p.employer = labeled(ls, /controlling\s+employer/i).replace(/,.*$/, '');
  const chk = text.match(/check\s*#\s*(\d+)\s+on\s+([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i);
  if (chk) { p.check_no = chk[1]; if (!p.check_date) p.check_date = parseDate(chk[2]); }
  return parseGenericInto(p, text);
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

export function parseStub(text) {
  for (const v of VENDORS) {
    if (v.re.test(text)) return v.fn(text);
  }
  return parseGenericInto(blankParse(), text);
}

// ---- The user's calendar-note convention ----
// e.g. "$955/10 paid, $1200/gear paid" / "Scale paid, $1000/gear not yet paid"
export function parseJobNote(note) {
  const out = { rate_amount: null, rate_hours: null, rate_text: '', gear_total: null,
    gear_rate: null, wages_status: null, gear_status: null };
  if (!note) return out;

  // "$1200/gear paid", "$1250/day gear not yet paid", "gear not yet paid"
  const gear = note.match(/\$?\s?([\d,]+(?:\.\d{2})?)\s*(\/\s*(?:day|wk|week))?\s*(?:\/|for)?\s*\bgear\b([^,;.]*)/i);
  if (gear) {
    if (gear[2]) out.gear_rate = parseMoney(gear[1]);
    else out.gear_total = parseMoney(gear[1]);
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
    || /\b(wrap|shoot)\s+day\s+paid\b/i.test(s);
}

// Render a job back into the user's readable note style.
export function jobToNote(job) {
  const parts = [];
  const w = job.wages_status === 'paid' ? 'paid'
    : job.wages_status === 'partial' ? 'partially paid' : 'not yet paid';
  if (job.rate_amount && job.rate_hours) parts.push(`$${job.rate_amount}/${job.rate_hours} ${w}`);
  else if (job.rate_text) parts.push(`${job.rate_text} ${w}`);
  else parts.push(`wages ${w}`);
  if (job.gear_total || job.gear_status !== 'na') {
    const g = job.gear_status === 'paid' ? 'paid'
      : job.gear_status === 'partial' ? 'partially paid' : 'not yet paid';
    parts.push(`${job.gear_total ? '$' + job.gear_total + '/' : ''}gear ${g}`);
  }
  return parts.join(', ') + '\n[PayTrack]';
}
