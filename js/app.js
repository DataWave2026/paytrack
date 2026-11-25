import { settings, saveSettings, savePrefs } from './config.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as g from './google.js';
import * as sync from './sync.js';
import { parseStub, blankParse, gearOnStub } from './parse.js';
import { matchStub, matchDebug, isTie } from './match.js';
import { payeeMatch, autoPick, cloneWeeks, inferHourlyMode, preselectCoveredDays } from './ui-logic.js';
import { jobDays, isWrapped, dayPay, estWages, jobWages, gearInv, wageCoverage, wagesRemaining,
  gearReceived, owedFor, owedEvents, paidEvents, applyGearPayment, baseRateOf, isFlat } from './money.js';
import { log, dump, dumpErrors, clearLog } from './log.js';

window.addEventListener('error', (e) =>
  log('error', { msg: String(e.message), src: `${(e.filename || '').split('/').pop()}:${e.lineno}` }));
window.addEventListener('unhandledrejection', (e) =>
  log('unhandled', { msg: String(e.reason?.message || e.reason).slice(0, 200) }));

// ---------- tiny DOM helper ----------
// Async button handlers run once at a time: the button is disabled until the
// handler settles (a double-tap used to create a 4-week job twice).
function busyGuard(fn) {
  return async function (e) {
    const b = e.currentTarget;
    if (b && b.dataset.busy) return;
    if (b) { b.dataset.busy = '1'; b.disabled = true; }
    try { return await fn.call(this, e); }
    finally { if (b) { delete b.dataset.busy; b.disabled = false; } }
  };
}
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'onclick' && tag === 'button' && v && v.constructor && v.constructor.name === 'AsyncFunction') el.addEventListener('click', busyGuard(v));
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  if (tag === 'div' && attrs.onclick && !attrs.role) {
    el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0');
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const viewEl = document.getElementById('view');
// "$1,234.56" typed into a money field is a number, not a blank.
const parseMoneyInput = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isNaN(n) ? null : n; };
const isPhone = () => (window.matchMedia && matchMedia('(pointer: coarse)').matches) || /iPhone|iPad|Android/i.test(navigator.userAgent);

// Unsaved job edits survive a reload (new version, memory pressure on the
// phone, a process kill after the camera): the editor keeps a draft while it
// is open; Home and Jobs offer to resume it for 24 hours.
const DRAFT_KEY = 'paytrack.draftJob';
function saveDraft(job, existingId) { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ job, existingId: existingId || null, t: Date.now() })); } catch {} }
function readDraft() {
  try { const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); if (d && d.job && Date.now() - d.t < 24 * 3600e3) return d; } catch {}
  return null;
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch {} }
let editorAbort = null;
function draftCard(d) {
  const when = new Date(d.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return h('div', { class: 'card' },
    h('h2', {}, 'Unsaved edit'),
    h('p', { class: 'muted' }, `"${d.job.project || 'untitled job'}" was being edited at ${when} and never saved.`),
    h('div', { class: 'row2' },
      h('button', { class: 'primary', style: 'margin-top:0', onclick: async () => {
        const existing = d.existingId ? await store.getJob(d.existingId) : null;
        await render('jobs');
        editJob(existing, null, d.job);
      } }, 'Resume editing'),
      h('button', { class: 'secondary', style: 'margin-top:0', onclick: () => { clearDraft(); render(); } }, 'Discard')));
}
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// Privacy eye: when on, every dollar amount renders masked, app-wide.
let hideMoney = settings().hideMoney;
const MASK = '$•••';
const fmt$ = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return hideMoney ? MASK : fmtRaw$(n);
};
// Never masked by the privacy eye — for text that is SAVED (job notes end up
// on the calendar); fmt$ there would store a literal "$•••".
const fmtRaw$ = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', Number.isInteger(n)
    ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const today = store.today;   // LOCAL date (UTC rolled over at ~4pm Pacific)

function fmtRange(a, b, alwaysYear = false) {
  if (!a) return 'no dates';
  const cy = String(new Date().getFullYear());
  const f = (d) => {
    const opts = { month: 'short', day: 'numeric' };
    if (alwaysYear || !d.startsWith(cy)) opts.year = 'numeric';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', opts);
  };
  return !b || b === a ? f(a) : `${f(a)} – ${f(b)}`;
}



function isOverdue(job) {
  return Object.values(sync.jobDueDates(job)).some(d => d < today());
}


// ---------- views ----------
let currentView = 'home';
const views = { home, jobs, stub, review, settings: settingsView };

// The job editor, owed screen and scan screens draw over the current view
// without being views. While one is open, background data changes (a sync
// landing, a push finishing) must not re-render the list over it and throw
// away what the user is typing.
let overlayOpen = false;
let allJobsOpen = false;
let renderGen = 0;
async function render(name) {
  const keepScroll = !name;          // a background refresh keeps the position
  // A nameless (background) refresh never replaces an open editor/form.
  if (!name && overlayOpen) return;
  if (name) { overlayOpen = false; editorAbort?.abort(); window.__pickMatchOpen = false; }   // explicit navigation closes any overlay
  currentView = name || currentView;
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === currentView));
  const top = viewEl.scrollTop;
  const gen = ++renderGen;
  let node;
  try {
    node = await views[currentView]();
  } catch (e) {
    log('renderErr', { view: currentView, msg: String(e.message).slice(0, 200) });
    node = h('div', { class: 'card' },
      h('h3', {}, 'This screen could not be drawn'),
      h('p', { class: 'muted' }, String(e.message)),
      h('button', { class: 'btn', onclick: () => render('settings') }, 'Open Setup (bug report, force update)'));
  }
  // A render that finished after a newer one started, or after the user opened
  // an editor meanwhile, must not land on top of it.
  if (gen !== renderGen || (!name && overlayOpen)) return;
  const draft = (currentView === 'home' || currentView === 'jobs') && readDraft();
  if (draft) node.prepend(draftCard(draft));
  viewEl.replaceChildren(node);
  viewEl.scrollTop = keepScroll ? top : 0;
  if (name) maybeReloadForUpdate();
}

// A new app version never reloads the page while a form, a scan or a sync is
// in progress — it waits for the next explicit navigation.
let reloadPending = false;
let scanInFlight = false;
function maybeReloadForUpdate() {
  if (!reloadPending || overlayOpen || scanInFlight || syncInFlight) return;
  reloadPending = false;
  location.reload();
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) render(btn.dataset.view);
});

// Google tokens die after ~1h and browsers only allow the refresh popup
// during a user gesture — so ride along on ordinary taps, but ONLY once the
// session has actually expired (the renewal popup flashes briefly; keep that
// to at most ~once an hour, never pre-emptively).
let lastRefreshTry = 0;
document.addEventListener('click', (e) => {
  // The dot and the Connect buttons open the real popup themselves — a silent
  // attempt from the same tap would only cancel it.
  if (e.target?.closest?.('#conn-status, [data-connect]')) return;
  if (!settings().everConnected) return;
  if (auth.isConnected()) return;
  const now = Date.now();
  if (now - lastRefreshTry < 60000) return;
  lastRefreshTry = now;
  auth.trySilentRefresh().then(ok => { if (ok) backgroundSync(); });
}, true);
store.bus.addEventListener('change', () => { if (!overlayOpen) render(); });

// ---------- home ----------
async function home() {
  const jobs = await store.allJobs();
  const stubs = await store.allStubs();
  const stubsByJob = {};
  for (const s of stubs) {
    if (s.matched_job_id) (stubsByJob[s.matched_job_id] ||= []).push(s);
  }
  const real = jobs.filter(j => j.job_status !== 'hold');
  // Awaiting wages: wrapped and unpaid, or a weekly-paid job with worked
  // days to date that no check has covered yet.
  const unpaidWages = real.filter(j => j.wages_status !== 'paid'
    && (isWrapped(j) || owedFor(j, stubsByJob).wages > 0));
  const unpaidGear = real.filter(j => owedFor(j, stubsByJob).gear > 0);
  const overdue = jobs.filter(isOverdue);
  // Upcoming = future or in-progress jobs, plus EVERY unresolved hold (even
  // past-dated ones — a hold stays visible until confirmed or removed, so it
  // can never silently vanish between Upcoming and Recent).
  const upcoming = jobs.filter(j => j.job_status === 'hold'
    || (j.start_date && (j.end_date || j.start_date) >= today()))
    .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
  // Recent = completed work only: wrapped on or before today, never holds or
  // future bookings (those live in Upcoming).
  const recent = real.filter(j => (j.end_date || j.start_date) && (j.end_date || j.start_date) <= today());
  const gearOut = unpaidGear.reduce((s, j) => s + owedFor(j, stubsByJob).gear, 0);
  const wagesOut = unpaidWages.reduce((s, j) => s + owedFor(j, stubsByJob).wages, 0);
  // Red only when actually LATE (past the wages 14d / gear 30d timers, or a
  // job's own expected date); yellow = unpaid but still within terms.
  const lateWages = unpaidWages.some(j => (sync.jobDueDates(j).wages || '9999') < today());
  // Same due date as the calendar reminder (weekly-invoice aware).
  const lateGear = unpaidGear.some(j => (sync.jobDueDates(j).gear || '9999') < today());
  const wagesTone = unpaidWages.length ? (lateWages ? 'bad' : 'warn') : 'ok';
  const gearTone = unpaidGear.length ? (lateGear ? 'bad' : 'warn') : 'ok';

  // Last three calendar months, oldest first (wages + gear combined). Paid
  // money is dated by when it was paid; owed money by when the work was.
  const nowD = new Date();
  const events = paidEvents(real, stubsByJob);
  const owedByMonth = owedEvents(real, stubsByJob);
  const last3 = [2, 1, 0].map(k => {
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - k, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let me = 0, co = 0, un = 0, due = 0;
    for (const e of events.filter(x => x.m === m)) {
      if (e.via === 'company') co += e.amt;
      else if (e.via === 'me') me += e.amt;
      else un += e.amt;
    }
    let dueEst = false;
    for (const e of owedByMonth.filter(x => x.m === m)) { due += e.amt; if (e.kind === 'wages') dueEst = true; }
    return { label: d.toLocaleString('en-US', { month: 'long' }), m, me, co, un, due, dueEst };
  });
  const unattributed = last3.reduce((s, r) => s + r.un, 0);

  // A connected device with no calendar picked saves jobs to the cloud but
  // never updates the calendar — say so loudly instead of failing silently.
  const noCal = settings().everConnected && !settings().calendarId;
  return h('div', {},
    noCal ? h('div', { class: 'card', style: 'border-color:var(--warn)' },
      h('p', { style: 'margin:0;color:var(--warn)' },
        'No calendar is selected on this device, so job changes here won\'t reach your calendar. ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); render('settings'); } }, 'Pick it in Setup'), '.')) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'Outstanding'),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat clicky ' + wagesTone, onclick: () => showOwed() },
          h('div', { class: 'num' }, String(unpaidWages.length)),
          h('div', { class: 'lbl' }, lateWages ? 'jobs awaiting wages (late)' : 'jobs awaiting wages')),
        h('div', { class: 'stat clicky ' + gearTone, onclick: () => showOwed() },
          h('div', { class: 'num' }, fmt$(gearOut || 0)),
          h('div', { class: 'lbl' }, lateGear ? 'gear outstanding (late)' : 'gear outstanding')),
        h('div', { class: 'stat clicky ' + (unpaidWages.length ? wagesTone : ''), onclick: () => showOwed() },
          h('div', { class: 'num' }, wagesOut ? '~' + fmt$(wagesOut) : '—'),
          h('div', { class: 'lbl' }, 'est. wages owed'))),
    ),
    h('div', { class: 'card' },
      h('h2', {}, 'Last 3 months'),
      h('table', { class: 'tot' },
        h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Me'), h('th', {}, 'Company'), h('th', {}, 'Owed (est.)')),
        last3.map(r => h('tr', {},
          h('td', {}, r.label),
          h('td', {}, r.me ? fmt$(r.me) : '—'),
          h('td', {}, r.co ? fmt$(r.co) : '—'),
          h('td', { style: r.due ? 'color:var(--bad);font-weight:600' : '' },
            r.due ? h('a', { href: '#', class: 'owedlink', title: 'Estimated from the job\'s day rate for worked days no check has paid yet — tap for details',
              onclick: (e) => { e.preventDefault(); showOwed(r.m); } }, (r.dueEst ? '~' : '') + fmt$(r.due)) : '—')))),
      unattributed ? h('p', { class: 'muted small mt' },
        `${fmt$(unattributed)} paid without a payee set — edit those jobs ("Wages paid to") or scan their stubs to attribute it.`) : null),
    totalsCard(jobs, stubsByJob),
    paychecksCard(stubs, jobs),
    upcoming.length ? h('div', { class: 'card' },
      h('h2', {}, 'Upcoming'),
      upcoming.slice(0, 6).map(j => jobRow(j, stubsByJob))) : null,
    overdue.length ? h('div', { class: 'card' },
      h('h2', {}, 'Overdue'),
      overdue.map(j => jobRow(j, stubsByJob))) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'Recent jobs'),
      recent.length ? [
        ...recent.slice(0, 8).map(j => jobRow(j, stubsByJob)),
        listTotalsLine(recent.slice(0, 8), stubsByJob, 'Total (listed)'),
      ] : emptyHint()),
  );
}

// An empty device is usually a device whose storage was cleared (or a new
// one), not a new user: point at the cloud copy before inviting re-entry.
function emptyHint() {
  if (!auth.isConnected()) {
    return h('div', {},
      h('p', { class: 'muted' }, 'Nothing here yet. If you have used PayTrack before, connect Google and your jobs come back from the PayTrack DB sheet in your Drive.'),
      h('button', { class: 'primary', onclick: async () => {
        try { await auth.connect(); toast('Connected — syncing…'); await backgroundSync(); render('home'); }
        catch (e) { toast(e.message, 6000); }
      }, 'data-connect': '1' }, 'Connect Google'));
  }
  return h('p', { class: 'muted' }, 'No completed jobs yet. Add one in the Jobs tab, or import your calendar history from the Import tab.');
}

function statusBadge(kind, status) {
  if (status === 'na') return h('span', { class: 'badge na' }, kind + ': —');
  const label = status === 'paid' ? 'paid' : status === 'partial' ? 'partial' : 'UNPAID';
  return h('span', { class: 'badge ' + status }, `${kind}: ${label}`);
}

