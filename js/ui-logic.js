// Decision logic lifted out of the UI so it runs (and is tested) without a
// DOM: who a check is made out to, which job a stub auto-picks, how a
// multi-week job is cloned, how a day rate was derived, and which days a
// weekly check preselects.

const sqk = (x) => (x || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const nameWords = (x) => new Set((x || '').toLowerCase().match(/[a-z]{2,}/g) || []);
// Names also match by word set, so "DOE, JANE M." = "JANE DOE".
const wordsMatch = (a, b) => {
  const wa = nameWords(a), wb = nameWords(b);
  if (wa.size < 2 || wb.size < 2) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const w of small) if (!big.has(w)) return false;   // every word of the shorter name
  return true;
};
// 'company' | 'me' | '' (unknown — the UI then flags it).
export function payeeMatch(payee, companyName, personalName) {
  if (!payee) return '';
  const pv = sqk(payee), co = sqk(companyName), me = sqk(personalName);
  const hit = (x, name) => x && pv.length >= 4 && (pv.includes(x) || x.includes(pv) || wordsMatch(payee, name));
  if (pv && pv === me) return 'me';                 // exact matches first
  if (pv && pv === co) return 'company';
  const isCo = hit(co, companyName), isMe = hit(me, personalName);
  // Both match (company named after the person): an entity suffix decides.
  if (isCo && isMe) return /\b(llc|inc|corp|ltd|co|company|productions?|media)\b/i.test(payee) ? 'company' : 'me';
  if (isCo) return 'company';
  if (isMe) return 'me';
  return '';
}

// Auto-pick only a clear winner: score >= 70, >= 10 ahead of the runner-up,
// and not a tie between two same-company jobs with the same gear total.
export function autoPick(candidates, stub, isTie) {
  const top = candidates[0];
  if (!top || top.score < 70) return null;
  if (candidates[1] && top.score - candidates[1].score < 10) return null;
  if (isTie && isTie(candidates, stub)) return null;
  return top.job;
}

// Week k of a multi-week job: every date shifted by 7k days, the expected
// pay date only on week 1, calendar links cleared so each week gets its own.
export function cloneWeeks(job, weeks, uid, addDays) {
  const out = [];
  for (let k = 0; k < weeks; k++) {
    const shift = (d) => (d ? addDays(d, 7 * k) : d);
    out.push({
      ...job,
      id: k === 0 ? job.id : uid(),
      project: weeks > 1 ? `${job.project} (Week ${k + 1})` : job.project,
      start_date: shift(job.start_date),
      end_date: shift(job.end_date || job.start_date),
      work_dates: (job.work_dates || []).map(shift),
      travel_dates: (job.travel_dates || []).map(shift),
      expected_pay_date: k === 0 ? job.expected_pay_date : '',
      gear_invoices: (job.gear_invoices || []).map(i => ({ ...i, start: shift(i.start || ''), end: shift(i.end || '') })),
      calendar_event_id: '',
      calendar_event_ids: [],
    });
  }
  return out;
}

// A stored day rate that equals hourly × (8 + 1.5 × (hours − 8)) was entered
// union-style; anything else is straight time.
export function inferHourlyMode(job) {
  if (job.rate_hourly && job.rate_hours > 8 && job.rate_amount
      && Math.abs(job.rate_amount - job.rate_hourly * (8 + 1.5 * (job.rate_hours - 8))) < 1) return 'union';
  return 'straight';
}

const isWeekday = (d) => { const n = new Date(d + 'T00:00:00Z').getUTCDay(); return n !== 0 && n !== 6; };
// Days of the pay period a check for `chosen` preselects: the job's own days
// in the period that no other check paid. A whole-range job has no day list,
// so never more than the stub's day count — weekdays first.
export function preselectCoveredDays(chosen, periodDays, paid, dayCount) {
  if (!chosen) return [];
  const wd = new Set(chosen.work_dates || []);
  const end = chosen.end_date || chosen.start_date;
  const cands = periodDays.filter(d => !(paid && paid.has(d))
    && (wd.size ? wd.has(d) : (d >= chosen.start_date && d <= end)));
  if (!wd.size && dayCount && cands.length > dayCount) {
    return [...cands.filter(isWeekday), ...cands.filter(d => !isWeekday(d))].slice(0, dayCount).sort();
  }
  return cands;
}
