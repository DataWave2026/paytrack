// Match a parsed paystub to jobs. Scores: date-range overlap is the
// strongest signal, then rate consistency, then fuzzy name match.

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function overlapScore(stub, job) {
  if (!job.start_date) return 0;
  // Checks carry only an issue date, no work period — but payments land
  // within terms of wrap, so a check dated 0-45 days after the job's last
  // day is a solid date signal (gear terms are ~30 days).
  if (!stub.period_start) {
    if (!stub.check_date) return 0;
    const gap = daysBetween(job.end_date || job.start_date, stub.check_date);
    if (gap >= -1 && gap <= 45) return 25;
    // Late payments (46-90 days) are routine for gear invoices, so the gap
    // alone must not pick a recent job over an older unpaid one from the
    // same client — it stays a plausible, slightly weaker signal.
    if (gap > 45 && gap <= 90) return 20;
    return 0;
  }
  const s1 = stub.period_start, e1 = stub.period_end || stub.period_start;
  const s2 = job.start_date, e2 = job.end_date || job.start_date;
  const start = s1 > s2 ? s1 : s2;
  const end = e1 < e2 ? e1 : e2;
  if (start <= end) {
    // Real overlap — full marks when it covers at least half of the shorter
    // of the two ranges; a single shared edge day scores less, so the job a
    // pay period mostly falls in beats its neighbour.
    const shared = daysBetween(start, end) + 1;
    const shorter = Math.min(daysBetween(s1, e1), daysBetween(s2, e2)) + 1;
    return shared / shorter >= 0.5 ? 50 : 35;
  }
  const gap = Math.min(Math.abs(daysBetween(e1, s2)), Math.abs(daysBetween(e2, s1)));
  if (gap <= 3) return 30;                           // adjacent (weekly period edges)
  if (gap <= 10) return 10;
  return 0;
}

// Productions derive hourly from a day rate several ways; accept any of the
// usual conversions within 2%: rate/hours, rate/8, and the union-style
// rate/(8 + 1.5 * (hours - 8)).
export function rateVariants(rateAmount, rateHours) {
  if (!rateAmount) return [];
  const v = [];
  if (rateHours) {
    v.push(rateAmount / rateHours);
    if (rateHours > 8) v.push(rateAmount / (8 + 1.5 * (rateHours - 8)));
  }
  v.push(rateAmount / 8, rateAmount / 10, rateAmount / 12);
  return v;
}

function rateScore(stub, job) {
  if (!stub.hourly_rates?.length || (!job.rate_amount && !job.rate_hourly)) return 0;
  const variants = rateVariants(job.rate_amount, job.rate_hours);
  // A job entered by hourly rate matches the stub's hourly directly.
  if (job.rate_hourly) variants.push(job.rate_hourly);
  for (const hr of stub.hourly_rates) {
    for (const v of variants) {
      if (Math.abs(hr - v) / v <= 0.02) return 20;
    }
    // OT lines are 1.5x/2x the straight rate
    for (const v of variants) {
      if (Math.abs(hr - v * 1.5) / (v * 1.5) <= 0.02) return 15;
      if (Math.abs(hr - v * 2) / (v * 2) <= 0.02) return 15;
    }
  }
  return 0;
}

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Entity suffixes carry no identity: "BRIGHT FUTURE, LLC", "Bright Future
// LLC" and "BRIGHT FUTURE" (the check parser trims after the comma) are one
// company. Applied to name COMPARISONS only — acronym() keeps the raw words
// so a show logged by its initials still resolves the same way.
const SUFFIX_RE = /(?:\s+(?:llc|l l c|inc|corp|ltd|co|company))+$/;
function nameKey(s) {
  const n = norm(s);
  return n.replace(SUFFIX_RE, '').trim() || n;
}

// A gear payment matching the job's stated gear total is a strong signal.
function gearScore(stub, job) {
  if (!stub.gear_amount || !job.gear_total) return 0;
  const diff = Math.abs(stub.gear_amount - job.gear_total) / job.gear_total;
  if (diff <= 0.02) return 25;
  if (diff <= 0.15) return 10;
  return 0;
}

// Shows get logged by acronym: "AGE OF ATTRACTION - SEASON 2" -> "aoa2"
// ("season N" collapses to N; every other word gives its first letter).
export function acronym(s) {
  const w = norm(s).split(' ').filter(Boolean);
  let out = '';
  for (let i = 0; i < w.length; i++) {
    if (/^(season|s|series|part|pt|vol)$/.test(w[i]) && /^\d+$/.test(w[i + 1] || '')) { out += w[++i]; continue; }
    out += /^\d+$/.test(w[i]) ? w[i] : w[i][0];
  }
  return out;
}