function jobRow(job, stubsByJob) {
  const rate = job.rate_amount && job.rate_hours
    ? (hideMoney ? MASK : `$${job.rate_amount}/${job.rate_hours}`)
    : (hideMoney && /\$/.test(job.rate_text || '') ? MASK : (job.rate_text || ''));
  const w = stubsByJob ? jobWages(job, stubsByJob) : null;
  const amt = w ? `${w.actual ? '' : '~'}${fmt$(w.amount)} wages` : '';
  return h('div', { class: 'job', onclick: () => render('jobs').then(() => editJob(job)) },
    h('div', {},
      h('div', { class: 'title' }, job.project || '(untitled)'),
      h('div', { class: 'sub' }, [fmtRange(job.start_date, job.end_date),
        job.days_worked ? `${job.days_worked} day${job.days_worked === 1 ? '' : 's'}` : '', rate, amt,
        job.gear_total ? `gear ${fmt$(job.gear_total)}` : ''].filter(Boolean).join(' · '))),
    h('div', { class: 'badges' },
      job.job_status === 'hold' ? h('span', { class: 'badge partial' }, 'HOLD') : null,
      job.job_status === 'hold' ? h('button', {
        class: 'inline secondary', style: 'font-size:.7rem;padding:4px 9px',
        onclick: async (e) => {
          e.stopPropagation();
          job.job_status = 'confirmed';
          await store.patchJob(job.id, { job_status: 'confirmed' });
          sync.pushSoon(job).catch(() => {});
          toast(`${job.project} confirmed — now a tracked job.`);
        },
      }, 'Confirm') : null,
      // A hold isn't an official job yet: neutral "wages: — / gear: —" until confirmed.
      // Invoice state is a tap-toggle right on the row: not sent <-> sent.
      ['unsent', 'sent'].includes(job.invoice_status) && job.job_status !== 'hold' ? h('button', {
        class: 'badge ' + (job.invoice_status === 'unsent' ? 'partial' : 'paid'),
        style: 'border:none;cursor:pointer;font-weight:600',
        onclick: async (e) => {
          e.stopPropagation();
          job.invoice_status = job.invoice_status === 'unsent' ? 'sent' : 'unsent';
          await store.patchJob(job.id, { invoice_status: job.invoice_status });
          sync.pushSoon(job).catch(() => {});
          toast(job.invoice_status === 'sent'
            ? 'Invoice marked sent — reminder removed.'
            : 'Invoice marked NOT sent — reminder resumes.');
        },
      }, job.invoice_status === 'unsent' ? 'invoice: NOT SENT' : 'invoice: sent') : null,
      statusBadge('wages', job.job_status === 'hold' ? 'na' : job.wages_status),
      (() => {
        if (job.job_status === 'hold') return statusBadge('gear', 'na');
        const gi = gearInv(job);
        const owed = !isFlat(job) && (gi ? gi.nPaid < gi.n : (job.gear_status === 'unpaid' || job.gear_status === 'partial'));
        const cls = gi ? (gi.nPaid === gi.n ? 'paid' : gi.nPaid ? 'partial' : 'unpaid') : job.gear_status;
        const label = gi ? `gear inv: ${gi.nPaid}/${gi.n} paid${gi.nUnsent ? ` · ${gi.nUnsent} unsent` : ''}` : null;
        if (!owed) return gi ? h('span', { class: 'badge ' + cls }, label) : statusBadge('gear', job.gear_status);
        // Owed gear is one tap from paid — the same kind of control as the
        // invoice toggle, so "the money arrived" never has to go through the
        // editor (the invoice badge only ever meant "invoice sent").
        const amt = gi ? Math.max(0, gi.total - gi.paidAmt) : job.gear_total;
        return h('button', {
          class: 'badge ' + cls, style: 'border:none;cursor:pointer;font-weight:600',
          title: 'Tap to record the gear payment',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Record ${amt ? fmt$(amt) + ' of ' : ''}gear as PAID for "${job.project}"?\n\nUse this when the money has arrived and you are not scanning the check.`)) return;
            const patch = { gear_status: 'paid' };
            if (gi) patch.gear_invoices = job.gear_invoices.map(i => ({ ...i, status: 'paid' }));
            if (job.invoice_status === 'unsent') patch.invoice_status = 'sent';
            const line = `Gear marked paid by hand ${today()}${amt ? ` (${fmtRaw$(amt)})` : ''}`;
            patch.notes = (job.notes || '').includes(line) ? (job.notes || '') : (job.notes ? `${job.notes}\n${line}` : line);
            Object.assign(job, patch);
            await store.patchJob(job.id, patch);
            sync.pushSoon(job).catch(() => {});
            toast(`Gear recorded as paid for ${job.project}.`);
          },
        }, label || `gear: ${job.gear_status === 'partial' ? 'partial' : 'UNPAID'}`);
      })()));
}

// ---------- jobs ----------
async function jobs() {
  const jobs = await store.allJobs();
  const stubs = await store.allStubs();
  const stubsByJob = {};
  for (const s of stubs) {
    if (s.matched_job_id) (stubsByJob[s.matched_job_id] ||= []).push(s);
  }
  // Group by year-month (newest first); undated jobs last.
  const groups = {};
  for (const j of jobs) (groups[j.start_date ? j.start_date.slice(0, 7) : 'none'] ||= []).push(j);
  const keys = Object.keys(groups).sort().reverse();
  const monthLabel = (k) => k === 'none' ? 'No dates'
    : new Date(k + '-02T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // Collapsible months nested inside collapsible years, each carrying its
  // income subtotal on the header so collapsed bars still tell the story.
  const openDetails = (key, set, children, extraClass = '') => {
    const det = h('details', { class: 'card mt ' + extraClass }, ...children);
    if (set.has(key)) det.setAttribute('open', '');
    det.addEventListener('toggle', () => det.open ? set.add(key) : set.delete(key));
    return det;
  };
  const monthDetails = (k) => {
    const ms = sumJobs(groups[k], stubsByJob);
    return openDetails(k, openMonths, [
      h('summary', {}, `${monthLabel(k)} (${groups[k].length})${ms.total ? ` · ${ms.est ? '~' : ''}${fmt$(ms.total)}` : ''}`),
      ...groups[k].map(j => jobRow(j, stubsByJob)),
      listTotalsLine(groups[k], stubsByJob, 'Month total'),
    ], 'inner');
  };
  const byYear = {};
  for (const k of keys) (byYear[k === 'none' ? 'none' : k.slice(0, 4)] ||= []).push(k);
  const yearKeys = Object.keys(byYear).filter(y => y !== 'none').sort().reverse();
  const cards = yearKeys.map(year => {
    const yearJobs = jobs.filter(j => j.start_date?.startsWith(year));
    const ys = sumJobs(yearJobs, stubsByJob);
    return openDetails(year, openYears, [
      h('summary', {}, `${year} — ${ys.est ? '~' : ''}${fmt$(ys.total)} (${fmt$(ys.wages)} wages · ${fmt$(ys.gear)} gear)`),
      ...byYear[year].map(monthDetails),
    ]);
  });
  if (byYear.none) cards.push(...byYear.none.map(monthDetails));

  return h('div', {},
    h('button', { class: 'primary', onclick: () => editJob(null) }, '+ Add job'),
    jobs.length ? cards : h('div', { class: 'card mt' }, h('p', { class: 'muted' }, 'Nothing yet.')),
    jobs.length ? (() => {
      const gs = sumJobs(jobs, stubsByJob);
      return h('details', { class: 'card', ...(allJobsOpen ? { open: '' } : {}), ontoggle: (e) => { allJobsOpen = e.target.open; } },
        h('summary', {}, `All jobs (${jobs.length}) — ${gs.est ? '~' : ''}${fmt$(gs.total)}`),
        jobs.map(j => jobRow(j, stubsByJob)),
        listTotalsLine(jobs, stubsByJob, 'Grand total (excl. holds)'));
    })() : null,
  );
}

function segmented(name, value, options, onChange) {
  const seg = h('div', { class: 'seg' });
  for (const [val, label] of options) {
    const b = h('button', {
      type: 'button',
      class: val === value ? `sel ${val}` : '',
      onclick: () => {
        seg.querySelectorAll('button').forEach(x => x.className = '');
        b.className = `sel ${val}`;
        onChange(val);
      },
    }, label);
    seg.append(b);
  }
  return seg;
}

const { gearUnits, calcGearTotal } = store;

const addDaysStr = store.addDays;   // timezone-proof day arithmetic

// Mini-calendar of tappable day chips for a date range. Returns the number
// of days rendered (0/1 = no picker needed).
// `paidSet` (optional): days a wage check has already paid — drawn solid
// with a $ mark, still tappable like any other day.
function fillDayChips(box, start, end, sel, counter, travelSel, paidSet, onChange) {
  box.replaceChildren();
  if (!start) return 0;
  const days = [];
  // Long shows span many weeks; 92 days covers a quarter (guards against a
  // typo'd year exploding the picker).
  for (let d = start, i = 0; d <= (end || start) && i < 92; d = addDaysStr(d, 1), i++) days.push(d);
  if (days.length < 2) { if (counter) counter.textContent = ''; return days.length; }
  const upd = () => {
    if (!counter) return;
    const t = travelSel ? [...travelSel].filter(x => sel.has(x)).length : 0;
    const pd = paidSet ? days.filter(x => paidSet.has(x)).length : 0;
    counter.textContent = `${sel.size} day${sel.size === 1 ? '' : 's'} selected`
      + (t ? ` (${t} travel)` : '')
      + (pd ? ` · ${pd} already paid ($)` : '');
  };
  const chip = (d) => {
    const dt = new Date(d + 'T00:00:00');
    let lpTimer = null, lpFired = false;
    const toggleTravel = () => {
      if (travelSel.has(d)) travelSel.delete(d);
      else {
        travelSel.add(d);
        if (!sel.has(d)) { sel.add(d); b.classList.add('on'); }
      }
      b.classList.toggle('travel', travelSel.has(d));
      upd();
      if (onChange) onChange();
    };
    const b = h('button', {
      type: 'button',
      class: 'daychip' + (sel.has(d) ? ' on' : '') + (travelSel?.has(d) ? ' travel' : '')
        + (paidSet?.has(d) ? ' paid' : ''),
      title: paidSet?.has(d) ? 'Paid by a check' : null,
      onclick: () => {
        if (lpFired) { lpFired = false; return; }   // long-press already handled
        if (sel.has(d)) {
          if (paidSet?.has(d) && travelSel
              && !confirm('A check already paid this day. Remove it from the job anyway?')) return;
          sel.delete(d);
          if (travelSel?.has(d)) { travelSel.delete(d); b.classList.remove('travel'); }
        } else sel.add(d);
        b.classList.toggle('on');
        upd();
        if (onChange) onChange();
      },
      // Travel-day marking: right-click on desktop, press-and-hold on phone.
      oncontextmenu: (e) => {
        if (!travelSel) return;
        e.preventDefault();
        // Some phones fire contextmenu after our long-press already toggled.
        if (lpFired) { lpFired = false; return; }
        toggleTravel();
      },
      onpointerdown: (e) => {
        if (!travelSel || e.button === 2) return;
        lpFired = false;
        lpTimer = setTimeout(() => { lpFired = true; toggleTravel(); }, 500);
      },
      onpointerup: () => clearTimeout(lpTimer),
      onpointerleave: () => clearTimeout(lpTimer),
      onpointercancel: () => clearTimeout(lpTimer),
    }, h('span', { class: 'dom' }, String(dt.getDate())),
      paidSet?.has(d) ? h('span', { class: 'paidmark' }, '$') : null);
    return b;
  };
  // Real calendar layout: one Sun-Sat grid per month, header row, days in
  // their weekday column, blanks for out-of-range cells.
  const byMonth = new Map();
  for (const d of days) {
    const key = d.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(d);
  }
  for (const [key, mdays] of byMonth) {
    const first = new Date(mdays[0] + 'T00:00:00');
    box.append(h('span', { class: 'daychip-month' },
      first.toLocaleDateString('en-US', { month: 'short' }) + ' ' + first.getFullYear()));
    const grid = h('div', { class: 'daycal' },
      ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(w => h('span', { class: 'dowhead' }, w)),
      ...Array.from({ length: first.getDay() }, () => h('span', {})),
      ...mdays.map(chip));
    box.append(grid);
  }
  upd();
  return days.length;
}

// Wages (actual or estimate) + gear summed over a list of jobs, holds excluded.
function sumJobs(list, stubsByJob) {
  let wages = 0, gear = 0, est = false;
  for (const j of list) {
    if (j.job_status === 'hold') continue;
    const w = jobWages(j, stubsByJob);
    if (w) { wages += w.amount; if (!w.actual) est = true; }
    const rem = wagesRemaining(j, stubsByJob[j.id]);
    if (rem) { wages += rem; est = true; }
    if (j.gear_total) gear += j.gear_total;
  }
  return { wages, gear, total: wages + gear, est };
}

// Sum line rendered under a job list.
function listTotalsLine(list, stubsByJob, label = 'Total') {
  const { wages, gear, total, est } = sumJobs(list, stubsByJob);
  if (!total) return null;
  return h('div', { class: 'job sumrow', style: 'cursor:default' },
    h('div', {},
      h('div', { class: 'title' }, label),
      h('div', { class: 'sub' }, `${est ? '~' : ''}${fmt$(wages)} wages · ${fmt$(gear)} gear`)),
    h('div', { class: 'badges', style: 'font-weight:700' }, `${est ? '~' : ''}${fmt$(total)}`));
}

// When a job goes away but its stubs (payment records) shouldn't: move them
// to another job with the same title, carrying gear-paid state along.
async function repointStubs(job) {
  const stubs = (await store.allStubs()).filter(s => s.matched_job_id === job.id);
  if (!stubs.length) return;
  // Only an EXACTLY same-named job is a candidate ("Riverton (Week 1)" is not
  // "Riverton (Week 4)"), and only if the user says so. Otherwise the records
  // stay with the removed job, where Restore brings them back.
  const nm = (v) => (v || '').trim().toLowerCase();
  if (!nm(job.project)) return;
  const target = (await store.allJobs()).find(o => o.id !== job.id && nm(o.project) === nm(job.project));
  if (!target) return;
  if (!confirm(`This job has ${stubs.length} payment record${stubs.length === 1 ? '' : 's'}. Move ${stubs.length === 1 ? 'it' : 'them'} to the other "${target.project}" job?\n\nCancel = keep them with this removed job (Restore brings them back).`)) return;
  let gearMoved = 0;
  for (const s of stubs) {
    s.matched_job_id = target.id;
    gearMoved += gearOnStub(s.earnings);
    await store.putStub(s);
  }
  if (gearMoved > 0) {
    const prior = gearReceived((await store.allStubs()).filter(s => s.matched_job_id === target.id)) - gearMoved;
    applyGearPayment(target, gearMoved, Math.max(0, prior));
    if (!target.gear_paid_via) target.gear_paid_via = stubs.find(s => s.paid_to)?.paid_to || '';
    await store.putJob(target, { silent: true });
    sync.pushSoon(target).catch(() => {});
  }
  log('stubRepoint', { n: stubs.length, to: target.project, gearMoved });
  toast(`${stubs.length} payment record${stubs.length === 1 ? '' : 's'} moved to the other "${target.project}" job.`, 4500);
}

// "Riverton" -> "Riverton (Part 2)" -> "Riverton (Part 3)" …
function nextPartName(name) {
  const m = (name || '').match(/^(.*)\(Part (\d+)\)\s*$/i);
  if (m) return `${m[1]}(Part ${parseInt(m[2], 10) + 1})`;
  return `${name || 'Job'} (Part 2)`;
}

async function editJob(existing, prefill, draft) {
  overlayOpen = true;
  // Deep copies: the form edits `job`, `base` remembers how it looked when the
  // form opened, and Save applies only the difference onto the freshest stored
  // record — a form left open while another device saved never overwrites that
  // device's work. A resumed draft replaces the form's starting values only.
  const job = draft ? draft : (existing ? JSON.parse(JSON.stringify(existing)) : (prefill || store.blankJob()));
  const base = existing ? JSON.parse(JSON.stringify(existing)) : null;
  const pristine = JSON.stringify(job);
  editorAbort?.abort();
  editorAbort = new AbortController();
  const keepDraft = () => {
    if (JSON.stringify(job) === pristine) clearDraft(); else saveDraft(job, existing?.id);
  };
  viewEl.addEventListener('input', keepDraft, { signal: editorAbort.signal });
  viewEl.addEventListener('click', () => setTimeout(keepDraft, 0), { signal: editorAbort.signal });
  let weeks = 1;
  let hourlyTouched = false;
  const input = (key, attrs = {}) => h('input', {
    value: job[key] ?? '', ...attrs,
    // Money fields: a text box with the decimal keypad, so "$955" or "1,250"
    // parse instead of silently becoming blank (Safari's number input).
    ...(attrs.type === 'number' && attrs.inputmode === 'decimal' ? { type: 'text' } : {}),
    oninput: (e) => {
      job[key] = attrs.type === 'number'
        ? (e.target.value === '' ? null : parseMoneyInput(e.target.value))
        : e.target.value;
      if (['gear_rate', 'days_worked', 'start_date', 'end_date'].includes(key)) gearHintUpdate();
      if (['start_date', 'end_date'].includes(key)) updateWorkChips();
      if (key === 'rate_hourly') hourlyTouched = true;
      if (['rate_hourly', 'rate_hours'].includes(key)) hourlyUpdate();
    },
  });

  const workSel = new Set(job.work_dates || []);
  // A job with no specific days means "the whole range". Show that as every
  // day selected, and only convert it to specific days once the user
  // actually taps a day (tapping one day used to silently turn a 5-day job
  // into a 1-day job).
  const wholeSpan = !!existing && !(job.work_dates || []).length;   // new jobs: tap the days worked, as before
  let chipsTouched = false;
  const fillSpan = () => {
    workSel.clear();
    if (!job.start_date) return;
    for (let d = job.start_date, i = 0; d <= (job.end_date || job.start_date) && i < 92; d = addDaysStr(d, 1), i++) workSel.add(d);
  };
  if (wholeSpan) fillSpan();
  const travelSel = new Set(job.travel_dates || []);
  // Days already paid by this job's wage checks — marked on the calendar.
  const paidDays = existing
    ? wageCoverage(job, (await store.allStubs()).filter(s => s.matched_job_id === job.id)).paid
    : new Set();
  const workBox = h('div', { class: 'daychips' });
  const workCounter = h('p', { class: 'muted small' }, '');
  let daysInput = null;   // assigned in the layout below
  const syncDaysInput = () => {
    if (!daysInput) return;
    const chipsInUse = workSel.size > 0 && (chipsTouched || !wholeSpan) && job.start_date && (job.end_date || job.start_date) !== job.start_date;
    daysInput.disabled = !!chipsInUse;
    daysInput.placeholder = chipsInUse ? `= ${workSel.size} selected days` : 'e.g. 2';
    if (chipsInUse) { daysInput.value = workSel.size; job.days_worked = workSel.size; }
  };
  const workWrap = h('div', {},
    h('label', {}, 'Which days were actually worked? (only these get calendar events)'),
    workBox, workCounter,
    h('p', { class: 'muted small' },
      (paidDays.size ? 'Solid with $ = paid by a check. ' : '')
      + 'Right-click a day (press and hold on phone) to mark it as a travel day — estimated at the 4-hour minimum until the stub arrives.'));
  const spanLen = () => job.start_date
    ? Math.round((new Date(job.end_date || job.start_date) - new Date(job.start_date)) / 86400000) + 1 : 0;
  const updateWorkChips = () => {
    if (spanLen() > 92) {
      // The picker shows 92 days at most; a longer job would be silently cut
      // to 92 by one tap. It stays a whole-range job instead.
      workBox.replaceChildren(h('p', { class: 'muted small' },
        `This job spans ${spanLen()} days — too long to pick days one by one. It stays a whole-range job; use Weeks to split a long show if you need per-day tracking.`));
      workCounter.textContent = '';
      workWrap.style.display = '';
      syncDaysInput();
      return;
    }
    if (wholeSpan && !chipsTouched) fillSpan();
    const n = fillDayChips(workBox, job.start_date, job.end_date, workSel, workCounter, travelSel, paidDays,
      () => { chipsTouched = true; syncDaysInput(); });
    workWrap.style.display = n > 1 ? '' : 'none';
    syncDaysInput();
  };

  const hoursInput = input('rate_hours', { type: 'number', inputmode: 'numeric', placeholder: 'other' });
  const hoursSeg = segmented('hours', String(job.rate_hours || ''),
    [['10', '10 hr'], ['12', '12 hr']],
    v => { job.rate_hours = parseInt(v, 10); hoursInput.value = v; hourlyUpdate(); });

  // Hourly-deal helper: hourly rate x guaranteed hours fills the pre-tax
  // guaranteed day total. 'straight' = hourly x hours (how the user's
  // productions quote it); 'union' = 1.5x after 8.
  let gearTouched = false;
  let hourlyMode = inferHourlyMode(job);
  const rateAmountInput = input('rate_amount', { type: 'number', inputmode: 'decimal', placeholder: '955' });
  const hourlyInput = input('rate_hourly', { type: 'number', inputmode: 'decimal', placeholder: '87' });
  const hourlyHint = h('p', { class: 'muted small' }, '');
  const hourlyUpdate = () => {
    const hr = job.rate_hourly, hrs = job.rate_hours;
    if (!hr) { hourlyHint.textContent = ''; return; }
    if (!hrs) { hourlyHint.textContent = 'Set guaranteed hours above to calculate the day total.'; return; }
    const day = hourlyMode === 'union' && hrs > 8 ? hr * (8 + 1.5 * (hrs - 8)) : hr * hrs;
    // Only an hourly rate typed in THIS session rewrites the day rate — a
    // stored hourly plus an hours tap used to replace a typed day rate.
    if (hourlyTouched || !job.rate_amount) {
      job.rate_amount = Math.round(day * 100) / 100;
      rateAmountInput.value = job.rate_amount;
    }
    hourlyHint.textContent = `= ${fmt$(job.rate_amount)} pre-tax guaranteed / day (`
      + (hourlyMode === 'union' && hrs > 8
        ? `$${hr}/hr, 1.5x after 8: 8 + ${((hrs - 8) * 1.5).toFixed(1)} paid hrs)`
        : `$${hr}/hr x ${hrs} hrs)`);
  };
  const hourlyModeSeg = segmented('hourlymode', hourlyMode,
    [['straight', 'Straight x hrs'], ['union', '1.5x after 8']],
    v => { hourlyMode = v; hourlyUpdate(); });

  // Flat fee (all-in): one total covers wages and gear; the day-rate, hourly
  // and gear fields below are ignored and a check for the total pays the job.
  const flatInput = input('flat_total', { type: 'number', inputmode: 'decimal', placeholder: 'e.g. 1800' });
  const flatWrap = h('div', {},
    h('label', {}, 'Flat fee total (wages and gear all-in)'), flatInput,
    h('p', { class: 'muted small' }, 'With a flat fee the day-rate, hourly and gear fields are ignored. Every check for this job counts toward the total.'));
  flatWrap.style.display = job.pay_type === 'flat' ? '' : 'none';
  const payTypeSeg = segmented('paytype', job.pay_type || '', [['', 'Day rate'], ['flat', 'Flat fee (all-in)']],
    v => { job.pay_type = v; flatWrap.style.display = v === 'flat' ? '' : 'none'; });
  const gearHint = h('p', { class: 'muted small' }, '');
  const gearHintUpdate = () => {
    const u = gearUnits(job);
    gearHint.textContent = job.gear_rate && u
      ? `= ${fmt$(job.gear_rate * u)} gear total for ${u} ${job.gear_period === 'week' ? 'week' : 'day'}${u === 1 ? '' : 's'} (auto-filled on save if total left blank)`
      : '';
  };
  const gearSeg = segmented('gearper', job.gear_period || 'day',
    [['day', 'Per day'], ['week', 'Per week']],
    v => { job.gear_period = v; gearHintUpdate(); });
  gearHintUpdate();
  updateWorkChips();

  // Weekly gear invoices: one per billed week, each sent/paid on its own.
  const gearInvs = (job.gear_invoices || []).map(i => ({ ...i }));
  const invBox = h('div', {});
  const renderInvs = () => {
    invBox.replaceChildren(...gearInvs.map((inv, idx) => {
      const amt = h('input', { type: 'number', inputmode: 'decimal', placeholder: 'amount $', value: inv.amount ?? '' });
      amt.addEventListener('input', e => inv.amount = e.target.value === '' ? null : parseFloat(e.target.value));
      const ds = h('input', { type: 'date', value: inv.start || '' });
      ds.addEventListener('input', e => inv.start = e.target.value);
      const de = h('input', { type: 'date', value: inv.end || '' });
      de.addEventListener('input', e => inv.end = e.target.value);
      return h('div', { class: 'ginv' },
        h('div', { class: 'ginv-head' },
          h('span', { class: 'muted small' }, `Week ${idx + 1}`),
          h('button', {
            type: 'button', class: 'inline secondary', style: 'font-size:.68rem;padding:2px 8px',
            onclick: () => { gearInvs.splice(idx, 1); renderInvs(); },
          }, 'Remove')),
        h('div', { class: 'row2' }, h('div', {}, ds), h('div', {}, de)),
        h('div', { class: 'row2' },
          h('div', {}, amt),
          h('div', {}, segmented('ginv', inv.status || 'unsent',
            [['unsent', 'Not sent'], ['sent', 'Sent'], ['paid', 'Paid']],
            v => inv.status = v))));
    }));
  };
  renderInvs();
  const genWeeks = () => {
    if (!job.start_date) return toast('Set the job dates first.');
    if (gearInvs.length && !confirm('Replace the current weekly invoices with freshly generated weeks?')) return;
    const end = job.end_date || job.start_date;
    const list = [];
    for (let s0 = job.start_date, guard = 0; s0 <= end && guard < 60; s0 = addDaysStr(s0, 7), guard++) {
      const e0 = addDaysStr(s0, 6) < end ? addDaysStr(s0, 6) : end;
      let amount = null;
      if (job.gear_rate) {
        if (job.gear_period === 'week') amount = job.gear_rate;
        else {
          const daysIn = workSel.size
            ? [...workSel].filter(d => d >= s0 && d <= e0).length
            : Math.round((new Date(e0) - new Date(s0)) / 86400000) + 1;
          amount = daysIn ? job.gear_rate * daysIn : null;
        }
      }
      list.push({ start: s0, end: e0, amount, status: 'unsent' });
    }
    gearInvs.splice(0, gearInvs.length, ...list);
    renderInvs();
  };

  const form = h('div', { class: 'card' },
    h('h2', {}, existing ? 'Edit job' : 'New job'),
    existing ? h('button', {
      class: 'secondary', style: 'margin-top:0;margin-bottom:6px',
      onclick: () => {
        // Same client and rates, fresh everything else — just set the dates.
        const clone = {
          ...store.blankJob(),
          project: nextPartName(job.project),
          company: job.company,
          rate_amount: job.rate_amount, rate_hours: job.rate_hours, rate_hourly: job.rate_hourly, rate_text: job.rate_text,
          gear_rate: job.gear_rate, gear_period: job.gear_period,
          gear_status: job.gear_status === 'na' ? 'na' : 'unpaid',
          paid_via: job.paid_via, gear_paid_via: job.gear_paid_via,
          invoice_status: job.invoice_status === 'na' ? 'na' : 'unsent',
        };
        log('duplicateJob', { from: job.project });
        toast('Duplicated — set the new dates and save.');
        editJob(null, clone);
      },
    }, 'Duplicate Job') : null,
    h('label', {}, 'Job status'),
    segmented('jobstatus', job.job_status || 'confirmed',
      [['confirmed', 'Confirmed'], ['hold', 'Hold / potential']],
      v => job.job_status = v),
    h('label', {}, 'Project / show'), input('project', { placeholder: 'e.g. Riverton' }),
    h('label', {}, 'Company (optional)'), input('company', { placeholder: 'production co / who pays' }),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'First day'), input('start_date', { type: 'date' })),
      h('div', {}, h('label', {}, 'Last day'), input('end_date', { type: 'date' }))),
    workWrap,
    h('label', {}, 'Days actually worked (optional — for owed-wages estimate)'),
    (daysInput = input('days_worked', { type: 'number', inputmode: 'numeric', placeholder: 'e.g. 2' })),
    h('label', {}, 'How is this job paid?'),
    payTypeSeg,
    flatWrap,
    existing ? null : h('div', {},
      h('label', {}, 'Weeks (multi-week job: creates Week 1, Week 2, … entries, each tracked separately)'),
      h('input', {
        type: 'number', inputmode: 'numeric', value: '1', min: '1', max: '26',
        oninput: (e) => weeks = Math.min(26, Math.max(1, parseInt(e.target.value, 10) || 1)),
      })),
    h('label', {}, 'Wages / day ($)'),
    rateAmountInput,
    h('label', {}, 'Guaranteed hours'),
    h('div', { class: 'row2' }, h('div', {}, hoursSeg), h('div', {}, hoursInput)),
    h('label', {}, 'Hourly rate ($, if the deal is quoted hourly — fills the day total above)'),
    h('div', { class: 'row2' }, h('div', {}, hourlyInput), h('div', {}, hourlyModeSeg)),
    hourlyHint,
    h('label', {}, 'Rate note (if not day rate — e.g. "scale", "$87/hr")'), input('rate_text', { placeholder: 'scale' }),
    h('label', {}, 'Wages'),
    segmented('wages', job.wages_status,
      [['unpaid', 'Unpaid'], ['partial', 'Partial'], ['paid', 'Paid']],
      v => job.wages_status = v),
    h('label', {}, 'Wages paid to'),
    segmented('paidvia', job.paid_via || '',
      [['', 'Not set'], ['me', 'Me'], ['company', 'My company']],
      v => job.paid_via = v),
    h('div', { class: 'row2 mt' },
      h('div', {}, h('label', {}, 'Gear rate ($)'), input('gear_rate', { type: 'number', inputmode: 'decimal', placeholder: '1200' })),
      h('div', {}, h('label', {}, 'Rate is'), gearSeg)),
    h('label', {}, 'Gear total ($, or leave blank to auto-fill from rate)'),
    input('gear_total', { type: 'number', inputmode: 'decimal' }),
    gearHint,
    h('label', {}, 'Gear payment'),
    segmented('gear', job.gear_status,
      [['na', 'No gear'], ['unpaid', 'Unpaid'], ['partial', 'Partial'], ['paid', 'Paid']],
      v => { job.gear_status = v; gearTouched = true; }),
    h('label', {}, 'Gear paid to (can differ from wages)'),
    segmented('gearpaidvia', job.gear_paid_via || '',
      [['', 'Same as wages / not set'], ['me', 'Me'], ['company', 'My company']],
      v => job.gear_paid_via = v),
    h('label', {}, 'Weekly gear invoices (jobs billing gear per week — each week tracks its own sent / paid)'),
    invBox,
    h('div', { class: 'row2' },
      h('div', {}, h('button', {
        type: 'button', class: 'secondary',
        onclick: () => {
          gearInvs.push({ start: '', end: '', amount: job.gear_period === 'week' ? job.gear_rate : null, status: 'unsent' });
          renderInvs();
        },
      }, '+ Add week')),
      h('div', {}, h('button', { type: 'button', class: 'secondary', onclick: genWeeks }, 'Generate weeks from dates'))),
    h('p', { class: 'muted small' },
      'Leave empty for single-invoice gear. With weeks set, gear status and total derive from the weeks, each week is owed once it ends, and the invoice reminder covers unsent weeks.'),
    h('label', {}, 'Invoice sent? ("Not sent" sets a calendar reminder that emails you until you flip it)'),
    segmented('invoice', job.invoice_status || 'na',
      [['na', 'No invoice'], ['unsent', 'Not sent'], ['sent', 'Sent']],
      v => job.invoice_status = v),
    h('label', {}, `Expect payment by (blank = wrap + ${settings().alertDaysWages}d wages / +${settings().alertDaysGear}d gear)`),
    input('expected_pay_date', { type: 'date' }),
    h('label', {}, 'Notes'), h('textarea', {
      oninput: (e) => job.notes = e.target.value,
    }, job.notes || ''),
    h('button', {
      class: 'primary', onclick: async () => {
        if (!job.project && !job.notes) return toast('Give the job at least a name.');
        if (job.end_date && job.start_date && job.end_date < job.start_date) job.end_date = job.start_date;
        if (weeks > 1 && !job.start_date) return toast('Multi-week jobs need a first day (of week 1).');
        if (weeks > 1 && job.end_date && Math.round((new Date(job.end_date) - new Date(job.start_date)) / 86400000) > 6) {
          return toast('With Weeks set, enter the dates of week 1 only (first to last day within 7 days) — the other weeks are generated from it.', 6000);
        }
        if (job.gear_status === 'na' && (job.gear_rate || job.gear_total) && !gearTouched) job.gear_status = 'unpaid';
        job.gear_invoices = gearInvs.filter(i => i.amount || i.start || i.end);
        if (job.gear_invoices.length) {
          // Weekly billing: status and total derive from the weeks.
          const p = job.gear_invoices.filter(i => i.status === 'paid').length;
          job.gear_status = p === job.gear_invoices.length ? 'paid' : p ? 'partial' : 'unpaid';
          const invSum = job.gear_invoices.reduce((s, i) => s + (i.amount || 0), 0);
          if (invSum) job.gear_total = invSum;
        }

        if (job.pay_type === 'flat') {
          // No wages/gear split on a flat fee: those fields are cleared so no
          // screen estimates from them.
          job.rate_amount = null; job.rate_hourly = null; job.gear_total = null; job.gear_rate = null;
          job.gear_status = 'na'; job.gear_invoices = [];
          if (!(job.flat_total > 0)) return toast('Enter the flat fee total.');
        }
        const chosenDays = [...workSel]
          .filter(d => job.start_date && d >= job.start_date && d <= (job.end_date || job.start_date))
          .sort();
        if (wholeSpan && !chipsTouched) {
          // Untouched whole-range job: stays whole-range, typed day count kept.
          job.work_dates = [];
          job.travel_dates = [];
        } else {
          job.work_dates = chosenDays;
          job.travel_dates = chosenDays.filter(d => travelSel.has(d));
          // The chips are the day count; clearing them all drops a stale count.
          if (chosenDays.length) job.days_worked = chosenDays.length;
          else if ((existing?.work_dates || []).length) job.days_worked = null;
        }
        const chosenForClones = job.work_dates;

        const toSave = [];
        if (!existing && weeks > 1) {
          toSave.push(...cloneWeeks({ ...job, work_dates: chosenForClones }, weeks, store.uid, addDaysStr));
        } else {
          toSave.push(job);
        }
        for (const j of toSave) {
          calcGearTotal(j);
          const saved = base && j.id === base.id ? await store.updateJob(j.id, j, base) : await store.putJob(j);
          sync.pushSoon(saved).catch(e => { if (e.code !== 'NEEDS_CONNECT') toast('Calendar sync: ' + e.message, 5000); });
        }
        editorAbort?.abort();
        clearDraft();
        toast(toSave.length > 1 ? `Saved ${toSave.length} weekly entries.` : 'Saved.');
        render('jobs');
      },
    }, 'Save job'),
    existing ? h('button', {
      class: 'secondary', onclick: async () => {
        if (!confirm('Remove this job from the app but KEEP its calendar event?')) return;
        log('jobRemoved', { project: job.project, mode: 'app-only' });
        await repointStubs(job);
        job.deleted = true;
        // keep_cal: the deleted-job sweep must leave this job's events alone.
        job.keep_cal = true;
        job.calendar_event_id = '';
        job.calendar_event_ids = [];
        clearDraft();
        await store.patchJob(job.id, { deleted: true, keep_cal: true, calendar_event_id: '', calendar_event_ids: [] });
        sync.pushSoon(job).catch(() => {});  // clears reminders only
        toast('Removed from the app; calendar untouched.');
        render('jobs');
      },
    }, 'Remove from app (keep calendar event)') : null,
    existing ? h('button', {
      class: 'danger', onclick: async () => {
        if (!confirm('Delete this job AND its calendar event?')) return;
        log('jobRemoved', { project: job.project, mode: 'full' });
        await repointStubs(job);
        job.deleted = true;
        clearDraft();
        await store.patchJob(job.id, { deleted: true });
        sync.pushSoon(job).catch(() => {});
        render('jobs');
      },
    }, 'Delete job + calendar event') : null,
    h('button', { class: 'secondary', onclick: () => { clearDraft(); render('jobs'); } }, 'Cancel'),
  );
  // Per-job breakdown so the math can be checked at a glance.
  let breakdown = null;
  if (existing) {
    const stubs = (await store.allStubs()).filter(s => s.matched_job_id === job.id)
      .sort((a, b) => (a.check_date || '').localeCompare(b.check_date || ''));
    const rate$ = (r) => hideMoney ? MASK : `$${Number(r).toFixed(2)}`;
    const rows = stubs.filter(s => s.gross !== null && s.gross !== undefined).map(s => {
      const gearPart = gearOnStub(s.earnings);
      const dsum = (s.deductions || []).reduce((a, d) => a + (d.amount || 0), 0) || (s.total_deductions || 0);
      const dayList = (s.work_dates || []).map(d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`).join(', ');
      const review = (!s.check_no || s.gross === null || s.gross === undefined || !s.vendor) ? ' · needs review' : '';
      return { label: `Check #${s.check_no || '—'}${s.check_date ? ' · ' + s.check_date : ''}${s.memo ? ' · ' + s.memo : ''}${dayList ? ' · days ' + dayList : ''}${review}`,
        gross: s.gross, gear: gearPart, wages: Math.max(0, s.gross - gearPart),
        hours: s.hours, net: s.net, dsum, dedItems: s.deductions || [],
        // Pay lines (ST/OT/per diem…) — split-check halves have no detail.
        earnItems: (s.earnings || []).filter(e => e.amount && !/\(split\)/.test(e.type || '')) };
    });
    const wagesActual = rows.reduce((a, r) => a + r.wages, 0);
    const cov = wageCoverage(job, stubs);
    // Weekly-paid jobs: once checks track their days, estimate only the
    // days no check has paid yet.
    const remaining = wagesRemaining(job, stubs) || null;
    const est = !wagesActual ? estWages(job) : null;
    const wages = wagesActual || est || 0;
    const total = wages + (remaining || 0) + (job.gear_total || 0);
    // Pay summary across all checks: hours (and OT share) and the base rate.
    let hrsAll = 0, hrsOT = 0;
    for (const s of stubs) {
      for (const e of s.earnings || []) {
        if (!e.hours) continue;
        if (/per\s*diem|meal|allow/i.test(e.type || '')) continue;
        hrsAll += e.hours;
        if (/over|o\.?t\b|double|time.and/i.test(e.type || '')) hrsOT += e.hours;
      }
    }
    const baseRates = [...new Set(stubs.map(s => baseRateOf(s)).filter(Boolean))];
    const summary = [
      hrsAll ? `${Math.round(hrsAll * 100) / 100} hrs on checks${hrsOT ? ` (${Math.round(hrsOT * 100) / 100} OT)` : ''}` : '',
      baseRates.length ? `base rate ${baseRates.map(rate$).join(' / ')}/hr` : '',
      cov.tracked ? `paid days ${cov.paidOnJob} of ${cov.total}` : '',
    ].filter(Boolean).join(' · ');
    if (rows.length || total) {
      breakdown = h('div', { class: 'card' },
        h('h2', {}, 'Breakdown — per check'),
        summary ? h('p', { class: 'muted small', style: 'margin-top:0' }, summary) : null,
        rows.map(r => h('div', { class: 'job', style: 'cursor:default;display:block' },
          h('div', { class: 'title' }, r.label),
          h('div', { class: 'sub' }, [
            r.hours ? `${r.hours} hrs` : '',
            `gross ${fmt$(r.gross)}`,
            r.gear ? `gear ${fmt$(r.gear)}` : '',
            r.wages && r.gear ? `wages ${fmt$(r.wages)}` : '',
            r.dsum ? `deductions ${fmt$(r.dsum)}` : '',
            r.net !== null && r.net !== undefined ? `net ${fmt$(r.net)}` : '',
          ].filter(Boolean).join(' · ')),
          r.earnItems.length ? h('div', { class: 'sub', style: 'opacity:.8' },
            r.earnItems.map(e => `${e.type}${e.hours ? ` ${e.hours}h` : ''}${e.rate ? ` @ ${rate$(e.rate)}` : ''} ${fmt$(e.amount)}`).join(' · ')) : null,
          r.dedItems.length ? h('div', { class: 'sub', style: 'opacity:.8' },
            r.dedItems.map(d => `${d.type} ${fmt$(d.amount)}`).join(' · ')) : null)),
        h('table', { class: 'tot', style: 'margin-top:8px' },
          h('tr', {}, h('td', {}, `Wages${wagesActual ? (remaining ? ' paid so far' : '') : est ? ' (estimate)' : ''}`),
            h('td', {}, `${wagesActual ? '' : est ? '~' : ''}${fmt$(wages || null)}`)),
          remaining ? h('tr', {}, h('td', {}, `Still to come (${cov.unpaid.length} day${cov.unpaid.length === 1 ? '' : 's'}, estimated)`),
            h('td', {}, `~${fmt$(remaining)}`)) : null,
          h('tr', {}, h('td', {}, `Gear (${job.gear_status})`), h('td', {}, fmt$(job.gear_total))),
          h('tr', { class: 'sum' }, h('td', {}, 'TOTAL'),
            h('td', {}, `${(wagesActual && !remaining) ? '' : (est || remaining) ? '~' : ''}${fmt$(total || null)}`))));
    }
  }
  viewEl.replaceChildren(...(breakdown ? [breakdown] : []), form);
  viewEl.scrollTop = 0;
}

// ---------- totals ----------
let totalsYear = new Date().getFullYear();
let totalsOpen = false;
let paycheckYear = new Date().getFullYear();
let paycheckOpen = false;

// Quick-glance paycheck rollup from stub records: what was paid, when, how
// many hours, and what was deducted — by month, with a per-type year total.
// Collapsed by default.
function paychecksCard(stubs, jobsAll = []) {
  // Same population as the Year totals: checks on live, non-hold jobs.
  const live = new Set(jobsAll.filter(j => j.job_status !== 'hold').map(j => j.id));
  const dated = stubs.filter(s => s.check_date && (!jobsAll.length || !s.matched_job_id || live.has(s.matched_job_id)));
  if (!dated.length) return null;
  const years = [...new Set(dated.map(s => s.check_date.slice(0, 4)))].sort().reverse();
  if (!years.includes(String(paycheckYear))) paycheckYear = Number(years[0]);
  const ys = dated.filter(s => s.check_date.startsWith(String(paycheckYear)));
  const months = {};
  const typeTotals = {};
  const tot = { checks: 0, hours: 0, gross: 0, ded: 0, net: 0 };
  for (const s of ys) {
    const m = s.check_date.slice(0, 7);
    const row = months[m] ||= { checks: 0, hours: 0, gross: 0, ded: 0, net: 0 };
    const dsum = (s.deductions || []).reduce((a, d) => a + (d.amount || 0), 0) || (s.total_deductions || 0);
    row.checks++; row.hours += s.hours || 0; row.gross += s.gross || 0; row.ded += dsum; row.net += s.net || 0;
    tot.checks++; tot.hours += s.hours || 0; tot.gross += s.gross || 0; tot.ded += dsum; tot.net += s.net || 0;
    for (const d of s.deductions || []) {
      if (d.amount) typeTotals[d.type || 'other'] = (typeTotals[d.type || 'other'] || 0) + d.amount;
    }
  }
  const monthKeys = Object.keys(months).sort();
  const mName = (m) => new Date(m + '-02T00:00:00').toLocaleString('en-US', { month: 'short' });
  const cell = (v, money = true) => v ? (money ? fmt$(v) : String(v)) : '—';
  const det = h('details', { class: 'card' },
    h('summary', {}, `Paychecks — hours & deductions — ${paycheckYear}`),
    years.length > 1 ? h('div', { class: 'seg', style: 'margin-bottom:12px' },
      years.map(y => h('button', {
        class: String(paycheckYear) === y ? 'sel' : '',
        onclick: () => { paycheckYear = Number(y); paycheckOpen = true; render('home'); },
      }, y))) : null,
    h('table', { class: 'tot' },
      h('tr', {}, h('th', {}, 'Check'), h('th', {}, 'Hours'),
        h('th', {}, 'Gross'), h('th', {}, 'Deducted'), h('th', {}, 'Net')),
      // Every individual check listed under its month, with month subtotals.
      monthKeys.flatMap(m => [
        ...ys.filter(s => s.check_date.startsWith(m))
          .sort((a, b) => a.check_date.localeCompare(b.check_date))
          .map(s => {
            const dsum = (s.deductions || []).reduce((a, d) => a + (d.amount || 0), 0) || (s.total_deductions || 0);
            return h('tr', {},
              h('td', {}, `${mName(m)} ${Number(s.check_date.slice(8, 10))} · #${s.check_no || '—'}`),
              h('td', {}, cell(s.hours, false)), h('td', {}, cell(s.gross)),
              h('td', {}, cell(dsum)), h('td', {}, cell(s.net)));
          }),
        months[m].checks > 1 ? h('tr', { class: 'sum' },
          h('td', {}, `${mName(m)} total`),
          h('td', {}, cell(months[m].hours, false)), h('td', {}, cell(months[m].gross)),
          h('td', {}, cell(months[m].ded)), h('td', {}, cell(months[m].net))) : null,
      ]),
      h('tr', { class: 'sum' },
        h('td', {}, `Year (${tot.checks} checks)`), h('td', {}, cell(tot.hours, false)),
        h('td', {}, cell(tot.gross)), h('td', {}, cell(tot.ded)), h('td', {}, cell(tot.net)))),
    Object.keys(typeTotals).length ? h('div', {},
      h('h2', { style: 'margin-top:16px' }, 'Deductions by type'),
      h('table', { class: 'tot' },
        Object.entries(typeTotals).sort((a, b) => b[1] - a[1]).map(([t, v]) => h('tr', {},
          h('td', {}, t), h('td', {}, fmt$(v)))))) : null,
  );
  if (paycheckOpen) det.setAttribute('open', '');
  det.addEventListener('toggle', () => { paycheckOpen = det.open; });
  return det;
}

// Jobs page fold state: current month + year start open, the past starts folded.
const openMonths = new Set([today().slice(0, 7)]);
const openYears = new Set([String(new Date().getFullYear())]);

// Actual stub gross when paystubs are matched to the job; rate × days otherwise.



// Plain-language explanation of what a job owes and why (owed screen).
function owedDetail(j, stubsByJob) {
  const ss = stubsByJob[j.id] || [];
  const o = owedFor(j, stubsByJob);
  const due = sync.jobDueDates(j);
  const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
  const listDays = (ds) => ds.length <= 8 ? ds.map(md).join(', ')
    : `${ds.slice(0, 8).map(md).join(', ')} +${ds.length - 8} more`;
  const checks = ss.filter(st => (st.gross || 0) - gearOnStub(st.earnings) > 0).length;
  const lines = [];
  let late = false;
  if (j.wages_status !== 'paid' && (o.wages > 0 || isWrapped(j))) {
    const cov = wageCoverage(j, ss);
    if (isFlat(j)) {
      const w = jobWages(j, stubsByJob);
      const got = w && w.actual ? w.amount : 0;
      lines.push(`Flat fee ${fmt$(j.flat_total)}${got ? `, ${fmt$(got)} received on checks so far` : ', nothing received yet'} → ${fmt$(o.wages)} owed.`);
    } else if (cov.tracked) {
      const past = cov.unpaid.filter(d => d <= today());
      const later = cov.unpaid.length - past.length;
      if (past.length) {
        const travel = past.filter(d => (j.travel_dates || []).includes(d)).length;
        const how = !j.rate_amount ? 'no day rate on the job, so no amount'
          : travel ? `${past.length - travel} at ${fmt$(j.rate_amount)}/day + ${travel} travel day${travel === 1 ? '' : 's'} at the 4-hour minimum = ${fmt$(o.wages)}`
            : `× ${fmt$(j.rate_amount)}/day = ${fmt$(o.wages)}`;
        lines.push(`Wages: ${past.length} worked day${past.length === 1 ? '' : 's'} no check has covered yet (${listDays(past)}) ${how}.`);
      }
      lines.push(`Paid so far: ${cov.paidOnJob} of ${cov.total} days, by ${checks} check${checks === 1 ? '' : 's'}.`
        + (later ? ` ${later} later day${later === 1 ? '' : 's'} not worked yet (not counted as owed).` : ''));
    } else if (o.wages > 0) {
      const days = jobDays(j);
      const est = estWages(j);
      const w = jobWages(j, stubsByJob);
      const got = w && w.actual ? w.amount : 0;
      const travel = Math.min((j.travel_dates || []).length, days);
      const basis = `${days} day${days === 1 ? '' : 's'} at ${fmt$(j.rate_amount)}/day${travel ? ` (${travel} travel at the 4-hour minimum)` : ''} = ${fmt$(est)}`;
      lines.push(got
        ? `Wages: estimate ${basis}; ${fmt$(got)} received on checks so far → ${fmt$(o.wages)} still owed.`
        : `Wages: job wrapped ${md(j.end_date || j.start_date)} and no wage check is on file yet. Estimate: ${basis}.`);
    } else if (checks) {
      lines.push('Wages: partly paid, but the checks on file don\'t record which days they covered — open the job to check what\'s left.');
    } else {
      lines.push('Wages: not marked paid, but the amount is unknown (no day rate on the job) — open it to add one.');
    }
    if (due.wages) {
      late = late || due.wages < today();
      lines.push(`Expected by ${md(due.wages)}${due.wages < today() ? ' — LATE' : ''}.`);
    }
  }
  if (o.gear > 0) {
    const gi = gearInv(j);
    if (gi) {
      for (const inv of gi.dueNow) {
        lines.push(`Gear: week ${md(inv.start || inv.end)}–${md(inv.end || inv.start)} invoice ${fmt$(inv.amount)} (${inv.status === 'sent' ? 'invoice sent' : 'invoice NOT sent'}), not paid yet.`);
      }
    } else {
      const got = gearReceived(ss);
      lines.push(`Gear: ${fmt$(j.gear_total)} stated for this job${got ? `, ${fmt$(got)} received so far` : ', nothing received yet'} → ${fmt$(o.gear)} owed.`);
    }
    if (due.gear) {
      late = late || due.gear < today();
      lines.push(`Gear expected by ${md(due.gear)}${due.gear < today() ? ' — LATE' : ''}.`);
    }
  }
  return { owed: o, total: o.wages + o.gear, lines, late };
}

// The owed screen: every job that owes money (optionally one month's), the
// amount, and why. Opened from the Home owed figures.
async function showOwed(month) {
  overlayOpen = true;
  const jobsAll = (await store.allJobs()).filter(j => j.job_status !== 'hold');
  const stubsByJob = {};
  for (const st of await store.allStubs()) if (st.matched_job_id) (stubsByJob[st.matched_job_id] ||= []).push(st);
  // A month's list = the jobs with unpaid work in that month.
  const evs = owedEvents(jobsAll, stubsByJob);
  const inMonth = month ? new Set(evs.filter(e => e.m === month).map(e => e.job)) : null;
  // The month's share of a job's owed money (the figure tapped on Home).
  const portion = (jid) => Math.round(evs.filter(e => e.m === month && e.job === jid).reduce((a, e) => a + e.amt, 0) * 100) / 100;
  const owing = jobsAll
    .filter(j => !inMonth || inMonth.has(j.id))
    .map(j => ({ j, d: owedDetail(j, stubsByJob), part: month ? portion(j.id) : null }))
    .filter(x => x.d.lines.length)
    .sort((a, b) => (b.d.late - a.d.late) || (b.d.total - a.d.total));
  const total = owing.reduce((a, x) => a + (month ? x.part : x.d.total), 0);
  const label = month
    ? new Date(month + '-02T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' })
    : 'All jobs';
  viewEl.replaceChildren(h('div', { class: 'card' },
    h('h2', {}, `Owed — ${label}`),
    h('p', { class: 'muted small', style: 'margin-top:0' },
      owing.length ? `${fmt$(total)} across ${owing.length} job${owing.length === 1 ? '' : 's'}. Estimates use the job's day rate until a check arrives.`
        : 'Nothing owed.'),
    owing.map(({ j, d, part }) => h('div', { class: 'job', style: 'display:block', onclick: () => render('jobs').then(() => editJob(j)) },
      h('div', { style: 'display:flex;justify-content:space-between;gap:8px' },
        h('div', { class: 'title' }, j.project || '(untitled)'),
        h('div', { class: 'title', style: `white-space:nowrap;${d.late ? 'color:var(--bad)' : ''}` },
          month && part !== d.total ? `~${fmt$(part)} of ${fmt$(d.total)}` : (d.total ? `~${fmt$(d.total)}` : '?'))),
      h('div', { class: 'sub' }, fmtRange(j.start_date, j.end_date)),
      d.lines.map(l => h('div', { class: 'sub', style: `margin-top:4px;${/LATE/.test(l) ? 'color:var(--bad)' : ''}` }, l)))),
    h('button', { class: 'secondary', onclick: () => render('home') }, '← Back')));
  viewEl.scrollTop = 0;
}



