// Every paid / owed / estimated figure the app shows is computed here, in
// one place, so the Home cards, Year totals, Jobs subtotals, the per-job
// Breakdown and the Owed screen can never disagree. Pure functions — no DOM.
import { today, addDays } from './store.js';
import { gearOnStub } from './parse.js';

const round2 = (n) => Math.round(n * 100) / 100;
const stubsOf = (job, stubsByJob) => stubsByJob[job.id] || [];
const wagePart = (s) => Math.max(0, (s.gross || 0) - gearOnStub(s.earnings));

export function jobDays(job) {
  if (job.days_worked) return job.days_worked;
  if (!job.start_date) return 1;
  const d = Math.round((new Date(job.end_date || job.start_date) - new Date(job.start_date)) / 86400000) + 1;
  return Math.max(1, d);
}

// Money is only OWED once the work has happened — a future-dated job's
// unpaid amounts don't count until its last day has passed.
export function isWrapped(j) {
  const d = j.end_date || j.start_date;
  return !d || d <= today();
}

// Estimated pay for ONE day: the day rate, or the 4-hour minimum on a travel day.
export function dayPay(job, d) {
  if (!job.rate_amount) return 0;
  if ((job.travel_dates || []).includes(d)) {
    const hourly = job.rate_hourly || job.rate_amount / (job.rate_hours || 10);
    return round2(hourly * 4);
  }
  return job.rate_amount;
}

// Estimated wages for the whole job (null when no day rate is known).
export function estWages(job) {
  if (!job.rate_amount) return null;
  const travel = Math.min((job.travel_dates || []).length, jobDays(job));
  const full = jobDays(job) - travel;
  const hourly = job.rate_hourly || job.rate_amount / (job.rate_hours || 10);
  return round2(job.rate_amount * full + hourly * 4 * travel);
}

// Wages on record: what the checks actually paid (gross minus gear lines),
// else the estimate. `actual` says which.
export function jobWages(job, stubsByJob) {
  let sum = 0, any = false;
  for (const s of stubsOf(job, stubsByJob)) {
    if (s.gross === null || s.gross === undefined) continue;
    const w = wagePart(s);
    if (w > 0) { sum += w; any = true; }
  }
  if (any) return { amount: round2(sum), actual: true };
  const est = estWages(job);
  return est === null ? null : { amount: est, actual: false };
}

// Weekly gear billing: one invoice per billed week, each sent/paid on its
// own. Returns null when the job doesn't bill weekly.
export function gearInv(job) {
  const inv = Array.isArray(job.gear_invoices) ? job.gear_invoices : [];
  if (!inv.length) return null;
  const sum = a => a.reduce((s, i) => s + (i.amount || 0), 0);
  const paid = inv.filter(i => i.status === 'paid');
  const unsent = inv.filter(i => i.status === 'unsent');
  // A week's money is due once that week has ended — no waiting for wrap.
  const dueNow = inv.filter(i => i.status !== 'paid' && (i.end || i.start || '9999-99-99') <= today());
  return { n: inv.length, nPaid: paid.length, nUnsent: unsent.length,
    total: sum(inv), paidAmt: sum(paid), dueAmt: sum(dueNow), dueNow };
}

// Which of a job's days its wage checks have paid. Checks record the days
// they cover; a long job paid weekly stays 'partial' until every day is
// covered. `tracked` is true only when EVERY wage check on the job recorded
// its days — one check without days (older records, split halves) means
// coverage can't be trusted, and callers fall back to the simple rules.
export function wageCoverage(job, stubs) {
  let days = [...(job.work_dates || [])].sort();
  const explicit = days.length > 0;
  if (!explicit && job.start_date) {
    for (let d = job.start_date; d <= (job.end_date || job.start_date) && days.length < 400; d = addDays(d, 1)) days.push(d);
  }
  const paid = new Set();
  let withDays = 0, without = 0;
  for (const s of stubs || []) {
    if (wagePart(s) <= 0) continue;                       // gear-only check
    if ((s.work_dates || []).length) { withDays++; for (const d of s.work_dates) paid.add(d); }
    else without++;
  }
  const tracked = withDays > 0 && without === 0;
  let unpaid = days.filter(d => !paid.has(d));
  if (!explicit) {
    // No specific days on the job: the span may include days off. Only
    // (days worked − days paid) can still be unpaid, earliest first.
    const paidInSpan = days.filter(d => paid.has(d)).length;
    unpaid = unpaid.slice(0, Math.max(0, jobDays(job) - paidInSpan));
  }
  const paidOnJob = explicit ? days.filter(d => paid.has(d)).length : Math.min(paid.size, jobDays(job));
  return { jobDays: days, total: explicit ? days.length : jobDays(job), paid, paidOnJob, unpaid, tracked };
}