function nameScore(stub, job) {
  // job_title carries a check's memo line — memos often name the show.
  const stubNames = [nameKey(stub.project_name), nameKey(stub.employer), nameKey(stub.job_title), nameKey(stub.memo)].filter(Boolean);
  const jobNames = [nameKey(job.project), nameKey(job.company)].filter(Boolean);
  // A bare check (no project, no work period) can only match on the PAYER's
  // name — and a repeat client's name fits every job they ever booked, so
  // it is capped below the exact-title score; dates and the gear amount
  // must carry the rest.
  const bare = !stub.project_name && !stub.period_start;
  let best = 0;
  // Acronym of the stub's show title vs the job name as typed ("AoA2",
  // "AOA2 - prep"): exact = strong, prefix = solid.
  const ac = acronym(stub.project_name);
  if (ac.length >= 3) {
    for (const b of jobNames) {
      const sq = b.replace(/\s/g, '');
      if (sq === ac) best = Math.max(best, 35);
      else if (ac.length >= 4 && (sq.startsWith(ac) || b.split(' ')[0] === ac)) best = Math.max(best, 25);
    }
  }
  for (const a of stubNames) {
    for (const b of jobNames) {
      if (!a || !b) continue;
      // An exact title match is close to decisive — gear checks often arrive
      // dated after the worked days, so dates alone can't carry it.
      // "Riverton (Part 2)" / "(Week 3)" is the same title as "Riverton".
      const bBase = b.replace(/\s+(part|pt|week|wk)\s*\d+$/, '');
      if (a === b || a === bBase) best = Math.max(best, 40);
      // (containment only counts for names of 4+ letters — a job called
      // "X" or "El" is contained in almost anything)
      else if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) best = Math.max(best, 25);
      else {
        const aw = new Set(a.split(' ')), bw = b.split(' ');
        const common = bw.filter(w => w.length > 2 && aw.has(w)).length;
        if (common) best = Math.max(best, Math.min(18, common * 9));
      }
    }
  }
  return bare ? Math.min(best, 25) : best;
}

// Two candidates the matcher cannot tell apart: same company, and BOTH jobs'
// stated gear total equals the check's gear amount (within 2%). A late gear
// check from a repeat client fits either job, so the app must not preselect
// one — the user breaks the tie. Works on matchStub()'s output (uses the
// gear component already scored); pass the stub to compare amounts directly.
export function isTie(candidates, stub) {
  if (!Array.isArray(candidates) || candidates.length < 2) return false;
  const [a, b] = candidates;
  const ca = nameKey(a.job?.company), cb = nameKey(b.job?.company);
  if (!ca || ca !== cb) return false;
  const gearMatches = (c) => {
    if (stub && stub.gear_amount) {
      const total = c.job?.gear_total;
      return !!total && Math.abs(stub.gear_amount - total) / total <= 0.02;
    }
    return (c.parts?.ga ?? 0) >= 25;
  };
  return gearMatches(a) && gearMatches(b);
}

function scoreParts(stub, job) {
  return {
    o: overlapScore(stub, job), r: rateScore(stub, job),
    n: nameScore(stub, job), ga: gearScore(stub, job),
  };
}

// Returns [{job, score, reasons, parts}] sorted best-first; only plausible ones.
export function matchStub(stub, jobs) {
  const scored = jobs
    .filter(j => !j.deleted)
    .map(job => {
      const { o, r, n, ga } = scoreParts(stub, job);
      const reasons = [];
      if (o >= 50) reasons.push('dates overlap');
      else if (o > 0) reasons.push('dates close');
      if (r >= 20) reasons.push('rate matches');
      else if (r > 0) reasons.push('OT rate matches');
      if (n >= 25) reasons.push('name matches');
      else if (n > 0) reasons.push('name similar');
      if (ga >= 25) reasons.push('gear amount matches');
      else if (ga > 0) reasons.push('gear amount close');
      return { job, score: o + r + n + ga, reasons, parts: { o, r, n, ga } };
    })
    .filter(c => c.score >= 20)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

// EVERY job scored with the component breakdown (overlap/rate/name/gear),
// including sub-threshold ones — this is what the diagnostics log records,
// so a "didn't find the job" report shows exactly why each job scored low.
export function matchDebug(stub, jobs) {
  return jobs
    .filter(j => !j.deleted)
    .map(job => {
      const p = scoreParts(stub, job);
      return { project: job.project, dates: `${job.start_date}..${job.end_date}`,
        score: p.o + p.r + p.n + p.ga, ...p };
    })
    .sort((a, b) => b.score - a.score);
}