// Year totals, rendered as a collapsible card on Home.
function totalsCard(jobsAll, stubsByJob) {
  const jobs = jobsAll.filter(j => j.start_date);
  const years = [...new Set(jobs.map(j => j.start_date.slice(0, 4)))].sort().reverse();
  if (years.length && !years.includes(String(totalsYear))) totalsYear = Number(years[0]);

  // One ledger for every row: paid money in the month it was PAID, owed money
  // in the month the work was done (estimated). The Year row is the sum of
  // the month rows by construction — three screens used to disagree.
  const months = {};
  const acc = { wagesPaid: 0, wagesDue: 0, gearPaid: 0, gearDue: 0 };
  const yr = String(totalsYear);
  const live = jobs.filter(x => x.job_status !== 'hold');
  const row = (m) => months[m] ||= { wages: 0, gear: 0, owedW: 0, owedG: 0 };
  for (const e of paidEvents(live, stubsByJob).filter(x => x.m.startsWith(yr))) {
    const r = row(e.m);
    if (e.kind === 'wages') { r.wages += e.amt; acc.wagesPaid += e.amt; } else { r.gear += e.amt; acc.gearPaid += e.amt; }
  }
  for (const e of owedEvents(live, stubsByJob).filter(x => x.m.startsWith(yr))) {
    const r = row(e.m);
    if (e.kind === 'wages') { r.owedW += e.amt; acc.wagesDue += e.amt; } else { r.owedG += e.amt; acc.gearDue += e.amt; }
  }
  const estimated = live.filter(j => j.start_date.startsWith(yr) && owedFor(j, stubsByJob).wages > 0).length;
  const noAmount = live.filter(j => j.start_date.startsWith(yr) && !jobWages(j, stubsByJob) && !(stubsByJob[j.id] || []).length).length;
  const monthKeys = Object.keys(months).sort();
  const monthName = (m) => new Date(m + '-02T00:00:00').toLocaleString('en-US', { month: 'short' });
  const yearSeg = h('div', { class: 'seg', style: 'margin-bottom:12px' },
    years.map(y => h('button', {
      class: String(totalsYear) === y ? 'sel' : '',
      onclick: () => { totalsYear = Number(y); totalsOpen = true; render('home'); },
    }, y)));

  const details = h('details', { class: 'card' },
    h('summary', {}, `Year totals — ${totalsYear}`),
    years.length > 1 ? yearSeg : null,
    h('div', {},
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat ok' },
          h('div', { class: 'num' }, fmt$(acc.wagesPaid)),
          h('div', { class: 'lbl' }, 'wages paid')),
        h('div', { class: 'stat ok' },
          h('div', { class: 'num' }, fmt$(acc.gearPaid)),
          h('div', { class: 'lbl' }, 'gear paid'))),
      h('div', { class: 'stat-row mt' },
        h('div', { class: 'stat ' + (acc.wagesDue ? 'bad' : '') },
          h('div', { class: 'num' }, fmt$(acc.wagesDue)),
          h('div', { class: 'lbl' }, 'wages still owed')),
        h('div', { class: 'stat ' + (acc.gearDue ? 'bad' : '') },
          h('div', { class: 'num' }, fmt$(acc.gearDue)),
          h('div', { class: 'lbl' }, 'gear still owed'))),
      h('h2', { class: 'mt', style: 'margin-top:16px' }, 'By month'),
      monthKeys.length ? h('table', { class: 'tot' },
        h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Wages'), h('th', {}, 'Gear'), h('th', {}, 'Total')),
        monthKeys.map(m => {
          const r = months[m];
          const cell = (paid, owed) => (paid + owed) ? `${owed ? '~' : ''}${fmt$(paid + owed)}` : '—';
          return h('tr', {},
            h('td', {}, monthName(m)),
            h('td', {}, cell(r.wages, r.owedW)),
            h('td', {}, cell(r.gear, r.owedG)),
            h('td', {}, cell(r.wages + r.gear, r.owedW + r.owedG)));
        }),
        h('tr', { class: 'sum' },
          h('td', {}, 'Year'),
          h('td', {}, fmt$(acc.wagesPaid + acc.wagesDue)),
          h('td', {}, fmt$(acc.gearPaid + acc.gearDue)),
          h('td', {}, fmt$(acc.wagesPaid + acc.wagesDue + acc.gearPaid + acc.gearDue))))
        : h('p', { class: 'muted' }, 'Nothing recorded for this year.'),
      h('p', { class: 'muted small mt' }, 'Paid money sits in the month the check is dated; ~ marks a month that also carries money still owed for work done then (estimated).'),
      (estimated || noAmount) ? h('p', { class: 'muted small mt' },
        [estimated ? `${estimated} job${estimated === 1 ? '' : 's'} still owe wages (estimated at the day rate).` : '',
          noAmount ? `${noAmount} job${noAmount === 1 ? '' : 's'} with no amounts not included.` : ''].filter(Boolean).join(' ')) : null),
  );
  if (totalsOpen) details.setAttribute('open', '');
  details.addEventListener('toggle', () => { totalsOpen = details.open; });
  return details;
}