// Estimated wages still to come on a weekly-tracked job that isn't fully
// paid (0 for paid jobs and for jobs whose checks don't record days).
export function wagesRemaining(job, stubs) {
  if (job.wages_status === 'paid' || !job.rate_amount) return 0;
  const cov = wageCoverage(job, stubs);
  if (!cov.tracked) return 0;
  return round2(cov.unpaid.reduce((a, d) => a + dayPay(job, d), 0));
}

// Gear received on checks for this job.
export const gearReceived = (stubs) => round2((stubs || []).reduce((a, s) => a + gearOnStub(s.earnings), 0));

// What a job still owes right now.
//  wages — weekly-tracked: worked days to date no check has covered.
//          otherwise, once wrapped: the estimate minus wages already received.
//  gear  — weekly invoices: ended, unpaid weeks minus gear checks not yet
//          reflected in an invoice. Otherwise, once wrapped: stated total
//          minus gear received.
export function owedFor(j, stubsByJob) {
  const out = { wages: 0, gear: 0 };
  if (j.deleted || j.job_status === 'hold') return out;
  const ss = stubsOf(j, stubsByJob);
  if (j.wages_status !== 'paid') {
    const cov = wageCoverage(j, ss);
    if (cov.tracked) {
      out.wages = round2(cov.unpaid.filter(d => d <= today()).reduce((a, d) => a + dayPay(j, d), 0));
    } else if (isWrapped(j)) {
      const est = estWages(j);
      const w = jobWages(j, stubsByJob);
      if (est !== null) out.wages = round2(Math.max(0, est - (w && w.actual ? w.amount : 0)));
    }
  }
  const got = gearReceived(ss);
  const gi = gearInv(j);
  if (gi) out.gear = round2(Math.max(0, gi.dueAmt - Math.max(0, got - gi.paidAmt)));
  else if (j.gear_status !== 'na' && j.gear_status !== 'paid' && j.gear_total && isWrapped(j)) {
    out.gear = round2(Math.max(0, j.gear_total - got));
  }
  return out;
}

// What is owed, dated by when the WORK was done (so it sits beside the
// month's paid money, not under the job's start month): each unpaid worked
// day in its own month; an untracked job's estimate in its last month;
// weekly gear invoices in the month their week ended; other gear in the
// job's last month.
export function owedEvents(jobs, stubsByJob) {
  const ev = [];
  for (const j of jobs) {
    if (j.deleted || j.job_status === 'hold') continue;
    const ss = stubsOf(j, stubsByJob);
    const o = owedFor(j, stubsByJob);
    const lastM = (j.end_date || j.start_date || '').slice(0, 7);
    if (o.wages > 0) {
      const cov = wageCoverage(j, ss);
      if (cov.tracked) {
        for (const d of cov.unpaid.filter(d => d <= today())) ev.push({ m: d.slice(0, 7), kind: 'wages', amt: dayPay(j, d), job: j.id });
      } else ev.push({ m: lastM, kind: 'wages', amt: o.wages, job: j.id });
    }
    if (o.gear > 0) {
      const gi = gearInv(j);
      if (gi) {
        let left = o.gear;
        for (const inv of gi.dueNow.sort((a, b) => (a.end || a.start || '').localeCompare(b.end || b.start || ''))) {
          const amt = Math.min(left, inv.amount || 0);
          if (amt > 0) ev.push({ m: (inv.end || inv.start || lastM).slice(0, 7), kind: 'gear', amt, job: j.id });
          left = round2(left - amt);
        }
      } else ev.push({ m: lastM, kind: 'gear', amt: o.gear, job: j.id });
    }
  }
  return ev;
}

