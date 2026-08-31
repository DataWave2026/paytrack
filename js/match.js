// Match a parsed paystub to jobs. Scores: date-range overlap is the
// strongest signal, then rate consistency, then fuzzy name match.

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function overlapScore(stub, job) {
  if (!stub.period_start || !job.start_date) return 0;
  const s1 = stub.period_start, e1 = stub.period_end || stub.period_start;
  const s2 = job.start_date, e2 = job.end_date || job.start_date;
  const start = s1 > s2 ? s1 : s2;
  const end = e1 < e2 ? e1 : e2;
  if (start <= end) return 50;                       // real overlap
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
  if (!stub.hourly_rates?.length || !job.rate_amount) return 0;
  const variants = rateVariants(job.rate_amount, job.rate_hours);
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

// A gear payment matching the job's stated gear total is a strong signal.
function gearScore(stub, job) {
  if (!stub.gear_amount || !job.gear_total) return 0;
  const diff = Math.abs(stub.gear_amount - job.gear_total) / job.gear_total;
  if (diff <= 0.02) return 25;
  if (diff <= 0.15) return 10;
  return 0;
}

function nameScore(stub, job) {
  const stubNames = [norm(stub.project_name), norm(stub.employer)].filter(Boolean);
  const jobNames = [norm(job.project), norm(job.company)].filter(Boolean);
  let best = 0;
  for (const a of stubNames) {
    for (const b of jobNames) {
      if (!a || !b) continue;
      if (a === b) best = Math.max(best, 30);
      else if (a.includes(b) || b.includes(a)) best = Math.max(best, 22);
      else {
        const aw = new Set(a.split(' ')), bw = b.split(' ');
        const common = bw.filter(w => w.length > 2 && aw.has(w)).length;
        if (common) best = Math.max(best, Math.min(18, common * 9));
      }
    }
  }
  return best;
}

// Returns [{job, score, reasons}] sorted best-first; only plausible ones.
export function matchStub(stub, jobs) {
  const scored = jobs
    .filter(j => !j.deleted)
    .map(job => {
      const o = overlapScore(stub, job);
      const r = rateScore(stub, job);
      const n = nameScore(stub, job);
      const ga = gearScore(stub, job);
      const reasons = [];
      if (o >= 50) reasons.push('dates overlap');
      else if (o > 0) reasons.push('dates close');
      if (r >= 20) reasons.push('rate matches');
      else if (r > 0) reasons.push('OT rate matches');
      if (n >= 22) reasons.push('name matches');
      else if (n > 0) reasons.push('name similar');
      if (ga >= 25) reasons.push('gear amount matches');
      else if (ga > 0) reasons.push('gear amount close');
      return { job, score: o + r + n + ga, reasons };
    })
    .filter(c => c.score >= 20)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}