// ---------- paystub ----------
let stubFile = null;
let stubPreviewUrl = null, stubPreviewFor = null;

async function stub() {
  const onPick = (e) => {
    stubFile = e.target.files[0] || null;
    render('stub');
  };
  // Two hidden inputs behind clearly labeled buttons. `capture` jumps
  // straight to the camera on phones AND restricts the Mac file dialog, so
  // the file-picker input must not have it (and no accept filter either —
  // some pickers grey out HEIC/PDF regardless of what the filter says).
  const cameraInput = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment',
    style: 'display:none', onchange: onPick,
  });
  const libraryInput = h('input', { type: 'file', style: 'display:none', onchange: onPick });
  const connected = auth.isConnected() || auth.hasCredentials();

  const card = h('div', { class: 'card' },
    h('h2', {}, 'Scan a paystub'),
    h('p', { class: 'muted' }, settings().keepScans === false
      ? 'Photograph the stub (flat, well lit). It is read with Google OCR and matched to your jobs — the photo itself is never stored, only the extracted details. You confirm everything before it counts.'
      : 'Photograph the stub (flat, well lit). It is read with Google OCR and matched to your jobs — the photo and its text are kept in a private "PayTrack Scans" folder in YOUR Drive for troubleshooting (turn off in Setup). You confirm everything before it counts.'),
    cameraInput, libraryInput,
    // On a phone the camera shot lives only in this page (iOS can drop the
    // app while the camera is up), so the Photos route is the primary one.
    h('div', { class: 'row2 mt' }, (() => {
      const cam = h('button', { class: 'secondary', style: 'margin-top:0', onclick: () => cameraInput.click() },
        isPhone() ? 'Take a photo (not saved to Photos)' : 'Take a photo');
      const lib = h('button', { class: isPhone() ? 'primary' : 'secondary', style: 'margin-top:0', onclick: () => libraryInput.click() },
        isPhone() ? 'Choose from Photos / Files' : 'Choose a file…');
      return isPhone() ? [lib, cam] : [cam, lib];
    })()),
    h('p', { class: 'muted small mt' }, '…or drag a photo onto this box.'),
    h('div', {},
      stubFile ? h('img', { class: 'stub-preview', src: (() => {
        if (stubFile !== stubPreviewFor) {
          if (stubPreviewUrl) URL.revokeObjectURL(stubPreviewUrl);
          stubPreviewUrl = URL.createObjectURL(stubFile); stubPreviewFor = stubFile;
        }
        return stubPreviewUrl;
      })() }) : null,
      stubFile ? h('button', {
        class: 'primary', onclick: () => runStubPipeline(stubFile),
      }, connected ? 'Scan & match' : 'Scan (connect Google in Setup first)') : null,
      h('button', { class: 'secondary', onclick: () => confirmStubForm(blankParse(), null) },
        'Enter a stub manually instead'),
      (() => {
        // A scan that never finished saving can be picked back up — no
        // re-photographing after an error.
        const pend = pendingScan();
        if (!pend) return null;
        const when = new Date(pend.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        return h('div', { class: 'mt' },
          h('button', {
            class: 'secondary', style: 'margin-top:0',
            onclick: () => confirmStubForm({ ...parseStub(pend.text || ''), ...(pend.edits || {}) }, pend.text),
          }, `Resume last scan (${when})`),
          ' ',
          h('a', {
            href: '#', class: 'muted small',
            onclick: (e) => { e.preventDefault(); clearPendingScan(); render('stub'); },
          }, 'discard'));
      })()),
  );
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.borderColor = 'var(--accent)'; });
  card.addEventListener('dragleave', () => { card.style.borderColor = ''; });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.style.borderColor = '';
    const f = e.dataTransfer.files?.[0];
    if (f) { stubFile = f; render('stub'); }
  });
  return h('div', {}, card);
}