// Every paid dollar, dated when it was PAID: each check's wage and gear parts
// land in its check-date month, attributed to whoever the check names. Money
// marked paid with no check behind it (or more than the checks cover) falls
// back to the job: its start month, or the invoice's week for weekly gear.
export function paidEvents(jobs, stubsByJob) {
  const ev = [];
  for (const j of jobs) {
    if (j.deleted || j.job_status === 'hold') continue;
    const jm = (j.start_date || '').slice(0, 7);
    let wagesFromChecks = 0, gearFromChecks = 0;
    for (const s of stubsOf(j, stubsByJob)) {
      if (s.gross === null || s.gross === undefined) continue;
      const m = (s.check_date || j.start_date || '').slice(0, 7);
      const g = gearOnStub(s.earnings);
      const w = wagePart(s);
      if (w) { ev.push({ m, kind: 'wages', amt: w, via: s.paid_to || j.paid_via }); wagesFromChecks += w; }
      if (g) { ev.push({ m, kind: 'gear', amt: g, via: s.paid_to || j.gear_paid_via || j.paid_via }); gearFromChecks += g; }
    }
    if (!wagesFromChecks && j.wages_status === 'paid') {
      const w = jobWages(j, stubsByJob);
      if (w) ev.push({ m: jm, kind: 'wages', amt: w.amount, via: j.paid_via });
    }
    const gearVia = j.gear_paid_via || j.paid_via;
    const gi = gearInv(j);
    if (gi) {
      // Invoices marked paid beyond what gear checks account for.
      let extra = round2(gi.paidAmt - gearFromChecks);
      const paidInv = j.gear_invoices.filter(i => i.status === 'paid')
        .sort((a, b) => (b.end || b.start || '').localeCompare(a.end || a.start || ''));
      for (const inv of paidInv) {
        if (extra <= 0) break;
        const amt = Math.min(extra, inv.amount || 0);
        ev.push({ m: (inv.end || inv.start || j.start_date || '').slice(0, 7), kind: 'gear', amt, via: gearVia });
        extra = round2(extra - amt);
      }
    } else if (j.gear_status === 'paid' && j.gear_total && j.gear_total - gearFromChecks > 1) {
      ev.push({ m: jm, kind: 'gear', amt: round2(j.gear_total - gearFromChecks), via: gearVia });
    }
  }
  return ev;
}

// Record a gear payment on a job: weekly invoices are marked paid oldest
// first as the money covers them; otherwise the status follows the
// CUMULATIVE gear received (several checks can add up to the total).
export function applyGearPayment(job, amount, priorReceived = 0) {
  const inv = Array.isArray(job.gear_invoices) ? job.gear_invoices : [];
  if (inv.length) {
    let left = amount;
    const order = [...inv].sort((a, b) => (a.start || a.end || '').localeCompare(b.start || b.end || ''));
    for (const i of order) {
      if (i.status === 'paid') continue;
      if (left >= (i.amount || 0) - 1) { i.status = 'paid'; left = round2(left - (i.amount || 0)); }
    }
    const p = inv.filter(i => i.status === 'paid').length;
    job.gear_status = p === inv.length ? 'paid' : (p || amount > 0) ? 'partial' : 'unpaid';
    return job.gear_status;
  }
  const total = round2(priorReceived + amount);
  if (job.gear_total === null || job.gear_total === undefined) job.gear_total = total;
  job.gear_status = total < job.gear_total - 1 ? 'partial' : 'paid';
  return job.gear_status;
}

// The base (straight-time) hourly rate on a stub: the REG/straight line's
// rate, else the lowest hourly rate found.
export function baseRateOf(p) {
  const st = (p.earnings || []).find(e => /straight|^reg\b/i.test(e.type || '') && e.rate);
  const r = st ? st.rate : (p.hourly_rates || []).filter(Boolean).sort((a, b) => a - b)[0];
  return r ? round2(r) : null;
}