// Google's image-to-Doc OCR conversion rejects large files (~2MB cap) and
// some phone formats (HEIC), so shrink + re-encode to JPEG in the browser.
async function normalizeImage(file, maxDim = 2200, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    let blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size > 1900000) {
      blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.6));
    }
    return blob || file;
  } catch {
    return file;   // e.g. PDFs — upload as-is
  }
}

// Layout capture: word-level text POSITIONS via Tesseract (loaded on demand
// from CDN, runs entirely in the browser — no API, no cost). Drive's OCR
// gives better text but flat; the layout json records template geometry.
let tessPromise = null;
function loadTesseract() {
  if (!tessPromise) {
    tessPromise = new Promise((res, rej) => {
      const s = document.createElement('script');
      // Exact version + integrity hash: this third-party code runs in the
      // page that holds the Google token, so it must be the file we vetted.
      s.src = TESS.lib;
      s.integrity = TESS.libHash;
      s.crossOrigin = 'anonymous';
      s.onload = () => res(window.Tesseract);
      s.onerror = () => { tessPromise = null; rej(new Error('layout library failed to load')); };
      document.head.appendChild(s);
    });
  }
  return tessPromise;
}
const TESS = {
  lib: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  libHash: 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F',
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
  langPath: 'https://tessdata.projectnaptha.com/4.0.0',
};
async function captureLayout(blob) {
  const T = await loadTesseract();
  const worker = await T.createWorker('eng', 1, { workerPath: TESS.workerPath, corePath: TESS.corePath, langPath: TESS.langPath });
  try {
    const { data } = await worker.recognize(blob);
    const words = (data.words || []).map(w => ({
      t: w.text, c: Math.round(w.confidence || 0),
      x0: w.bbox?.x0, y0: w.bbox?.y0, x1: w.bbox?.x1, y1: w.bbox?.y1,
    }));
    return JSON.stringify({ v: 1, words });
  } finally { await worker.terminate(); }
}

// The extracted text survives until the record is saved — a crash or sync
// error mid-flow must never cost a re-photograph.
function pendingScan() {
  try {
    const p = JSON.parse(localStorage.getItem('paytrack.pendingScan') || 'null');
    return p && Date.now() - p.t < 48 * 3600000 ? p : null;
  } catch { return null; }
}
function clearPendingScan() { try { localStorage.removeItem('paytrack.pendingScan'); } catch {} stubFile = null; }
// Typed corrections on the confirm form ride along with the pending scan, so
// a reload mid-confirm resumes with them instead of the raw parse.
function savePendEdits(p) {
  try {
    const pend = JSON.parse(localStorage.getItem('paytrack.pendingScan') || 'null');
    if (!pend) return;
    const edits = {};
    for (const k of ['employer', 'project_name', 'payee', 'paid_to', 'period_start', 'period_end', 'gross', 'net', 'check_no', 'check_date', 'memo', 'job_title', 'day_count', 'hours', 'hourly_rates']) {
      if (p[k] !== undefined) edits[k] = p[k];
    }
    edits.earnings = p.earnings; edits.deductions = p.deductions;
    localStorage.setItem('paytrack.pendingScan', JSON.stringify({ ...pend, edits }));
  } catch {}
}

async function runStubPipeline(file) {
  overlayOpen = true;
  scanInFlight = true;
  const startGen = renderGen;
  if (!auth.hasCredentials()) { scanInFlight = false; toast('Connect Google in Setup first.'); return; }
  const stage = h('span', {}, ' Starting…');
  viewEl.replaceChildren(h('div', { class: 'card center' }, h('span', { class: 'spinner' }, '…'), stage));
  const setStage = (t) => { stage.textContent = ' ' + t; };
  try {
    // Refresh the token NOW, while we're still inside the user's tap —
    // Google's consent popup can only open from a gesture (esp. iPhone PWA),
    // so a mid-pipeline expiry used to kill the whole scan.
    setStage('Checking Google connection…');
    await auth.ensureFresh();   // a 20-60 s upload must not outlive the token
    await auth.token();
    setStage('Preparing photo…');
    const img = file.type === 'application/pdf' ? file : await normalizeImage(file);
    const keep = !!settings().keepScans;
    const ext = img.type === 'application/pdf' ? 'pdf' : 'jpg';
    const hhmm = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    let nm = `${store.today()} ${hhmm} ${(file.name || 'scan').replace(/\.\w+$/, '')}.${ext}`;
    let photoId = null;
    let text;
    try {
      if (keep) {
        // One upload: the archived photo itself is OCR'd (Drive copies it as
        // a Doc) — a second multi-MB upload on cellular used to be the norm.
        setStage('Uploading photo to your Drive…');
        photoId = await g.uploadScan(img, nm);
        setStage('Reading with Google OCR…');
        text = await g.ocrFromFile(photoId);
      } else {
        setStage('Reading with Google OCR…');
        text = await g.ocrImage(img);   // temp OCR doc is deleted; photo is not stored
      }
    } catch (e) {
      if (/40[03]/.test(e.message) && file.type !== 'application/pdf') {
        // Oversized/odd photos are the usual cause — shrink harder, once.
        log('scanRetry', { msg: String(e.message).slice(0, 150) });
        setStage('Retrying with a smaller image…');
        text = await g.ocrImage(await normalizeImage(file, 1600, 0.55));
      } else throw e;
    }
    setStage('Extracting fields…');
    const parsed = parseStub(text || '');
    try {
      localStorage.setItem('paytrack.pendingScan',
        JSON.stringify({ text, t: Date.now(), name: file.name || 'photo' }));
    } catch {}
    // Troubleshooting archive (Setup toggle): photo + OCR text into the
    // user's own Drive so misparsed templates can be examined later.
    if (keep) {
      try {
        setStage('Archiving to your Drive…');
        if (parsed.check_no) {
          const named = nm.replace(/\.(\w+)$/, ` #${parsed.check_no}.$1`);
          if (photoId) await g.renameFile(photoId, named).catch(() => {});
          nm = named;
        }
        if (!photoId) photoId = await g.uploadScan(img, nm);   // (the OCR fell back to a temp copy)
        await g.uploadScan(new Blob([text || ''], { type: 'text/plain' }), nm.replace(/\.\w+$/, '.ocr.txt')).catch(() => {});
        parsed.drive_file_id = photoId;
        parsed.photo_name = nm;
        log('scanKept', { id: parsed.drive_file_id, name: nm });
        // Word POSITIONS too (background — never delays the flow): a
        // .layout.json beside the photo records where each word sits, so
        // new templates can be learned from geometry, not just text order.
        if (file.type !== 'application/pdf') {
          // Word positions (Tesseract) cost a multi-MB download and a CPU
          // burst — not on the phone while the user is typing corrections.
          if (!isPhone()) captureLayout(img)
            .then(json => g.uploadScan(new Blob([json], { type: 'application/json' }),
              nm.replace(/\.\w+$/, '.layout.json')))
            .then(() => log('layoutKept', { name: nm }))
            .catch(e => log('layoutErr', { msg: String(e.message).slice(0, 150) }));
        }
      } catch (e) { log('scanKeepErr', { msg: String(e.message).slice(0, 150) }); }
    }
    log('scan', {
      inBytes: file.size, ocrChars: (text || '').length, vendor: parsed.vendor,
      got: ['project_name', 'employer', 'payee', 'period_start', 'gross', 'check_no', 'day_count', 'paid_to']
        .filter(k => parsed[k] !== '' && parsed[k] !== null).join(','),
      earn: parsed.earnings.length,
    });
    scanInFlight = false;
    if (renderGen !== startGen && currentView !== 'stub') {
      // The user moved on while the scan ran: don't replace what they are
      // doing. The result waits as "Resume last scan" on the Stub tab.
      toast('Scan finished — open the Stub tab and tap "Resume last scan".', 6000);
      return;
    }
    confirmStubForm(parsed, text);
  } catch (e) {
    scanInFlight = false;
    log('scanFail', { msg: String(e.message).slice(0, 200) });
    pushDiagnostics(true).catch(() => {});
    toast(/40[03]/.test(e.message)
      ? 'Google couldn\'t read that file (format or size) — the photo is still selected, tap "Scan & match" to try again, or use a JPEG/PNG.'
      : `Scan failed: ${e.message} — the photo is still selected, tap "Scan & match" to retry.`, 9000);
    render('stub');
  }
}

// After a check record leaves a job (moved to another one), that job's
// statuses follow what remains: no wage check left means wages are not paid,
// gear received is re-counted, and the check's note line goes. Without this
// the old job stayed "paid" with no check behind it and its estimate was
// counted as paid money a second time.
async function afterStubRemoved(jobId, checkNo) {
  const job = await store.getJob(jobId);
  if (!job || job.deleted) return;
  const rest = (await store.allStubs()).filter(st => st.matched_job_id === jobId);
  const wageLeft = rest.some(st => (st.gross || 0) - gearOnStub(st.earnings) > 0);
  if (!wageLeft) { if (job.wages_status === 'paid' || job.wages_status === 'partial') job.wages_status = 'unpaid'; }
  else { const cov = wageCoverage(job, rest); if (cov.tracked) job.wages_status = cov.unpaid.length ? 'partial' : 'paid'; }
  if ((job.gear_status === 'paid' || job.gear_status === 'partial') && !(job.gear_invoices || []).length && job.gear_total) {
    const got = gearReceived(rest);
    if (got < job.gear_total - 1) job.gear_status = got > 0 ? 'partial' : 'unpaid';
  }
  if (checkNo) job.notes = (job.notes || '').split('\n').filter(l => !l.includes(`check #${checkNo}`)).join('\n');
  await store.putJob(job, { silent: true });
  sync.pushSoon(job).catch(() => {});
  log('stubRemovedRederived', { project: job.project, wages: job.wages_status, gear: job.gear_status });
}

function confirmStubForm(parsed, ocrText) {
  overlayOpen = true;
  const p = { ...parsed };
  // Auto-select who the check is made out to: the payee on the check vs the
  // two names saved in Setup -> Profile. No match = leave unset AND flag it.
  if (!p.paid_to && p.payee) p.paid_to = payeeMatch(p.payee, settings().companyName, settings().personalName);
  const payeeNote = h('p', { class: 'muted small', style: 'margin:2px 0 0' });
  if (p.payee) {
    if (p.paid_to === 'company') payeeNote.textContent = `Made out to "${p.payee}" — your company ✓`;
    else if (p.paid_to === 'me') payeeNote.textContent = `Made out to "${p.payee}" — you personally ✓`;
    else {
      payeeNote.textContent = `⚠ Made out to "${p.payee}" — doesn't match your saved company or personal name. Pick who was paid (names live in Setup → Profile).`;
      payeeNote.style.color = 'var(--warn)';
    }
  }
  if (p.mixed_memo) {
    payeeNote.append(h('span', { style: 'display:block;color:var(--warn)' },
      'The memo mentions both labor and gear — check the earnings lines below are split between wages and equipment.'));
  }
  const input = (key, attrs = {}) => h('input', {
    value: Array.isArray(p[key])
      ? (key === 'hourly_rates' ? p[key].map(r => '$' + r).join(', ') : p[key].join(', '))
      : (p[key] ?? ''), ...attrs,
    ...(attrs.type === 'number' && attrs.inputmode === 'decimal' ? { type: 'text' } : {}),
    oninput: (e) => {
      if (key === 'hourly_rates') {
        p[key] = e.target.value.split(/[,\s]+/)
          .map(v => parseFloat(v.replace(/[^0-9.]/g, '')))
          .filter(n => !Number.isNaN(n));
      } else if (attrs.type === 'number') p[key] = e.target.value === '' ? null : parseMoneyInput(e.target.value);
      else p[key] = e.target.value;
      queueMicrotask(() => savePendEdits(p));
    },
  });
  if (!Array.isArray(p.earnings)) p.earnings = [];
  const earnBox = h('div', {});
  const redrawEarn = () => {
    const num = (obj, key) => (ev) => obj[key] = ev.target.value === '' ? null : parseFloat(ev.target.value);
    earnBox.replaceChildren(
      ...p.earnings.map((e, i) => h('div', { class: 'earnrow' },
        h('input', { value: e.type || '', placeholder: 'Type', oninput: ev => e.type = ev.target.value }),
        h('input', { value: e.hours ?? '', placeholder: 'hrs', type: 'number', inputmode: 'decimal', oninput: num(e, 'hours') }),
        h('input', { value: e.rate ?? '', placeholder: '$/hr', type: 'number', inputmode: 'decimal', oninput: num(e, 'rate') }),
        h('input', { value: e.amount ?? '', placeholder: '$', type: 'number', inputmode: 'decimal', oninput: num(e, 'amount') }),
        h('button', {
          class: 'inline secondary', type: 'button',
          onclick: () => { p.earnings.splice(i, 1); redrawEarn(); },
        }, '×'))),
      h('button', {
        class: 'inline secondary', type: 'button', style: 'margin-top:8px',
        onclick: () => { p.earnings.push({ type: '', hours: null, rate: null, amount: null }); redrawEarn(); },
      }, '+ Add line'));
  };
  redrawEarn();

  // Deductions (taxes, union dues, SS/Medicare…) — cataloged per stub.
  if (!Array.isArray(p.deductions)) p.deductions = [];
  const dedBox = h('div', {});
  const redrawDed = () => {
    dedBox.replaceChildren(
      ...p.deductions.map((d, i) => h('div', { class: 'earnrow', style: 'grid-template-columns:2fr 1.2fr auto' },
        h('input', { value: d.type || '', placeholder: 'Type (e.g. Union Dues)', oninput: ev => d.type = ev.target.value }),
        h('input', { value: d.amount ?? '', placeholder: '$', type: 'number', inputmode: 'decimal',
          oninput: ev => d.amount = ev.target.value === '' ? null : parseFloat(ev.target.value) }),
        h('button', {
          class: 'inline secondary', type: 'button',
          onclick: () => { p.deductions.splice(i, 1); redrawDed(); },
        }, '×'))),
      h('button', {
        class: 'inline secondary', type: 'button', style: 'margin-top:8px',
        onclick: () => { p.deductions.push({ type: '', amount: null }); redrawDed(); },
      }, '+ Add deduction'));
  };
  redrawDed();

  viewEl.replaceChildren(h('div', { class: 'card' },
    h('h2', {}, 'Confirm stub details' + (p.vendor ? ` — ${p.vendor}` : '')),
    h('p', { class: 'muted small' }, 'OCR pre-filled what it could. Fix anything that looks wrong.'),
    h('label', {}, 'Project'), input('project_name'),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Employer / production co'), input('employer')),
      h('div', {}, h('label', {}, 'Payroll company'), input('payroll_employer', { placeholder: 'e.g. TakeOne Network Corp.' }))),
    h('label', {}, 'Memo / invoice #s (from the check)'),
    input('memo', { placeholder: 'e.g. Inv #2629, #2630' }),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Paid to'), (() => {
        // Dropdown of the two known payees, auto-selected from the scan.
        // Names come from Setup → Profile and are auto-learned from stubs.
        const s0 = settings();
        const sel = h('select', {
          onchange: (e) => {
            p.paid_to = e.target.value;
            if (e.target.value === 'company' && s0.companyName) p.payee = s0.companyName;
            if (e.target.value === 'me' && s0.personalName) p.payee = s0.personalName;
          },
        },
          h('option', { value: '' }, '— pick —'),
          h('option', { value: 'company' }, s0.companyName || (p.paid_to === 'company' && p.payee) || 'My company'),
          h('option', { value: 'me' }, s0.personalName || (p.paid_to === 'me' && p.payee) || 'Me personally'));
        sel.value = p.paid_to || '';
        return sel;
      })()),
      h('div', {}, h('label', {}, 'Job title'), input('job_title', { placeholder: 'Digital Imaging Tech' }))),
    payeeNote,
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Period start'), input('period_start', { type: 'date' })),
      h('div', {}, h('label', {}, 'Period end'), input('period_end', { type: 'date' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Days worked'), input('day_count', { type: 'number', inputmode: 'numeric' })),
      h('div', {}, h('label', {}, 'Total hours'), input('hours', { type: 'number', inputmode: 'decimal' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Gross ($)'), input('gross', { type: 'number', inputmode: 'decimal' })),
      h('div', {}, h('label', {}, 'Net ($)'), input('net', { type: 'number', inputmode: 'decimal' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Check #'), input('check_no')),
      h('div', {}, h('label', {}, 'Check date'), input('check_date', { type: 'date' }))),
    h('label', {}, 'Hourly rates seen (comma-separated)'), input('hourly_rates', { placeholder: '$81.82, $90' }),
    h('label', {}, 'Earnings breakdown (kept with the stub record)'),
    earnBox,
    h('label', {}, 'Deductions (taxes, union dues, SS/Medicare — kept with the stub record)'),
    dedBox,
    ocrText ? h('details', { class: 'mt' },
      h('summary', { class: 'muted small', style: 'cursor:pointer' }, 'Raw OCR text (for troubleshooting a wrong field)'),
      h('textarea', { readonly: 'readonly', style: 'min-height:140px;font-size:1rem;margin-top:8px' }, ocrText),
      h('button', {
        class: 'inline secondary', type: 'button', style: 'margin-top:8px',
        onclick: () => navigator.clipboard?.writeText(ocrText).then(() => toast('Raw OCR text copied.')),
      }, 'Copy raw text')) : null,
    h('button', { class: 'primary', onclick: () => pickMatch(p, ocrText) }, 'Find matching job →'),
    h('button', { class: 'secondary', onclick: () => render('stub') }, 'Cancel'),
  ));
  viewEl.scrollTop = 0;
}

async function pickMatch(p, ocrText) {
  overlayOpen = true;
  // Other checks already on file — their paid days show on the day picker.
  // (A re-scan of this same check is excluded, so its own days aren't "paid".)
  const stubsOnFile = (await store.allStubs())
    .filter(s => !(p.check_no && s.check_no === p.check_no));
  window.__pickMatchOpen = true;   // dev/testing hook marker
  const jobsList = await store.allJobs();
  // How every job looked when this screen opened: a save applies only what
  // this screen changed onto the freshest stored copy (see store.updateJob).
  const bases = new Map(jobsList.map(j => [j.id, JSON.parse(JSON.stringify(j))]));
  const stubGear = gearOnStub(p.earnings);
  // A gear-only stub (kit/box rental with no wage lines) pays gear, not wages.
  const gearOnly = stubGear > 0
    && !(p.hourly_rates || []).length
    && !(p.earnings || []).some(e => /straight|overtime|\bot\b|meal|holiday|penalt/i.test(e.type || ''));
  const candidates = matchStub({ ...p, gear_amount: stubGear }, jobsList);
  // Everything the matcher saw and every job's component scores (o=dates,
  // r=rate, n=name, ga=gear amount) — a "didn't find the job" report is
  // diagnosable from the log alone.
  log('match', {
    parsed: {
      vendor: p.vendor, project: p.project_name, employer: p.employer,
      payee: p.payee, period: `${p.period_start || '?'}..${p.period_end || '?'}`,
      gross: p.gross, gear: stubGear, check: p.check_no,
      rates: (p.hourly_rates || []).slice(0, 6),
    },
    gearOnly,
    scores: matchDebug({ ...p, gear_amount: stubGear }, jobsList).slice(0, 8),
  });
  // Preselect only a CONFIDENT match (dates + rate/name agree); otherwise
  // default to "create a new job" so a stale selection never sticks.
  // …and only when it clearly beats the runner-up: two jobs scoring within
  // 10 points is a tie the user should break, not the app.
  // Auto-pick only a clear winner — and never when the top two are the same
  // company with the same gear total (a late gear check from a repeat client
  // used to land on the newer job).
  let chosen = autoPick(candidates, p, isTie);

  // One check can pay TWO jobs (two invoices, same company). If no single
  // job's gear total matches but a PAIR of unpaid-gear jobs sums to this
  // check, recognize the split and preselect it.
  const checkTotal = gearOnly ? stubGear : (p.gross ?? stubGear ?? null);
  let split = false, chosen2 = null, amt1 = null, amt2 = null, amtEdited = false;
  // A check that was already split comes back as the same split.
  const priorSplit = p.check_no
    ? (await store.allStubs()).filter(st => st.check_no === p.check_no
        && jobsList.some(j => j.id === st.matched_job_id))
    : [];
  if (new Set(priorSplit.map(st => st.matched_job_id)).size === 2) {
    const [sa, sb] = priorSplit;
    split = true;
    chosen = jobsList.find(j => j.id === sa.matched_job_id);
    chosen2 = jobsList.find(j => j.id === sb.matched_job_id);
    amt1 = sa.gross; amt2 = sb.gross; amtEdited = true;
  } else if (gearOnly) {
    // Auto-detect only for pure gear checks, and only among the jobs that
    // already look like matches (same company / plausible dates) — two
    // unrelated jobs whose gear totals happen to add up are not a split.
    const pool = candidates.map(c => c.job)
      .filter(j => j.gear_total && j.gear_status !== 'paid' && j.gear_status !== 'na');
    const singleHit = pool.some(j => Math.abs(j.gear_total - stubGear) <= 1);
    if (!singleHit) {
      outer: for (let x = 0; x < pool.length; x++) {
        for (let y = x + 1; y < pool.length; y++) {
          if (Math.abs(pool[x].gear_total + pool[y].gear_total - stubGear) <= 1) {
            split = true;
            chosen = pool[x]; chosen2 = pool[y];
            amt1 = pool[x].gear_total; amt2 = pool[y].gear_total;
            log('splitDetected', { a: pool[x].project, b: pool[y].project, total: stubGear });
            break outer;
          }
        }
      }
    }
  }
  // Second-job choices: the match candidates plus any auto-detected pair job.
  const cand2 = candidates.map(c => c.job);
  for (const extra of [chosen, chosen2]) {
    if (extra && !cand2.some(j => j.id === extra.id)) cand2.push(extra);
  }
  let markPaid = !gearOnly;
  let markGearPaid = stubGear > 0;
  const gearNote = h('p', { class: 'muted small', style: 'margin:2px 0 0' });
  const updateGearNote = () => {
    // Splitting: the whole-check-vs-one-job comparison is meaningless — the
    // per-job amounts + sum line in the split box carry the verification.
    if (split) { gearNote.textContent = ''; return; }
    if (stubGear <= 0) return;
    if (chosen && chosen.gear_total) {
      const diff = stubGear - chosen.gear_total;
      if (Math.abs(diff) <= 1) {
        gearNote.textContent = `Matches the job's stated gear total (${fmt$(chosen.gear_total)})`;
        gearNote.style.color = 'var(--accent)';
      } else {
        gearNote.textContent = `Job states ${fmt$(chosen.gear_total)} — this stub pays ${fmt$(stubGear)} (${diff < 0 ? fmt$(-diff) + ' short' : fmt$(diff) + ' over'})`;
        gearNote.style.color = 'var(--warn)';
      }
    } else {
      gearNote.textContent = chosen ? 'Job has no stated gear total — this amount will fill it in.' : '';
      gearNote.style.color = '';
    }
  };

  // Days-this-check-covers picker (calendar style) over the stub's pay
  // period. A pay period often spans a week while only some days were
  // worked. For an existing job it preselects that job's days in the period;
  // for a new job, every day only when the stub says every day was worked.
  const daySel = new Set();
  const dayBox = h('div', { class: 'daychips' });
  const dayCounter = h('p', { class: 'muted small' }, '');
  const dayLabel = h('label', {}, '');
  const periodDays = [];
  if (p.period_start) {
    for (let d = p.period_start; d <= (p.period_end || p.period_start) && periodDays.length < 92; d = addDaysStr(d, 1)) periodDays.push(d);
  }
  let pickedFor;   // job id the selection was last preselected for
  const preselectDays = () => {
    const id = chosen ? chosen.id : null;
    if (id === pickedFor) return;   // keep the user's taps across redraws
    pickedFor = id;
    daySel.clear();
    const paid = chosen
      ? wageCoverage(chosen, stubsOnFile.filter(s => s.matched_job_id === chosen.id)).paid
      : null;
    if (chosen) {
      // The job's days in this period that no other check paid (a whole-range
      // job never gets more days than the stub says — see ui-logic.js).
      preselectCoveredDays(chosen, periodDays, paid, p.day_count).forEach(d => daySel.add(d));
    } else if (p.day_count && p.day_count === periodDays.length) {
      periodDays.forEach(d => daySel.add(d));
    }
    dayLabel.textContent = (chosen ? 'Which days does this check cover?' : 'Days actually worked')
      + (p.day_count ? ` — stub says ${p.day_count}` : '');
    const tint = () => { dayCounter.style.color = p.day_count && daySel.size && daySel.size !== p.day_count ? 'var(--warn)' : ''; };
    fillDayChips(dayBox, p.period_start, p.period_end, daySel, dayCounter, null, paid, tint);
    tint();
  };
  const chipCount = periodDays.length;
  const dayWrap = h('div', { class: 'mt' }, dayLabel, dayBox, dayCounter,
    h('p', { class: 'muted small' }, 'Tap days to toggle. Days outside the job\'s dates are added to it — a paid check proves they were worked.'));

  const list = h('div', {});
  const list2 = h('div', {});
  const splitBox = h('input', {
    type: 'checkbox', style: 'width:auto;margin-right:8px',
    onchange: (e) => { split = e.target.checked; if (!split) chosen2 = null; redraw(); },
  });
  const amt1Input = h('input', { type: 'number', inputmode: 'decimal' });
  const amt2Input = h('input', { type: 'number', inputmode: 'decimal' });
  amt1Input.addEventListener('input', e => { amt1 = e.target.value === '' ? null : parseFloat(e.target.value); amtEdited = true; sumNoteUpd(); });
  amt2Input.addEventListener('input', e => { amt2 = e.target.value === '' ? null : parseFloat(e.target.value); amtEdited = true; sumNoteUpd(); });
  const sumNote = h('p', { class: 'muted small', style: 'margin:2px 0 0' });
  const sumNoteUpd = () => {
    if (!split) return;
    const sum = (amt1 || 0) + (amt2 || 0);
    if (checkTotal) {
      const ok = Math.abs(sum - checkTotal) <= 1;
      sumNote.textContent = ok
        ? `${fmt$(sum)} — matches the check total ✓`
        : `${fmt$(sum)} of ${fmt$(checkTotal)} on the check (${fmt$(Math.abs(checkTotal - sum))} ${sum < checkTotal ? 'unassigned' : 'over'})`;
      sumNote.style.color = ok ? 'var(--accent)' : 'var(--warn)';
    } else sumNote.textContent = '';
  };
  const label1 = h('label', { class: 'mt' }, '');
  const label2 = h('label', { class: 'mt' }, '');
  const splitWrap = h('div', { class: 'mt' });
  const prefillAmts = () => {
    if (amtEdited || !split) return;
    if (gearOnly) {
      amt1 = chosen?.gear_total ?? (checkTotal ? Math.round(checkTotal / 2 * 100) / 100 : null);
    } else {
      amt1 = checkTotal ? Math.round(checkTotal / 2 * 100) / 100 : null;
    }
    amt2 = checkTotal && amt1 !== null ? Math.round((checkTotal - amt1) * 100) / 100 : null;
    amt1Input.value = amt1 ?? ''; amt2Input.value = amt2 ?? '';
  };
  const redraw = () => {
    list.replaceChildren(
      ...candidates.map((c, i) => h('div', {
        class: 'candidate' + (chosen?.id === c.job.id ? ' best' : ''),
        onclick: () => { chosen = c.job; if (chosen2?.id === chosen.id) chosen2 = null; redraw(); },
      },
        h('span', { class: 'score' }, c.reasons.join(', ') || 'weak match'),
        h('div', { class: 'title' }, (chosen?.id === c.job.id ? '✓ ' : '') + (c.job.project || '(untitled)')),
        h('div', { class: 'sub muted small' }, fmtRange(c.job.start_date, c.job.end_date)))),
      h('div', {
        class: 'candidate' + (chosen === null ? ' best' : ''),
        onclick: () => { chosen = null; split = false; redraw(); },
      }, h('div', { class: 'title' }, (chosen === null ? '✓ ' : '') + 'None of these — create a new job from this stub')));
    // Split UI: second-job picker + per-job amounts.
    splitBox.checked = split;
    if (split && chosen) {
      list2.replaceChildren(
        ...cand2.filter(j => j.id !== chosen.id).map(j => h('div', {
          class: 'candidate' + (chosen2?.id === j.id ? ' best' : ''),
          onclick: () => { chosen2 = j; redraw(); },
        },
          h('div', { class: 'title' }, (chosen2?.id === j.id ? '✓ ' : '') + (j.project || '(untitled)')),
          h('div', { class: 'sub muted small' }, [fmtRange(j.start_date, j.end_date),
            j.gear_total ? `gear ${fmt$(j.gear_total)}` : ''].filter(Boolean).join(' · ')))));
      prefillAmts();
      if (amt1 !== null && amt1Input.value === '') amt1Input.value = amt1;
      if (amt2 !== null && amt2Input.value === '') amt2Input.value = amt2;
      label1.textContent = `Amount — ${chosen.project || 'first job'} ($)`;
      label2.textContent = `Amount — ${chosen2 ? chosen2.project : 'second job'} ($)`;
      label1.className = 'ellip'; label2.className = 'ellip';
      splitWrap.replaceChildren(h('div', { class: 'splitbox' },
        h('label', {}, 'Second job on this check'),
        list2,
        h('div', { class: 'row2' },
          h('div', {}, label1, amt1Input),
          h('div', {}, label2, amt2Input)),
        sumNote));
      sumNoteUpd();
    } else splitWrap.replaceChildren();
    // Hidden for a split: which days belong to which job is ambiguous there.
    preselectDays();
    dayWrap.style.display = !split && chipCount > 1 ? '' : 'none';
    updateGearNote();
  };
  redraw();

  viewEl.replaceChildren(h('div', { class: 'card' },
    h('h2', {}, candidates.length ? 'Which job is this stub for?' : 'No matching job found'),
    list,
    h('label', { class: 'mt' },
      splitBox, 'This check pays TWO jobs (split across two invoices)'),
    splitWrap,
    dayWrap,
    h('label', { class: 'mt' },
      h('input', {
        type: 'checkbox', ...(markPaid ? { checked: 'checked' } : {}), style: 'width:auto;margin-right:8px',
        onchange: (e) => markPaid = e.target.checked,
      }), gearOnly ? 'Also mark wages PAID (this looks like a gear-only payment)' : 'Mark wages PAID on that job'),
    stubGear > 0 ? h('div', { class: 'mt' },
      h('label', {},
        h('input', {
          type: 'checkbox', checked: 'checked', style: 'width:auto;margin-right:8px',
          onchange: (e) => markGearPaid = e.target.checked,
        }), `Mark gear PAID (${fmt$(stubGear)} ${gearOnly ? 'gear payment' : 'kit/box rental on this stub'})`),
      gearNote) : null,
    h('button', {
      class: 'primary', onclick: async () => {
        try {
        if (p.gross !== null && p.gross !== undefined && p.gross < 0) return toast('Gross cannot be negative.');
        if ((p.gross === null || p.gross === undefined)
            && !confirm('No gross amount on this stub — save anyway? It will not count toward any total until an amount is added.')) return;
        if (!split && chosen && p.day_count && daySel.size && Math.abs(daySel.size - p.day_count) > 1
            && !confirm(`The stub says ${p.day_count} day${p.day_count === 1 ? '' : 's'} but ${daySel.size} are selected. Save anyway?`)) return;
        if (split) {
          if (!chosen || !chosen2) return toast('Pick both jobs for the split.');
          if (!(amt1 > 0) || !(amt2 > 0)) return toast('Enter the amount for each job.');
          // Payee attribution — same rules as a single-job save.
          const sq = (s) => (s || '').replace(/\s/g, '').toLowerCase();
          if (p.paid_to === 'company' && p.payee && !settings().companyName) { savePrefs({ companyName: p.payee }); sync.publishPrefs().catch(() => {}); }
          if (p.paid_to === 'me' && p.payee && !settings().personalName) { savePrefs({ personalName: p.payee }); sync.publishPrefs().catch(() => {}); }
          let via = '';
          if (p.paid_to) via = p.paid_to;
          else if (/loan\s*-?\s*out/i.test(p.classification || '')) via = 'company';
          else if (p.payee) {
            const comp = sq(settings().companyName);
            via = comp && (sq(p.payee).includes(comp) || comp.includes(sq(p.payee))) ? 'company' : 'me';
          }
          const allStubs = await store.allStubs();
          for (const [job, portion] of [[chosen, amt1], [chosen2, amt2]]) {
            const primary = job === chosen;
            job.job_status = 'confirmed';
            if (gearOnly) {
              if (markGearPaid) {
                const prior = gearReceived(allStubs.filter(st => st.matched_job_id === job.id
                  && !(p.check_no && st.check_no === p.check_no)));
                applyGearPayment(job, portion, prior);
                if (via) job.gear_paid_via = via;
                const gline = `Gear paid via stub${p.check_date ? ' ' + p.check_date : ''} (${fmtRaw$(portion)} split of check${p.check_no ? ' #' + p.check_no : ''})`;
                if (!job.notes.includes(gline)) job.notes = job.notes ? `${job.notes}\n${gline}` : gline;
              }
              if (markPaid) { job.wages_status = 'paid'; if (via) job.paid_via = via; }
            } else if (markPaid) {
              job.wages_status = 'paid';
              if (via) job.paid_via = via;
              const line = `Paid ${p.check_date || ''}${p.check_no ? `, check #${p.check_no}` : ''} (${fmtRaw$(portion)} split)`;
              if (!job.notes.includes(line)) job.notes = job.notes ? `${job.notes}\n${line}` : line;
            }
            // One record per (check, job) — a re-scan updates, never duplicates.
            const existing = p.check_no && String(p.check_no).length >= 3
              ? allStubs.find(st => st.check_no === p.check_no && st.matched_job_id === job.id) : null;
            await store.putStub({
              id: existing ? existing.id : store.uid(),
              created_at: existing?.created_at,
              drive_file_id: p.drive_file_id || '', photo_name: p.photo_name || '',
              vendor: p.vendor, project_name: p.project_name, employer: p.employer,
              payee: p.payee || '', classification: p.classification || '',
              payroll_employer: p.payroll_employer || '', paid_to: p.paid_to || via || '',
              job_title: p.job_title || '', memo: p.memo || '',
              // Synthetic split lines keep gear vs wages accounting right per job.
              earnings: gearOnly ? [{ type: 'Kit/box rental (split)', hours: null, rate: null, amount: portion }] : [],
              deductions: primary ? (p.deductions || []) : [],
              total_deductions: primary ? p.total_deductions : null,
              period_start: p.period_start, period_end: p.period_end,
              hourly_rates: p.hourly_rates || [], hours: primary ? p.hours : null,
              gross: portion, net: null,   // the check's net belongs to the whole check, not a half
              check_no: p.check_no, check_date: p.check_date,
              matched_job_id: job.id,
              ocr_text_excerpt: (ocrText || '').slice(0, 2000),
            });
            await store.updateJob(job.id, job, bases.get(job.id));
            sync.pushSoon(job).catch(() => {});
          }
          log('stubSplitSaved', { check: p.check_no || '', jobs: [chosen.project, chosen2.project], amts: [amt1, amt2] });
          clearPendingScan();
          toast(`Check split — ${fmt$(amt1)} to "${chosen.project}", ${fmt$(amt2)} to "${chosen2.project}" ✓`, 5500);
          render('home');
          return;
        }
        let job = chosen ? JSON.parse(JSON.stringify(chosen)) : null;
        const jobBase = chosen ? bases.get(chosen.id) : null;
        // A flat-fee job has no gear side: a "gear" check pays the fee.
        if (job && isFlat(job) && markGearPaid) markPaid = true;
        if (!job) {
          // Job was never logged (user error) but the payment came through:
          // create it from the stub and it gets pushed to the calendar as
          // a PAID event below, so the record exists everywhere.
          job = {
            ...store.blankJob(),
            project: p.project_name || p.employer || 'Job from stub',
            company: p.employer || '',
            // A check has no pay period: date the job by the check so it
            // still reaches the calendar.
            start_date: p.period_start || p.check_date || '', end_date: p.period_end || p.period_start || p.check_date || '',
            days_worked: p.day_count || null,
            notes: ['Created from paystub', p.gross ? `gross ${fmtRaw$(p.gross)}` : '',
              p.check_no ? `check #${p.check_no}` : ''].filter(Boolean).join(' · '),
            // The payment already arrived — no invoice pending on this job.
            invoice_status: markPaid ? 'na' : 'unsent',
          };
          const days = [...daySel].sort();
          if (days.length) {
            job.work_dates = days;
            job.days_worked = days.length;
            job.start_date = days[0];
            job.end_date = days[days.length - 1];
          }
        }
        job.job_status = 'confirmed';   // a payment proves the job happened
        if (markPaid) job.wages_status = 'paid';
        if (stubGear > 0 && markGearPaid && !isFlat(job)) {
          // A payment short of the job's stated gear total is partial, not paid.
          const prior = gearReceived((await store.allStubs()).filter(st => st.matched_job_id === job.id
            && !(p.check_no && st.check_no === p.check_no)));
          const short = applyGearPayment(job, stubGear, prior) === 'partial';
          const gline = `Gear paid via stub${p.check_date ? ' ' + p.check_date : ''} (${fmtRaw$(stubGear)}${short ? ' — partial' : ''})`;
          if (!job.notes.includes(gline)) job.notes = job.notes ? `${job.notes}\n${gline}` : gline;
        }
        // Backfill basics the job was missing, so the calendar event ends up
        // with company etc. without dumping the whole stub into it.
        if (!job.company && p.employer) job.company = p.employer;
        if (!job.days_worked && p.day_count) job.days_worked = p.day_count;
        // Fold the check's covered days into an existing job: they were
        // worked. Only ever ADDS days; the job's range grows to include them,
        // so the calendar follows when dates moved after the job was logged.
        const covered = [...daySel].sort();
        if (chosen && covered.length) {
          if ((job.work_dates || []).length) {
            job.work_dates = [...new Set([...job.work_dates, ...covered])].sort();
            job.days_worked = job.work_dates.length;
          }
          if (!job.start_date || covered[0] < job.start_date) job.start_date = covered[0];
          const last = covered[covered.length - 1];
          if (last > (job.end_date || job.start_date)) job.end_date = last;
        }
        // A weekly check pays its days, not the whole job: wages stay
        // 'partial' until every job day is covered by some check.
        if (markPaid && chosen && covered.length) {
          const others = (await store.allStubs()).filter(s => s.matched_job_id === job.id
            && !(p.check_no && s.check_no === p.check_no));
          const cov = wageCoverage(job, [...others, { gross: p.gross, earnings: p.earnings, work_dates: covered }]);
          if (cov.tracked) job.wages_status = cov.unpaid.length ? 'partial' : 'paid';
        }
        // The invoice flag follows the payment that proves it: a gear check
        // means the invoice went out; payroll wages on a job with no gear
        // never needed one. A gear job paid only its wages keeps nagging.
        if (chosen && job.invoice_status === 'unsent') {
          if (stubGear > 0 && markGearPaid) job.invoice_status = 'sent';
          else if (markPaid && job.gear_status === 'na') job.invoice_status = 'na';
        }
        // Attribute the payment. The parser (or the user, via the selector)
        // decided from the Name on the stub; fall back to classification.
        const sq = (s) => (s || '').replace(/\s/g, '').toLowerCase();
        // Auto-learn the two payee names from real stubs.
        if (p.paid_to === 'company' && p.payee && !settings().companyName) { savePrefs({ companyName: p.payee }); sync.publishPrefs().catch(() => {}); }
        if (p.paid_to === 'me' && p.payee && !settings().personalName) { savePrefs({ personalName: p.payee }); sync.publishPrefs().catch(() => {}); }
        let via = '';
        if (p.paid_to) via = p.paid_to;
        else if (/loan\s*-?\s*out/i.test(p.classification || '')) via = 'company';
        else if (p.payee) {
          const comp = sq(settings().companyName);
          via = comp && (sq(p.payee).includes(comp) || comp.includes(sq(p.payee))) ? 'company' : 'me';
        }
        // Wages and gear are attributed independently — this stub's payee
        // applies only to what THIS stub actually paid.
        if (via) {
          if (markPaid) job.paid_via = via;
          if (stubGear > 0 && markGearPaid) job.gear_paid_via = via;
        }
        if (markPaid && p.check_date) {
          const extras = [p.gross ? `gross ${fmtRaw$(p.gross)}` : '',
            p.hours ? `${p.hours} hrs` : '', p.day_count ? `${p.day_count} days` : '']
            .filter(Boolean).join(' · ');
          const line = `Paid ${p.check_date}${p.check_no ? `, check #${p.check_no}` : ''}${extras ? ` (${extras})` : ''}`;
          if (!job.notes.includes(line)) job.notes = job.notes ? `${job.notes}\n${line}` : line;
        }
        job = jobBase ? await store.updateJob(job.id, job, jobBase) : await store.putJob(job);
        // The same check scanned again UPDATES its existing record — one
        // record per (check, job), so a previously-split check keeps both
        // halves and a re-scan lands on the right one.
        const sameCheck = p.check_no && String(p.check_no).length >= 3
          ? (await store.allStubs()).filter(s => s.check_no === p.check_no)
          : [];
        const existingStub = sameCheck.find(s => s.matched_job_id === job.id) || null;
        // The same physical check already filed on ANOTHER job (same number
        // plus same date or payer — a different company's check can share a
        // number): ask before moving it, never re-point silently.
        const elsewhere = sameCheck.filter(s => s.matched_job_id !== job.id
          && ((s.check_date && s.check_date === p.check_date)
            || (s.employer && p.employer && sq(s.employer) === sq(p.employer))));
        if (elsewhere.length) {
          const names = [...new Set(elsewhere.map(s => (jobsList.find(j => j.id === s.matched_job_id) || {}).project || 'another job'))].join(' and ');
          if (confirm(`Check #${p.check_no} is already filed on ${names}.\n\nOK = move it to "${job.project}" (the other record is removed).\nCancel = keep both records (use this only if the check really paid both jobs).`)) {
            for (const m of elsewhere) await store.deleteStub(m.id);
            for (const jid of new Set(elsewhere.map(m => m.matched_job_id))) await afterStubRemoved(jid, p.check_no);
            log('stubMoved', { check: p.check_no, to: job.project });
          }
        }
        const stubRec = {
          id: existingStub ? existingStub.id : store.uid(),
          created_at: existingStub?.created_at,
          drive_file_id: p.drive_file_id || '', photo_name: p.photo_name || '',
          vendor: p.vendor, project_name: p.project_name, employer: p.employer,
          payee: p.payee || '', classification: p.classification || '',
          payroll_employer: p.payroll_employer || '',
          paid_to: p.paid_to || via || '',
          job_title: p.job_title || '', memo: p.memo || '', earnings: p.earnings || [],
          deductions: p.deductions || [], total_deductions: p.total_deductions,
          period_start: p.period_start, period_end: p.period_end,
          hourly_rates: p.hourly_rates || [], hours: p.hours,
          gross: p.gross, net: p.net, check_no: p.check_no, check_date: p.check_date,
          work_dates: covered,
          matched_job_id: job.id,
          ocr_text_excerpt: (ocrText || '').slice(0, 2000),
        };
        log('stubSaved', {
          check: p.check_no || '', job: job.project, newJob: !chosen,
          wagesPaid: markPaid, gearPaid: stubGear > 0 && markGearPaid, updated: !!existingStub,
        });
        const stubsForToast = (await store.allStubs()).filter(s => s.matched_job_id === job.id && s.id !== stubRec.id);
        await store.putStub(stubRec);
        sync.pushSoon(job).catch(e => { if (e.code !== 'NEEDS_CONNECT') toast('Sync: ' + e.message, 5000); });
        clearPendingScan();
        toast(existingStub
          ? `Check #${p.check_no} was already on file — record updated, not duplicated.`
          : !markPaid ? 'Stub filed.'
            : job.wages_status === 'partial'
              ? (() => { const c = wageCoverage(job, [...(stubsForToast || []), stubRec]); return `Stub filed — ${job.project}: ${c.paidOnJob} of ${c.total} days now paid.`; })()
              : `Stub filed — ${job.project} wages marked paid ✓`, 5000);
        render('home');
        } catch (e) {
          // Stay on this screen with everything the user picked intact — and
          // the scan itself survives in "Resume last scan" regardless.
          log('saveFail', { msg: String(e.message).slice(0, 200) });
          toast(`Save hit an error (${e.message}). Nothing was lost — fix the connection or try again.`, 9000);
        }
      },
    }, 'Save'),
    h('button', { class: 'secondary', onclick: () => confirmStubForm(p, ocrText) }, '← Back'),
  ));
  viewEl.scrollTop = 0;
}

// Dev hook: drive the match screen with a synthetic parsed stub from the
// console (used for debugging the matcher without a real scan).
window.__pickMatch = (p) => pickMatch(p, '');

// ---------- review (calendar import) ----------
async function review() {
  const queued = await store.allQueued();
  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Calendar import'),
      h('p', { class: 'muted' }, 'Events on your calendar that look like job entries (rates, "gear", "paid"…) land here for review — nothing is imported without your OK.'),
      h('label', {}, 'Scan events starting from'),
      (() => {
        const fromInput = h('input', { type: 'date', value: `${new Date().getFullYear()}-01-01` });
        return h('div', {},
          fromInput,
          h('button', {
            class: 'secondary', onclick: async () => {
              try {
                toast('Scanning calendar…');
                const n = await sync.historyImportScan(fromInput.value || undefined);
                toast(n ? `Found ${n} job-looking event${n > 1 ? 's' : ''} to review.` : 'No new job-looking events found.');
                render('review');
              } catch (e) { toast(e.message, 6000); }
            },
          }, 'Scan calendar'));
      })(),
      h('label', {}, 'Or import an events file (.json)'),
      h('input', {
        type: 'file', accept: '.json,application/json',
        onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const items = JSON.parse(await f.text());
            if (!Array.isArray(items)) throw new Error('File must contain a JSON array.');
            let n = 0;
            for (const it of items) {
              if (!it || !it.summary || !it.start) continue;
              // Only real ISO dates — a date in any other shape used to create a
              // job that crashed Home and could not be opened.
              const isoDay = (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : '';
              if (!isoDay(it.start)) continue;
              await store.queueImport({
                id: String(it.id || store.uid()), summary: String(it.summary),
                description: String(it.description || ''),
                start: isoDay(it.start), end: isoDay(it.end) || isoDay(it.start),
                no_cal: !!it.no_cal,
              });
              n++;
            }
            toast(`Queued ${n} event${n === 1 ? '' : 's'} for review.`);
          } catch (err) { toast('Import failed: ' + err.message, 6000); }
        },
      })),
    queued.length ? h('div', { class: 'card' },
      h('h2', {}, `To review (${queued.length})`),
      h('button', {
        class: 'secondary', style: 'margin-top:0', onclick: async () => {
          for (const item of await store.allQueued()) await store.dequeueImport(item.id);
          toast('Queue cleared — nothing was imported.');
          render('review');
        },
      }, 'Clear queue (import nothing)'),
      h('button', {
        class: 'primary', onclick: async () => {
          const items = await store.allQueued();
          let n = 0;
          for (const item of items) {
            try { await sync.importQueuedAsJob(item, { push: auth.isConnected() }); n++; }
            catch (e) { console.warn('import', e); }
          }
          toast(`Imported ${n} job${n === 1 ? '' : 's'}.`);
          render('jobs');
        },
      }, `Import all ${queued.length} as jobs`),
      queued.map(item => h('div', { class: 'candidate' },
        h('div', { class: 'title' }, item.summary),
        h('div', { class: 'sub muted small' }, [fmtRange(item.start, item.end, true), item.description].filter(Boolean).join(' · ')),
        h('div', { class: 'row2 mt' },
          h('button', {
            class: 'primary inline', onclick: async () => {
              try {
                const job = await sync.importQueuedAsJob(item, { push: auth.isConnected() });
                toast(`Imported "${job.project}".`);
              } catch (e) { toast(e.message, 5000); }
            },
          }, 'Import as job'),
          h('button', {
            class: 'secondary inline', onclick: () => store.dequeueImport(item.id),
          }, 'Not a job'))))) : null,
  );
}

// ---------- settings ----------
async function settingsView() {
  const s = settings();
  const clientIdInput = h('input', {
    value: s.clientId, placeholder: '1234…apps.googleusercontent.com',
    onchange: (e) => saveSettings({ clientId: e.target.value.trim() }),
  });
  const wagesAlertInput = h('input', {
    type: 'number', value: s.alertDaysWages, inputmode: 'numeric',
    onchange: (e) => {
      const n = parseInt(e.target.value, 10);
      if (!Number.isFinite(n) || n < 0) { e.target.value = settings().alertDaysWages; return toast('Enter a number of days (0 or more).'); }
      savePrefs({ alertDaysWages: n }); sync.publishPrefs().catch(() => {});
    },
  });
  const gearAlertInput = h('input', {
    type: 'number', value: s.alertDaysGear, inputmode: 'numeric',
    onchange: (e) => {
      const n = parseInt(e.target.value, 10);
      if (!Number.isFinite(n) || n < 0) { e.target.value = settings().alertDaysGear; return toast('Enter a number of days (0 or more).'); }
      savePrefs({ alertDaysGear: n }); sync.publishPrefs().catch(() => {});
    },
  });

  const calCard = h('div', { class: 'card' },
    h('h2', {}, 'Calendar'),
    s.calendarId
      ? h('p', {}, 'Syncing with: ', h('b', {}, s.calendarName || s.calendarId))
      : h('p', { class: 'muted' }, 'Connect Google, then pick the calendar to sync with.'),
    h('button', {
      class: 'secondary', onclick: async () => {
        try {
          const cals = await g.listCalendars();
          const picker = h('div', {},
            cals.map(c => h('div', {
              class: 'candidate' + (c.id === s.calendarId ? ' best' : ''),
              onclick: async () => {
                if (c.id === s.calendarId) { toast(`Already syncing with "${c.summary}".`); return; }
                toast(`Switching to "${c.summary}" — moving events…`, 5000);
                try { await sync.switchCalendar(c.id, c.summary); } catch (e) { toast(`Switch failed: ${e.message}`, 8000); }
                backgroundSync();
                render('settings');
              },
            }, c.summary)));
          picker.className = 'calpicker';
          calCard.querySelector('.calpicker')?.remove();
          calCard.append(picker);
        } catch (e) { toast(e.message, 6000); }
      },
    }, s.calendarId ? 'Change calendar' : 'Pick calendar'),
    h('button', {
      class: 'secondary', onclick: async () => {
        if (!confirm('Sweep the calendar for duplicated PayTrack events and delete the extras? One event per job per day is kept.')) return;
        try {
          toast('Cleaning duplicates — this can take a minute…', 8000);
          const n = await sync.cleanupCalendarDuplicates((i, total, removed) =>
            toast(`Checking job ${i}/${total} — ${removed} duplicates removed so far…`, 4000));
          toast(n ? `Done — removed ${n} duplicate event${n === 1 ? '' : 's'}.` : 'No duplicates found.', 6000);
        } catch (e) { toast(e.message, 6000); }
      },
    }, 'Clean duplicate calendar events'));

  // Safety net: deleted jobs stay recoverable — a sync bug (or a mistaken
  // delete) can be undone here instead of re-typing the job.
  const removedJobs = (await store.allJobs({ includeDeleted: true }))
    .filter(j => j.deleted)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 20);
  const removedCard = removedJobs.length ? h('details', { class: 'card' },
    h('summary', {}, `Removed jobs (${removedJobs.length}) — restore`),
    h('p', { class: 'muted small' }, 'Jobs deleted in the app (on any device). Restore brings one back everywhere, with its payment records.'),
    removedJobs.map(j => h('div', { class: 'job' },
      h('div', {},
        h('div', { class: 'title' }, j.project || '(untitled)'),
        h('div', { class: 'sub' }, [fmtRange(j.start_date, j.end_date),
          `removed ${(j.updated_at || '').slice(0, 10)}`].filter(Boolean).join(' · '))),
      h('div', { class: 'badges' }, h('button', {
        class: 'inline secondary', style: 'font-size:.7rem;padding:4px 9px',
        onclick: async () => {
          j.deleted = false;
          j.keep_cal = false;
          // Forget old event links: those events were cancelled when the job
          // was deleted, and a restored job must get fresh ones instead of
          // being re-tombstoned by its own stale cancellations.
          j.calendar_event_id = '';
          j.calendar_event_ids = [];
          await store.putJob(j);
          log('jobRestored', { project: j.project });
          sync.pushSoon(j).catch(() => {});
          toast(`"${j.project}" restored.`);
          render('settings');
        },
      }, 'Restore'))))) : null;

  // Close two-device edits: the copy that lost the merge is kept, never
  // silently discarded. Restore makes it the newest edit again.
  const conflicts = await store.allConflicts();
  const conflictsCard = conflicts.length ? h('div', { class: 'card' },
    h('h2', {}, `Sync conflicts (${conflicts.length})`),
    h('p', { class: 'muted small' }, 'Two devices edited the same job within minutes of each other; the later edit won. The version that lost is kept here.'),
    conflicts.map(c => h('div', { class: 'job', style: 'display:block;cursor:default' },
      h('div', { class: 'title' }, c.project || '(untitled)'),
      h('div', { class: 'sub' }, `Lost at ${new Date(c.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · the winning edit was ${Math.round((c.gapMs || 0) / 60000)} min later`),
      h('div', { class: 'row2 mt' },
        h('button', { class: 'secondary', style: 'margin-top:0', onclick: async () => {
          const r = await store.restoreConflict(c.id);
          if (r) { sync.pushSoon(r).catch(() => {}); toast(`"${r.project}" restored to this version.`); }
          render('settings');
        } }, 'Restore this version'),
        h('button', { class: 'secondary', style: 'margin-top:0', onclick: async () => { await store.deleteConflict(c.id); render('settings'); } }, 'Dismiss'))))) : null;

  return h('div', {},
    conflictsCard,
    h('div', { class: 'card' },
      h('h2', {}, 'Google connection'),
      h('p', { class: 'muted small' }, 'One-time: create an OAuth Client ID in Google Cloud console (see README) and paste it here. Your data never leaves your own Google account.'),
      h('label', {}, 'OAuth Client ID'), clientIdInput,
      h('button', { 'data-connect': '1',
        class: 'primary', onclick: async () => {
          try {
            await auth.connect();
            toast('Connected ✓ — setting up Drive & Sheet…');
            await sync.ensureCloudSetup();
            await sync.pullSheet();
            sync.scheduleMirror();
            render('settings');
          } catch (e) { toast(e.message, 8000); }
        },
      }, auth.isConnected() ? 'Reconnect Google' : 'Connect Google'),
      auth.isConnected() ? h('button', { class: 'secondary', onclick: () => { auth.disconnect(); saveSettings({ everConnected: false }); render('settings'); } }, 'Disconnect') : null),
    calCard,
    h('div', { class: 'card' },
      h('h2', {}, 'Profile'),
      h('label', {}, 'Theme'),
      segmented('theme', s.theme || '',
        [['', 'Auto (device)'], ['dark', 'Dark'], ['light', 'Light']],
        v => { saveSettings({ theme: v }); applyTheme(); }),
      h('label', {}, 'My loan-out company name (as it appears on stubs)'),
      h('input', {
        value: s.companyName, placeholder: 'auto-learned from company stubs',
        onchange: (e) => { savePrefs({ companyName: e.target.value.trim() }); sync.publishPrefs().catch(() => {}); },
      }),
      h('label', {}, 'My name (as it appears on stubs)'),
      h('input', {
        value: s.personalName, placeholder: 'auto-learned from personal stubs',
        onchange: (e) => { savePrefs({ personalName: e.target.value.trim() }); sync.publishPrefs().catch(() => {}); },
      }),
      h('label', {}, 'Keep scan photos for troubleshooting'),
      segmented('keepscans', s.keepScans === false ? 'off' : 'on',
        [['on', 'On (recommended for now)'], ['off', 'Off']],
        v => saveSettings({ keepScans: v === 'on' })),
      h('p', { class: 'muted small' }, 'On: each scanned photo and its extracted text is saved to a private "PayTrack Scans" folder in YOUR Google Drive, so a misread stub can be examined later and the parser taught its template. Text and layout sidecars older than 90 days are cleaned up monthly. Off: photos are never stored anywhere.'),
      h('label', {}, 'Upload diagnostics to Drive'),
      segmented('uploaddiag', s.uploadDiag === false ? 'off' : 'on',
        [['on', 'On'], ['off', 'Off']],
        v => saveSettings({ uploadDiag: v === 'on' })),
      h('p', { class: 'muted small' }, 'On: this device writes a redacted diagnostics file (app log, jobs and payment records with long digit runs masked, no email or names) into the same private Drive folder every 30 minutes and after a failed scan, so problems can be looked at remotely. Off: nothing is uploaded; the bug report download still works.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Alerts'),
      h('div', { class: 'row2' },
        h('div', {}, h('label', {}, 'Wages overdue after (days past wrap)'), wagesAlertInput),
        h('div', {}, h('label', {}, 'Gear overdue after (days past wrap)'), gearAlertInput)),
      h('p', { class: 'muted small mt' }, 'Wages and gear each get their own "Follow up" calendar event on their own timer, with an email + notification from Google Calendar. Marking a part paid removes its reminder. A job\'s "expect payment by" date overrides both timers.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Data'),
      h('p', { class: 'muted small' },
        s.sheetId ? h('span', {}, 'Database: ', h('a', { href: `https://docs.google.com/spreadsheets/d/${s.sheetId}`, target: '_blank' }, 'PayTrack DB sheet'), ' in your Drive. ', s.keepScans === false
            ? 'Scan photos are not stored — only the extracted details.'
            : 'Scan photos and their text are archived in your Drive while "Keep scan photos" is on.')
          : 'Connect Google to create the PayTrack DB sheet.'),
      h('p', { class: 'muted small' }, syncHealth()),
      h('button', {
        class: 'secondary', onclick: async (e) => {
          // The same engine as the background sync (single-flight, every
          // stage, repairs only after a fresh pull) — never a side path.
          const btn = e.currentTarget; btn.disabled = true;
          try {
            const errs = await backgroundSync();
            if (!errs) toast('Not connected — tap the dot in the top bar to reconnect.', 6000);
            else toast(errs.length ? `Synced with errors — ${errs.join(' · ')}` : 'Synced ✓', errs.length ? 9000 : 3000);
          } finally { btn.disabled = false; if (currentView === 'settings') render('settings'); }
        },
      }, 'Sync now'),
      h('p', { class: 'muted small mt' },
        h('a', {
          href: '#', onclick: async (e) => {
            e.preventDefault();
            const diag = { version: APP_VERSION, ua: navigator.userAgent, log: dump() };
            await navigator.clipboard?.writeText(JSON.stringify(diag, null, 1));
            toast('Diagnostics copied — paste them to Claude to debug.');
          },
        }, 'Copy diagnostics'), ' · ',
        h('a', {
          href: '#', onclick: async (e) => {
            e.preventDefault();
            // Full snapshot: log + every job and payment record, saved as a
            // file that can be shared/dropped straight into a Claude session.
            const blob = new Blob([JSON.stringify(await buildBugReport(), null, 1)], { type: 'application/json' });
            const name = `paytrack-bug-report-${store.today()}.json`;
            if (isPhone() && navigator.canShare) {
              const file = new File([blob], name, { type: 'application/json' });
              if (navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'PayTrack bug report' }).catch(() => {});
                return;
              }
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            toast('Bug report saved — send the file to Claude to debug.');
          },
        }, 'Download bug report'), ' · ',
        h('a', {
          href: '#', onclick: (e) => { e.preventDefault(); clearLog(); toast('Diagnostics log cleared.'); },
        }, 'clear')),
      h('button', {
        class: 'secondary', onclick: async () => {
          // Clears cached app files only — jobs/stubs (IndexedDB) are untouched.
          try {
            const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
            for (const r of regs) await r.unregister();
            for (const k of await caches.keys()) await caches.delete(k);
          } catch {}
          location.reload();
        },
      }, `Force update (running ${APP_VERSION})`)),
    removedCard,
  );
}

// ---------- boot ----------
function applyTheme() {
  const t = settings().theme;
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme();
// Stable per-device id — names this device's diagnostics file in Drive.
if (!settings().deviceId) saveSettings({ deviceId: store.uid() });

const EYE_OPEN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="21" x2="21" y2="3"/></svg>';
const eyeBtn = document.getElementById('money-eye');
function drawEye() {
  eyeBtn.innerHTML = hideMoney ? EYE_OFF : EYE_OPEN;
  eyeBtn.classList.toggle('hidden-money', hideMoney);
}
eyeBtn.addEventListener('click', () => {
  hideMoney = !hideMoney;
  saveSettings({ hideMoney });
  drawEye();
  render();
});
drawEye();

// Sidebar show/hide (handy on phones). State persists per device.
const NAV_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
const navBtn = document.getElementById('nav-toggle');
navBtn.innerHTML = NAV_SVG;
function applySidebar() {
  document.body.classList.toggle('nav-hidden', !!settings().sidebarHidden);
}
navBtn.addEventListener('click', () => {
  saveSettings({ sidebarHidden: !settings().sidebarHidden });
  applySidebar();
});
applySidebar();

// Keep in sync with the CACHE version in sw.js on every release.
const APP_VERSION = 'v121';
log('boot', { v: APP_VERSION, mobile: /iPhone|Android/i.test(navigator.userAgent) });
document.getElementById('ver').textContent = APP_VERSION;
function setConnDot(state) {
  const dot = document.getElementById('conn-status');
  const bad = state === 'connected' && lastSync && lastSync.errs.length;
  dot.className = state === 'connected' ? (bad ? 'on err' : 'on') : (auth.hasCredentials() ? 'warn' : '');
  dot.title = state === 'connected'
    ? (bad ? `Google connected — last sync had an error: ${lastSync.errs[0]}` : 'Google connected')
    : 'Google not connected — tap to reconnect';
}
auth.authBus.addEventListener('state', (e) => {
  setConnDot(e.detail);
  log('auth', e.detail);
  // Ask the browser to keep our data (IndexedDB, settings, token) out of
  // best-effort eviction once the user has signed in.
  if (e.detail === 'connected') navigator.storage?.persist?.().then(ok => log('persist', { ok })).catch(() => {});
});
setConnDot(auth.isConnected() ? 'connected' : 'disconnected');
// One-tap reconnect: a real click is a user gesture, so the Google popup
// is allowed here even when silent refresh was blocked.
document.getElementById('conn-status').addEventListener('click', async () => {
  if (auth.isConnected()) return toast('Google connected.');
  try {
    await auth.connect();
    toast('Reconnected ✓');
    backgroundSync();
  } catch (e) { toast(e.message, 6000); }
});

// One-time repair: the same check scanned twice created duplicate stub
// records (double-counting that money). Keep the newest per check number and
// scrub duplicated note lines on jobs.
async function dedupeChecks() {
  try {
    const stubs = await store.allStubs();
    const byCheck = {};
    for (const s of stubs) {
      // One record per (check, job) — a check SPLIT across two jobs keeps
      // both halves; only same-check-same-job copies collapse.
      if (s.check_no && String(s.check_no).length >= 3) (byCheck[`${s.check_no}|${s.matched_job_id || ''}`] ||= []).push(s);
    }
    let removed = 0;
    for (const group of Object.values(byCheck)) {
      if (group.length < 2) continue;
      group.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      for (const dupe of group.slice(1)) {
        await store.deleteStub(dupe.id);
        removed++;
      }
    }
    // Two jobs pointing at the same calendar event = the same job imported
    // twice (e.g. on two devices before they synced). Keep the newest.
    const jobsAll = await store.allJobs();
    const byEvent = {};
    for (const j of jobsAll) {
      if (j.calendar_event_id) (byEvent[j.calendar_event_id] ||= []).push(j);
    }
    for (const grp of Object.values(byEvent)) {
      if (grp.length < 2) continue;
      grp.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      for (const dup of grp.slice(1)) {
        dup.deleted = true;
        dup.calendar_event_id = '';
        dup.calendar_event_ids = [];
        await store.putJob(dup, { silent: true });
        removed++;
        log('dedupeJob', { project: dup.project });
      }
    }
    removed += await store.dropStubHusks();
    // Scrub structurally-invalid fields that positional sheet reads (pre-v72
    // mixed-version bug) may have leaked in from neighboring rows.
    const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
    for (const job of await store.allJobs({ includeDeleted: true })) {
      let dirty = false;
      for (const k of ['work_dates', 'travel_dates', 'calendar_event_ids', 'gear_invoices']) {
        if (job[k] !== undefined && !Array.isArray(job[k])) { job[k] = []; dirty = true; }
      }
      for (const k of ['work_dates', 'travel_dates']) {
        const clean = (job[k] || []).filter(d => ISO_DAY.test(d));
        if (clean.length !== (job[k] || []).length) { job[k] = clean; dirty = true; }
      }
      const badInv = (job.gear_invoices || []).filter(i => !i || typeof i !== 'object');
      if (badInv.length) { job.gear_invoices = job.gear_invoices.filter(i => i && typeof i === 'object'); dirty = true; }
      for (const k of ['rate_amount', 'rate_hours', 'rate_hourly', 'gear_rate', 'gear_total', 'days_worked']) {
        if (typeof job[k] === 'number' && Number.isNaN(job[k])) { job[k] = null; dirty = true; }
      }
      // Records predating the invoice feature carry '' — normalize so the
      // row badge can't misreport them ('' rendered as "invoice: sent").
      if (!['na', 'unsent', 'sent'].includes(job.invoice_status)) {
        job.invoice_status = job.wages_status === 'paid' ? 'na' : 'unsent';
        dirty = true;
      }
      if (dirty) { await store.putJob(job, { silent: true, keepStamp: true }); log('scrubJob', { project: job.project }); }
    }
    // Old scans left label junk in stub name fields ("Social Security No.",
    // "FICA", "Job Type") — blank those so matching and display stay clean.
    const labelJunk = /^(social\s+security|fica|job\s+type|job\s+name|employee(\s+name)?|deductions?|check\s+(no|date)|work\s+period|memo)\b/i;
    for (const stb of await store.allStubs()) {
      let sdirty = false;
      for (const k of ['payee', 'employer', 'project_name', 'job_title']) {
        if (stb[k] && labelJunk.test(stb[k])) { stb[k] = ''; sdirty = true; }
      }
      if (sdirty) { await store.putStub(stb, { keepStamp: true }); log('scrubStub', { chk: stb.check_no || '' }); }
    }
    const jobs = await store.allJobs();
    for (const job of jobs) {
      if (!job.notes) continue;
      // De-dupe note lines and drop junk (bare ISO timestamps from an old bug).
      const uniq = [...new Set(job.notes.split('\n'))]
        .filter(l => !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(l.trim()))
        .join('\n');
      if (uniq !== job.notes) {
        job.notes = uniq;
        await store.putJob(job, { silent: true, keepStamp: true });
      }
    }
    if (removed) {
      store.notifyChanged();
      if (auth.isConnected()) sync.scheduleMirror();
      toast(`Removed ${removed} duplicate check record${removed === 1 ? '' : 's'}.`);
    }
  } catch (e) { console.warn('dedupe', e); }
}

// One-time repair: jobs saved before payee attribution existed inherit it
// from their matched stub (explicit paid_to, or a Loan Out classification).
async function backfillPaidVia() {
  try {
    const jobs = await store.allJobs();
    const stubs = await store.allStubs();
    let changed = false;
    for (const job of jobs) {
      if (job.paid_via) continue;
      const ss = stubs.filter(s => s.matched_job_id === job.id);
      const hit = ss.find(s => s.paid_to)
        || ss.find(s => /loan\s*-?\s*out/i.test(s.classification || ''));
      if (hit) {
        job.paid_via = hit.paid_to || 'company';
        await store.putJob(job, { silent: true, keepStamp: true });
        changed = true;
      }
    }
    if (changed) {
      store.notifyChanged();
      if (auth.isConnected()) sync.scheduleMirror();
    }
  } catch (e) { console.warn('backfill', e); }
}

// Long digit runs (account/routing numbers, SSN fragments) and anything that
// looks like a MICR line never leave the device in a report.
const redact = (t) => String(t || '')
  .replace(/\d[\d\s-]{7,}\d/g, (m) => m.replace(/\d/g, '#'))
  .replace(/[⑆⑈⑇]/g, '#');
async function buildBugReport() {
  const s = { ...settings() };
  for (const k of ['googleEmail', 'clientId', 'personalName', 'companyName']) s[k] = s[k] ? '(set)' : '';
  return {
    version: APP_VERSION, ua: navigator.userAgent, time: new Date().toISOString(),
    device: settings().deviceId || '', settings: s, log: dump(), errors: dumpErrors(),
    jobs: await store.allJobs({ includeDeleted: true }),
    stubs: (await store.allStubs()).map(st => ({ ...st, ocr_text_excerpt: redact(st.ocr_text_excerpt) })),
  };
}

// Each device overwrites its own diagnostics file in the "PayTrack Scans"
// Drive folder (30-min throttle; immediately after a scan failure) — remote
// debugging without hand-exporting a report from every device.
let lastDiagUp = 0;
async function pushDiagnostics(force = false) {
  if (!auth.isConnected() || settings().uploadDiag === false) return;
  if (!force && Date.now() - lastDiagUp < 30 * 60000) return;
  lastDiagUp = Date.now();
  try {
    await g.uploadDiagnostics(`diagnostics-${settings().deviceId || 'device'}.json`,
      JSON.stringify(await buildBugReport()));
    log('diagUp', { ok: true });
  } catch (e) { log('diagUpErr', { msg: String(e.message).slice(0, 120) }); }
}

// Wage status follows the checks. When every wage check on a job recorded
// the days it covered (coverage is "tracked"), the status is derived: every
// worked day covered = paid, otherwise partial — whether the job has wrapped
// or not, and in BOTH directions (a day added after the last check reopens
// the job; the last weekly check closes it). Jobs whose checks carry no days
// keep whatever the user set. Repairs keep the record's edit time so they
// never outrank a real edit made on another device.
let healToasted = false;
async function healStatuses() {
  const stubsByJob = {};
  for (const st of await store.allStubs()) if (st.matched_job_id) (stubsByJob[st.matched_job_id] ||= []).push(st);
  let healed = 0;
  for (const j of await store.allJobs()) {
    if (j.job_status === 'hold') continue;
    const cov = wageCoverage(j, stubsByJob[j.id]);
    if (!cov.tracked) continue;
    const want = cov.unpaid.length ? 'partial' : 'paid';
    if (j.wages_status === want) continue;
    const was = j.wages_status;
    j.wages_status = want;
    await store.putJob(j, { silent: true, keepStamp: true });
    sync.pushSoon(j).catch(() => {});
    log('healedStatus', { project: j.project, was, now: want, unpaid: cov.unpaid.length });
    healed++;
  }
  if (healed && !healToasted) {
    healToasted = true;
    toast(`Wage status corrected on ${healed} job${healed === 1 ? '' : 's'} to match its checks.`, 5000);
    store.notifyChanged();
  }
}

// One sync at a time: the 5-minute timer, tab refocus and reconnect can all
// fire together.
let syncInFlight = null;
let syncStartedAt = 0;
function backgroundSync() {
  // Watchdog: a sync that has hung for 6 minutes (a request that never
  // settled) must not block every later sync until the page reloads.
  if (syncInFlight && Date.now() - syncStartedAt > 6 * 60000) {
    log('syncWatchdog', { stuckMs: Date.now() - syncStartedAt });
    syncInFlight = null;
  }
  if (!syncInFlight) {
    syncStartedAt = Date.now();
    const mine = runSync().finally(() => { if (syncInFlight === mine) syncInFlight = null; maybeReloadForUpdate(); });
    syncInFlight = mine;
  }
  return syncInFlight;
}
async function runSync() {
  if (!auth.hasCredentials() || !settings().everConnected) return;
  // Check for a new app version even when the login has expired — a stale
  // device must not keep running old logic just because it is signed out.
  navigator.serviceWorker?.getRegistration?.().then(r => r && r.update()).catch(() => {});
  try {
    await auth.token();               // silent refresh if possible
  } catch (e) {
    log('sync', { ok: false, code: e.code || '', msg: String(e.message).slice(0, 160) });
    lastSync = { at: Date.now(), errs: [String(e.message)] };
    return lastSync.errs;
  }
  // Each stage runs even when an earlier one fails — a calendar hiccup must
  // never strand this device's data outside the sheet.
  // ORDER MATTERS: merge the sheet BEFORE reading the calendar. A device
  // holding an older copy of a job used to see another device's calendar
  // push as "the user edited the event", stamp its stale copy as newest and
  // overwrite the real edit everywhere.
  const errs = [], errMsgs = [];
  for (const [name, fn] of [
    ['pullSheet', () => sync.pullSheet()],
    ['healStatuses', () => healStatuses()],
    ['calendarChoice', () => sync.syncCalendarChoice()],
    ['pullCalendar', () => sync.pullCalendar()],
    ['pushDirty', () => sync.pushDirty()],
    ['pushUnsynced', () => sync.pushUnsynced()],
    ['invoiceNag', () => sync.rearmInvoiceReminders()],
    // Upload as well as download: a job created while this device was
    // offline/disconnected must still reach the sheet eventually.
    ['mirrorSheet', () => sync.mirrorSheet({ alreadyPulled: true })],
  ]) {
    // Without a fresh sheet merge this device may hold stale jobs — don't let
    // it interpret calendar changes against them.
    if (name === 'pullCalendar' && errs.includes('pullSheet')) continue;
    // Repairs computed on a stale copy would outrank real edits elsewhere.
    if (name === 'healStatuses' && errs.includes('pullSheet')) continue;
    try { await fn(); } catch (e) {
      errs.push(name);
      errMsgs.push(`${name}: ${String(e.message).slice(0, 160)}`);
      log('sync:' + name, { ok: false, code: e.code || '', msg: String(e.message).slice(0, 200) });
      if (e.code === 'NEEDS_CONNECT') break;
      console.warn('sync', name, e);
    }
  }
  log('sync', { ok: !errs.length, failed: errs });
  lastSync = { at: Date.now(), errs: errMsgs };
  if (!errs.length && settings().keepScans !== false) {
    const last = settings().lastScanSweep || '';
    if (!last || Date.now() - Date.parse(last) > 30 * 86400000) {
      saveSettings({ lastScanSweep: new Date().toISOString() });
      g.sweepScanSidecars(90).then(n => { if (n) log('scanSweep', { removed: n }); }).catch(e => log('scanSweepErr', { msg: String(e.message).slice(0, 120) }));
    }
  }
  setConnDot(auth.isConnected() ? 'connected' : 'disconnected');
  pushDiagnostics().catch(() => {});
  return errMsgs;
}
// Sync health for the Setup screen and the connection dot: a failing stage
// used to be invisible for weeks (the dot only ever reflected the login).
let lastSync = null;
function syncHealth() {
  if (!lastSync) return 'No sync yet in this session.';
  const mins = Math.round((Date.now() - lastSync.at) / 60000);
  const when = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
  return `Last sync ${when} · ${lastSync.errs.length ? 'last error — ' + lastSync.errs[0] : 'no errors'}`;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // When an UPDATED service worker takes control, reload once so the page
  // immediately runs the new version instead of the stale cached one. The
  // hadController check keeps the very first visit from reloading.
  const hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloadedForUpdate) {
      reloadedForUpdate = true;
      reloadPending = true;
      if (overlayOpen || scanInFlight || syncInFlight) {
        toast('Update ready — it applies when you leave this screen.', 5000);
      } else maybeReloadForUpdate();
    }
  });
}
render('home');
setTimeout(backfillPaidVia, 800);
setTimeout(dedupeChecks, 1200);
setTimeout(backgroundSync, 1000);   // the stored token needs no sign-in library
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;
  // Pick up a new version BEFORE syncing with the old logic (2 s cap so an
  // offline device still syncs); a waiting worker reloads once idle.
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if (reg) {
      await Promise.race([reg.update().catch(() => {}), new Promise(r => setTimeout(r, 2000))]);
      if (reg.installing || reg.waiting) { reloadPending = true; maybeReloadForUpdate(); return; }
    }
  } catch {}
  backgroundSync();
});
// Devices left open still pick up each other's changes.
setInterval(backgroundSync, 5 * 60 * 1000);
