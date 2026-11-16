// Cloud sync: Google Sheet mirror (backup + multi-device bootstrap),
// two-way calendar sync, and reminder (alert) events.
import { settings, saveSettings, SHARED_PREFS } from './config.js';
import * as g from './google.js';
import * as store from './store.js';
import { parseJobNote, looksLikeJob, jobToNote, gearOnStub } from './parse.js';

// Which check paid the wages and which paid the gear, from matched stubs —
// so the calendar note can carry the check numbers.
async function checkRefs(job) {
  const refs = { wages: '', gear: '' };
  try {
    const stubs = (await store.allStubs()).filter(s => s.matched_job_id === job.id && s.check_no);
    for (const s of stubs) {
      const gearPart = gearOnStub(s.earnings);
      if (gearPart > 0 && !refs.gear) refs.gear = s.check_no;
      if ((s.gross || 0) - gearPart > 0 && !refs.wages) refs.wages = s.check_no;
    }
  } catch {}
  return refs;
}
import { log } from './log.js';

const JOB_COLS = ['id', 'project', 'company', 'start_date', 'end_date', 'days_worked',
  'work_dates', 'calendar_event_ids', 'rate_amount',
  'rate_hours', 'rate_text', 'gear_rate', 'gear_period', 'gear_total', 'wages_status', 'gear_status', 'paid_via', 'gear_paid_via', 'job_status',
  'invoice_status', 'invoice_reminder_event_id',
  'expected_pay_date', 'calendar_event_id', 'reminder_event_id', 'gear_reminder_event_id',
  'no_cal', 'notes', 'updated_at', 'deleted',
  // Columns map to the Sheet by position — new ones must be appended here,
  // never inserted, or old rows parse shifted.
  'rate_hourly', 'travel_dates', 'gear_invoices', 'keep_cal', 'pay_type', 'flat_total'];
const STUB_COLS = ['id', 'drive_file_id', 'photo_name', 'vendor', 'project_name', 'employer',
  'payee', 'classification', 'job_title', 'payroll_employer', 'paid_to', 'period_start', 'period_end', 'hourly_rates', 'hours',
  'gross', 'net', 'check_no', 'check_date', 'matched_job_id', 'earnings',
  'deductions', 'total_deductions',
  'created_at', 'updated_at',
  // Appended columns only (positional history; reads are header-mapped).
  'memo', 'work_dates', 'deleted'];

const JSON_COLS = ['earnings', 'deductions', 'gear_invoices'];
const toRow = (cols, rec) => cols.map(c => {
  const v = rec[c];
  if (JSON_COLS.includes(c)) return JSON.stringify(v || []);
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('|');
  return String(v);
});

const NUM_COLS = ['days_worked', 'rate_amount', 'rate_hours', 'rate_hourly', 'gear_rate',
  'gear_total', 'hours', 'gross', 'net', 'total_deductions', 'flat_total'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_COLS = ['start_date', 'end_date', 'expected_pay_date', 'check_date', 'period_start', 'period_end'];

const coerce = (c, raw) => {
  const v = raw ?? '';
  if (JSON_COLS.includes(c)) {
    try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  if (NUM_COLS.includes(c)) {
    const n = parseFloat(v);
    return v === '' || Number.isNaN(n) ? null : n;
  }
  if (c === 'deleted' || c === 'no_cal' || c === 'keep_cal') return /^true$/i.test(String(v));
  // An impossible ISO date from a hand-edited cell ("2025-13-45") would hang
  // date loops; drop it rather than read it.
  if (DATE_COLS.includes(c) && ISO_DAY.test(String(v)) && Number.isNaN(Date.parse(v))) return '';
  if (c === 'hourly_rates') return v ? v.split('|').map(Number).filter(n => !Number.isNaN(n)) : [];
  if (c === 'work_dates' || c === 'travel_dates') return v ? v.split('|').filter(d => ISO_DAY.test(d)) : [];
  if (c === 'calendar_event_ids') return v ? v.split('|') : [];
  return v;
};

// Rows are mapped by the sheet's OWN header row, never by position. Devices on
// different app versions write different column sets, and positional mapping
// let one version's rows be read against another version's columns — stale
// cells (including a neighboring row's `deleted` flag) leaked across jobs,
// corrupting totals and tombstoning live jobs. A column the writing device
// didn't know is simply absent from the record and survives the merge.
const fromRows = (cols, rows) => {
  const header = (rows[0] || []).map(String);
  const known = header.filter(hc => cols.includes(hc));
  // No sane header (hand-edited sheet): fall back to positional — and if row 0
  // is itself data (header row deleted), keep it instead of dropping a record.
  const headerIsData = known.length < 5 && ISO_DAY.test(String((rows[0] || [])[3] || ''));
  const body = headerIsData ? rows : rows.slice(1);
  return body.map(row => {
    const rec = {};
    if (known.length >= 5) {
      header.forEach((hc, i) => { if (cols.includes(hc)) rec[hc] = coerce(hc, row[i]); });
    } else {
      cols.forEach((c, i) => rec[c] = coerce(c, row[i]));
    }
    return rec;
  }).filter(rec => !cols.includes(rec.id));   // a shifted header row is not a record
};

// ---------- Bootstrap (first connect) ----------
export async function ensureCloudSetup() {
  const s = settings();
  if (!s.sheetId) {
    const existing = await g.findByName('PayTrack DB', 'application/vnd.google-apps.spreadsheet');
    if (existing) saveSettings({ sheetId: existing.id });
    else {
      const ss = await g.createSpreadsheet('PayTrack DB', ['Jobs', 'Paystubs']);
      saveSettings({ sheetId: ss.spreadsheetId });
      await g.writeRange(ss.spreadsheetId, 'Jobs!A1', [JOB_COLS]);
      await g.writeRange(ss.spreadsheetId, 'Paystubs!A1', [STUB_COLS]);
    }
  }
}

// ---------- Shared calendar choice ----------
// Each install keeps its own settings, so a new install (Dock app, phone)
// used to have NO calendar picked and silently skipped every calendar
// update. The choice now lives on the sheet file: a device without one
// adopts it; a device with one publishes it when the sheet has none.
export async function syncCalendarChoice() { return syncSharedSettings(); }
export async function syncSharedSettings() {
  const s = settings();
  if (!s.sheetId) return;
  const props = await g.getFileProps(s.sheetId);
  const patch = {}, publish = {};
  // Calendar choice: newest calendarChosenAt wins.
  const remoteAt = props.calendarChosenAt || '', localAt = s.calendarChosenAt || '';
  let calendarChanged = false;
  if (props.calendarId && props.calendarId !== s.calendarId && (!s.calendarId || remoteAt > localAt)) {
    Object.assign(patch, { calendarId: props.calendarId, calendarName: props.calendarName || '',
      calendarChosenAt: remoteAt, lastCalPull: '', calSyncToken: '' });
    calendarChanged = !!s.calendarId;
    log('calendarAdopted', { name: props.calendarName || '' });
  } else if (s.calendarId && (!props.calendarId || (props.calendarId !== s.calendarId && localAt > remoteAt))) {
    const at = localAt || store.now();
    if (!localAt) patch.calendarChosenAt = at;
    Object.assign(publish, { calendarId: s.calendarId, calendarName: s.calendarName || '', calendarChosenAt: at });
  }
  // Shared prefs (alert days, payee names): newest prefsAt wins. A device that
  // learned the names before sharing existed seeds the sheet once.
  const remotePrefsAt = props.prefsAt || '', localPrefsAt = s.prefsAt || '';
  const hasNames = !!(s.companyName || s.personalName);
  const asPref = (k, v) => /^alertDays/.test(k) ? (parseInt(v, 10) || (k === 'alertDaysWages' ? 14 : 30)) : String(v ?? '');
  if (!remotePrefsAt && !localPrefsAt && hasNames) {
    const at = store.now();
    patch.prefsAt = at;
    for (const k of SHARED_PREFS) publish[k] = String(s[k] ?? '');
    publish.prefsAt = at;
  } else if (remotePrefsAt > localPrefsAt) {
    for (const k of SHARED_PREFS) if (props[k] !== undefined) patch[k] = asPref(k, props[k]);
    patch.prefsAt = remotePrefsAt;
    log('prefsAdopted', { at: remotePrefsAt });
  } else if (localPrefsAt > remotePrefsAt) {
    for (const k of SHARED_PREFS) publish[k] = String(s[k] ?? '');
    publish.prefsAt = localPrefsAt;
  }
  // Invoice re-arm day: the latest day ANY device did it, so two devices
  // never both move the same reminder.
  if ((props.lastInvoiceNag || '') > (s.lastInvoiceNag || '')) patch.lastInvoiceNag = props.lastInvoiceNag;
  if (Object.keys(patch).length) saveSettings(patch);
  if (Object.keys(publish).length) await g.setFileProps(s.sheetId, publish);
  if (calendarChanged) await resetCalendarLinks();
}
export async function publishPrefs() {
  const s = settings();
  if (!s.sheetId) return;
  const publish = {};
  for (const k of SHARED_PREFS) publish[k] = String(s[k] ?? '');
  publish.prefsAt = s.prefsAt || store.now();
  await g.setFileProps(s.sheetId, publish);
}
export async function publishCalendarChoice() {
  const s = settings();
  if (s.sheetId && s.calendarId) {
    const at = s.calendarChosenAt || store.now();
    if (!s.calendarChosenAt) saveSettings({ calendarChosenAt: at });
    await g.setFileProps(s.sheetId, { calendarId: s.calendarId, calendarName: s.calendarName || '', calendarChosenAt: at });
  }
}

// After the calendar changes (picked here or adopted from another device)
// every job's event links point at the old calendar. Forget them and queue a
// push: reconcile-by-tag then adopts events already on the new calendar or
// creates them.
export async function resetCalendarLinks() {
  for (const job of await store.allJobs()) {
    const blank = { id: job.id };
    for (const k of store.ID_FIELDS) blank[k] = Array.isArray(job[k]) ? [] : '';
    await store.saveJobIds(blank);
    markDirty(job.id);
  }
}
// The user picked a different calendar on THIS device: move the events.
export async function switchCalendar(id, name) {
  const s = settings();
  if (s.calendarId && s.calendarId !== id) {
    for (const job of await store.allJobs({ includeDeleted: true })) {
      if (job.deleted && job.keep_cal) continue;
      try {
        for (const key of ['paytrackJobId', 'paytrackReminderFor']) {
          for (const ev of await g.eventsByPrivateProp(s.calendarId, key, job.id)) await g.deleteEvent(s.calendarId, ev.id);
        }
      } catch (e) { log('calSwitchSweepErr', { project: job.project, msg: String(e.message).slice(0, 120) }); }
    }
  }
  saveSettings({ calendarId: id, calendarName: name, calendarChosenAt: store.now(), lastCalPull: '', calSyncToken: '' });
  await resetCalendarLinks();
  await publishCalendarChoice();
}

// ---------- Sheet mirror ----------
let mirrorTimer = null;
// Something local changed since the last successful mirror. Starts true so a
// freshly loaded device always writes once; a pull never dirties it.
let mirrorDirty = true;
let pullingSheet = false;
let lastPull = null;
store.bus.addEventListener('change', () => { if (!pullingSheet) mirrorDirty = true; });
export function scheduleMirror() {
  mirrorDirty = true;
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => mirrorSheet().catch(e => console.warn('mirror failed', e)), 4000);
}

let mirrorInFlight = null;
export function mirrorSheet(opts = {}) {
  // One mirror at a time — overlapping writes interleave.
  return mirrorInFlight ||= mirrorNow(opts).finally(() => { mirrorInFlight = null; });
}
const colLetter = (n) => {
  let out = '';
  while (n > 0) { const m = (n - 1) % 26; out = String.fromCharCode(65 + m) + out; n = Math.floor((n - 1) / 26); }
  return out;
};
// Write the table from A1 FIRST, then trim what lies below and to the right.
// The tab is never empty, not even for a moment — clear-then-write left it
// blank whenever the write did not land (phone locked, token died).
async function writeTable(sheetId, tab, cols, recs) {
  const table = [cols, ...recs.map(r => toRow(cols, r))];
  await g.writeRange(sheetId, `${tab}!A1`, table);
  await g.batchClear(sheetId, [`${tab}!A${table.length + 1}:ZZ`, `${tab}!${colLetter(cols.length + 1)}1:ZZ`]);
}
async function mirrorNow({ alreadyPulled = false } = {}) {
  const s = settings();
  if (!s.sheetId) return;
  // Merge remote rows first so a full-table write never clobbers a job that
  // another device added since our last pull. If the pull FAILS (expired
  // login, network), abort: writing this device's possibly-stale table over
  // the sheet would erase other devices' records and revert their edits.
  const fresh = alreadyPulled && lastPull && Date.now() - lastPull.at < 60000;
  const pulled = fresh ? lastPull : await pullSheet();
  if (!mirrorDirty) { saveSettings({ lastSheetSync: store.now() }); return; }
  await store.dropStubHusks().catch(() => {});
  mirrorDirty = false;   // anything that changes from here on re-dirties
  try {
    const jobs = await store.allJobs({ includeDeleted: true });
    const stubs = await store.allStubs({ includeDeleted: true });
    // Invariant: the table we write must hold at least every row we just read.
    if (pulled && (jobs.length < pulled.jobs || stubs.length < pulled.stubs)) {
      log('mirrorRefused', { localJobs: jobs.length, sheetJobs: pulled.jobs, localStubs: stubs.length, sheetStubs: pulled.stubs });
      throw new Error('Sheet upload refused: this device holds fewer records than the sheet');
    }
    if (pulled && pulled.jobs === 0 && jobs.length && s.lastSheetSync) log('sheetWasEmpty', { restoring: jobs.length });
    await writeTable(s.sheetId, 'Jobs', JOB_COLS, jobs);
    await writeTable(s.sheetId, 'Paystubs', STUB_COLS, stubs);
  } catch (e) { mirrorDirty = true; throw e; }
  saveSettings({ lastSheetSync: store.now() });
}

export async function pullSheet() {
  const s = settings();
  if (!s.sheetId) return null;
  const jobRows = await g.readRange(s.sheetId, 'Jobs!A1:ZZ');
  let nj = 0, ns = 0;
  for (const rec of fromRows(JOB_COLS, jobRows)) {
    if (rec.id) {
      nj++;
      const conflict = await store.mergeRecord('jobs', rec);
      if (conflict) { await store.addConflict(conflict); log('conflictKept', { project: conflict.project, gapMs: conflict.gapMs }); }
    }
  }
  const stubRows = await g.readRange(s.sheetId, 'Paystubs!A1:ZZ');
  for (const rec of fromRows(STUB_COLS, stubRows)) {
    if (rec.id) { ns++; await store.mergeRecord('stubs', rec); }
  }
  pullingSheet = true;
  try { store.notifyChanged(); } finally { pullingSheet = false; }
  lastPull = { at: Date.now(), jobs: nj, stubs: ns };
  return lastPull;
}

// ---------- Calendar: app -> calendar ----------
const addDays = store.addDays;
// Reminder events are timed; Google needs an explicit zone for recurring ones.
const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();

// One event for the job, reconciled against what is tagged on the calendar:
// keep the linked event (or adopt a tagged one), update it only if something
// changed, remove any other tagged events, insert only when none exists.
// Never trusts a remembered id blindly — a stale id used to insert a duplicate.
async function reconcileSingle(s, job, base, start, endExclusive) {
  const event = { ...base, start: { date: start }, end: { date: endExclusive } };
  const tagged = (await g.eventsByPrivateProp(s.calendarId, 'paytrackJobId', job.id))
    .filter(e => e.status !== 'cancelled');
  const keep = tagged.find(e => e.id === job.calendar_event_id) || tagged[0];
  for (const ev of tagged) if (!keep || ev.id !== keep.id) await g.deleteEvent(s.calendarId, ev.id);
  if (keep) {
    if (keep.summary !== event.summary || (keep.description || '') !== event.description
        || keep.start?.date !== start || keep.end?.date !== endExclusive) {
      await g.patchEvent(s.calendarId, keep.id, event);
    }
    job.calendar_event_id = keep.id;
  } else {
    job.calendar_event_id = (await g.insertEvent(s.calendarId, event)).id;
  }
  job.calendar_event_ids = [];
}

export async function pushJobToCalendar(job) {
  const s = settings();
  // no_cal jobs (imported from the iCloud calendar) stay off the Google
  // calendar — their original event already exists in Apple Calendar.
  if (job.no_cal || !s.calendarId || !job.start_date) return job;
  const base = {
    summary: (job.job_status === 'hold' ? 'HOLD: ' : '')
      + job.project + (job.company ? ` (${job.company})` : ''),
    description: jobToNote(job, await checkRefs(job)) + (job.notes ? `\n${job.notes}` : ''),
    extendedProperties: { private: { paytrackJobId: job.id } },
  };
  const perDay = (job.work_dates || []).filter(Boolean).sort();

  const deleteAll = async () => {
    if (job.calendar_event_id) await g.deleteEvent(s.calendarId, job.calendar_event_id);
    for (const id of job.calendar_event_ids || []) await g.deleteEvent(s.calendarId, id);
    job.calendar_event_id = '';
    job.calendar_event_ids = [];
  };

  if (job.deleted && job.keep_cal) {
    // "Remove from app, keep calendar event": leave every event in place.
  } else if (job.deleted) {
    await deleteAll();
    // The remembered ids can be lost (a repair/restore clears them) — sweep
    // EVERY event still tagged with this job so a deleted job never leaves
    // events behind.
    try {
      for (const key of ['paytrackJobId', 'paytrackReminderFor']) {
        for (const ev of await g.eventsByPrivateProp(s.calendarId, key, job.id)) {
          await g.deleteEvent(s.calendarId, ev.id);
        }
      }
    } catch (e) { log('delSweepErr', String(e.message)); }
  } else if (perDay.length) {
    // Only the days actually worked get calendar events — never a full-week
    // block for a pay period.
    const contiguous = perDay.every((d, i) => i === 0 || d === addDays(perDay[i - 1], 1));
    if (contiguous && job.calendar_event_id && !(job.calendar_event_ids || []).length) {
      // One multi-day event resized to the worked run.
      await reconcileSingle(s, job, base, perDay[0], addDays(perDay[perDay.length - 1], 1));
    } else {
      // One event per worked day, RECONCILED against what is already on the
      // calendar: keep the event for each wanted day (updating its text only
      // if it changed), add missing days, remove extras. Deleting and
      // rebuilding all of them on every save cost ~2 calls per day and let
      // overlapping saves destroy each other's events.
      const tagged = (await g.eventsByPrivateProp(s.calendarId, 'paytrackJobId', job.id))
        .filter(e => e.status !== 'cancelled');
      // Re-read the day list: a merge that landed while we listed events (a
      // day another device just added) must be kept, not deleted as "extra".
      const freshJob = await store.getJob(job.id);
      const days = freshJob && !freshJob.deleted && (freshJob.work_dates || []).length
        ? [...new Set([...perDay, ...freshJob.work_dates])].filter(Boolean).sort() : perDay;
      const want = new Set(days);
      const byDay = new Map();
      const extras = [];
      for (const ev of tagged) {
        const d = ev.start?.date;
        const oneDay = d && ev.end?.date === addDays(d, 1);
        if (oneDay && want.has(d) && !byDay.has(d)) byDay.set(d, ev);
        else extras.push(ev);   // extra day, duplicate, or old span
      }
      const ids = [];
      for (const d of days) {
        const ev = byDay.get(d);
        if (ev) {
          if (ev.summary !== base.summary || (ev.description || '') !== base.description) {
            await g.patchEvent(s.calendarId, ev.id, { summary: base.summary, description: base.description });
          }
          ids.push(ev.id);
        } else {
          const created = await g.insertEvent(s.calendarId,
            { ...base, start: { date: d }, end: { date: addDays(d, 1) } });
          ids.push(created.id);
        }
        job.calendar_event_ids = ids.slice();   // persistable progress if a later call fails
      }
      // Extras go LAST: another device's calendar pull must never see a
      // cancelled linked event with no live replacement yet.
      for (const ev of extras) await g.deleteEvent(s.calendarId, ev.id);
      job.calendar_event_id = '';
      job.calendar_event_ids = ids;
    }
  } else {
    // Whole-span single event (jobs whose exact days aren't specified).
    await reconcileSingle(s, job, base, job.start_date, addDays(job.end_date || job.start_date, 1));
  }
  return job;
}

// ---------- Alerts: reminder events with email + popup ----------
export function unpaidParts(job) {
  const parts = [];
  if (job.wages_status !== 'paid') parts.push('wages');
  if (job.gear_status !== 'paid' && job.gear_status !== 'na') parts.push('gear');
  return parts;
}

// Due date per unpaid part; expected_pay_date (if set) overrides both timers.
export function jobDueDates(job) {
  const s = settings();
  const base = job.end_date || job.start_date;
  // Holds aren't owed anything yet — no due dates, no reminders.
  if (!base || job.deleted || job.job_status === 'hold') return {};
  const out = {};
  if (job.wages_status !== 'paid') {
    out.wages = job.expected_pay_date || addDays(base, Number(s.alertDaysWages) || 14);
  }
  if (job.gear_status !== 'paid' && job.gear_status !== 'na') {
    // Weekly gear invoices: the earliest ended, unpaid week sets the clock.
    const weeks = (job.gear_invoices || []).filter(i => i.status !== 'paid' && (i.end || i.start) && (i.end || i.start) <= store.today())
      .map(i => i.end || i.start).sort();
    out.gear = job.expected_pay_date || addDays(weeks[0] || base, Number(s.alertDaysGear) || 30);
  }
  return out;
}

// One reminder event per (job, kind), reconciled against what is tagged on
// the calendar — never trusts the remembered id blindly, never inserts beside
// a stray, and two devices converge on the same event (smallest id wins).
// If the listing itself fails, fall back to the remembered id.
const alertKey = (ov) => (ov || []).map(o => `${o.method}${o.minutes}`).sort().join();
const sameReminder = (ev, event) => ev.summary === event.summary
  && (ev.description || '') === event.description
  && (ev.start?.dateTime || '').slice(0, 19) === event.start.dateTime
  && !ev.recurrence
  && alertKey(ev.reminders?.overrides) === alertKey(event.reminders.overrides);
async function taggedReminders(s, job, isMine) {
  const all = await g.eventsByPrivateProp(s.calendarId, 'paytrackReminderFor', job.id);
  return all.filter(e => e.status !== 'cancelled' && isMine(e))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
async function reconcileReminder(s, job, idField, isMine, event) {
  let tagged = null;
  try { tagged = await taggedReminders(s, job, isMine); } catch (e) { log('remListErr', String(e.message).slice(0, 120)); }
  const keep = tagged
    ? (tagged.find(e => e.id === job[idField]) || tagged[0])
    : (job[idField] ? { id: job[idField] } : null);
  if (tagged) for (const ev of tagged) if (!keep || ev.id !== keep.id) await g.deleteEvent(s.calendarId, ev.id);
  if (keep) {
    try {
      if (!keep.summary || !sameReminder(keep, event)) await g.patchEvent(s.calendarId, keep.id, event);
      job[idField] = keep.id;
      return;
    } catch (e) { if (!/404|410/.test(e.message)) throw e; }
  }
  job[idField] = (await g.insertEvent(s.calendarId, event)).id;
}
async function removeReminder(s, job, idField, isMine) {
  if (!job[idField]) return;
  let tagged = null;
  try { tagged = await taggedReminders(s, job, isMine); } catch {}
  for (const ev of tagged || [{ id: job[idField] }]) await g.deleteEvent(s.calendarId, ev.id);
  job[idField] = '';
}
const ALERTS = { useDefault: false, overrides: [{ method: 'email', minutes: 5 }, { method: 'popup', minutes: 5 }] };

async function upsertPartReminder(job, part, idField, due) {
  const s = settings();
  const isMine = (ev) => (ev.summary || '').endsWith(`${part} unpaid`);
  if (!due) { await removeReminder(s, job, idField, isMine); return; }
  // A due date whose alert has already passed would never notify — nudge it
  // to the next day that can still alert.
  const earliest = store.earliestNagDay();
  if (due < earliest) due = earliest;
  const event = {
    summary: `💰 Follow up: ${job.project || 'job'} ${part} unpaid`,
    description: `PayTrack alert — ${jobToNote(job)}`,
    start: { dateTime: `${due}T09:00:00`, timeZone: TZ },
    end: { dateTime: `${due}T09:30:00`, timeZone: TZ },
    reminders: ALERTS,
    extendedProperties: { private: { paytrackReminderFor: job.id } },
  };
  await reconcileReminder(s, job, idField, isMine, event);
}

// Weekly gear invoices nag once their week has ended and they're not sent.
function unsentGearWeeks(job) {
  const todayIso = store.today();
  return (job.gear_invoices || [])
    .filter(i => i.status === 'unsent' && (i.end || i.start) && (i.end || i.start) <= todayIso);
}
function invoiceReminderWanted(job) {
  return !job.deleted && job.job_status !== 'hold'
    && ((job.invoice_status === 'unsent' && !!(job.end_date || job.start_date)) || unsentGearWeeks(job).length > 0);
}

async function upsertInvoiceReminder(job) {
  const s = settings();
  const gearUnsent = unsentGearWeeks(job);
  const isMine = (ev) => (ev.summary || '').startsWith('Send invoice:');
  if (!invoiceReminderWanted(job)) { await removeReminder(s, job, 'invoice_reminder_event_id', isMine); return; }
  // The earliest slot that can still alert (see store.earliestNagDay).
  const earliest = store.earliestNagDay();
  const dueDates = [];
  if (job.invoice_status === 'unsent' && (job.end_date || job.start_date)) {
    dueDates.push(addDays(job.end_date || job.start_date, 1));
  }
  for (const i of gearUnsent) dueDates.push(addDays(i.end || i.start, 1));
  let due = dueDates.sort()[0];
  if (due < earliest) due = earliest;
  const gearNote = gearUnsent.length
    ? ` ${gearUnsent.length} weekly gear invoice${gearUnsent.length === 1 ? '' : 's'} unsent.`
    : '';
  const event = {
    summary: `Send invoice: ${job.project || 'job'}`,
    description: `PayTrack — invoice not sent yet.${gearNote} Mark it "Sent" in the app to clear this reminder.`,
    start: { dateTime: `${due}T09:00:00`, timeZone: TZ },
    end: { dateTime: `${due}T09:15:00`, timeZone: TZ },
    recurrence: [],   // explicit: a patch of an older daily-repeating reminder clears its series
    reminders: ALERTS,
    extendedProperties: { private: { paytrackReminderFor: job.id } },
  };
  await reconcileReminder(s, job, 'invoice_reminder_event_id', isMine, event);
}

// Wages and gear run on separate timers, so each unpaid part gets its own
// reminder event; paying one part clears only its reminder.
export async function syncReminder(job) {
  const s = settings();
  if (!s.calendarId) return job;
  const dues = jobDueDates(job);   // empty when deleted or undated
  await upsertPartReminder(job, 'wages', 'reminder_event_id', dues.wages);
  await upsertPartReminder(job, 'gear', 'gear_reminder_event_id', dues.gear);
  await upsertInvoiceReminder(job);
  return job;
}

// Push a job everywhere after an in-app edit. Event ids are persisted after
// EVERY stage, even on failure — losing a freshly created event's id is how
// duplicates were born (each retry inserted another copy).
// Pushes of the SAME job run one at a time. Overlapping pushes (e.g. four
// paychecks saved within two minutes) each swept and rebuilt the job's
// per-day events, deleting one another's fresh events — the job ended up
// linked to events that no longer existed, and the calendar pull then read
// them as "the user deleted this job". Each queued push starts from the
// freshest stored copy, so a later save is never overwritten by an earlier one.
const pushQueues = new Map();
function queued(id, fn) {
  const prev = pushQueues.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  pushQueues.set(id, run);
  run.finally(() => { if (pushQueues.get(id) === run) pushQueues.delete(id); }).catch(() => {});
  return run;
}
export function pushJob(job) {
  return queued(job.id, () => pushJobNow(job.id, job));
}

// Once a day, move every unsent invoice's single reminder forward to the
// next slot that can still alert (see upsertInvoiceReminder), so a fresh
// email + notification goes out each morning the invoice stays unsent. The
// day marker is shared through the sheet file so two devices never both do
// it; a job whose patch failed is retried on later syncs without blocking
// the others.
const nagFailed = new Set();
export async function rearmInvoiceReminders() {
  const s = settings();
  if (!s.calendarId) return;
  const todayIso = store.today();
  const dueToday = s.lastInvoiceNag !== todayIso;
  if (!dueToday && !nagFailed.size) return;
  for (const job of await store.allJobs()) {
    if (!invoiceReminderWanted(job)) { nagFailed.delete(job.id); continue; }
    if (!dueToday && !nagFailed.has(job.id)) continue;
    await queued(job.id, async () => {
      const j = (await store.getJob(job.id)) || job;
      const before = store.pickIds(j);
      try { await upsertInvoiceReminder(j); } finally { await store.saveJobIds(j, before); }
      if (j.invoice_reminder_event_id !== before.invoice_reminder_event_id) scheduleMirror();   // other devices must learn the new id
      nagFailed.delete(job.id);
    }).catch(e => { nagFailed.add(job.id); log('invNagErr', { project: job.project, msg: String(e.message).slice(0, 120) }); });
  }
  if (dueToday) {
    saveSettings({ lastInvoiceNag: todayIso });
    if (s.sheetId) g.setFileProps(s.sheetId, { lastInvoiceNag: todayIso }).catch(() => {});
  }
}

async function pushJobNow(id, fallback) {
  const job = (await store.getJob(id)) || fallback;
  // Only the calendar ids THIS push changed are written back (onto the
  // freshest stored copy, stamp untouched): a save or merge that lands while
  // the network calls run must not be overwritten by the starting snapshot.
  const before = store.pickIds(job);
  try {
    await pushJobToCalendar(job);
  } finally {
    await store.saveJobIds(job, before);
  }
  try {
    await syncReminder(job);
  } finally {
    await store.saveJobIds(job, before);
  }
  scheduleMirror();
  return job;
}

// Jobs whose calendar push has not succeeded yet (expired login, offline,
// API error) — remembered across reloads and retried on every sync, deleted
// jobs included, so an edit made while disconnected still reaches the
// calendar and its reminders.
const DIRTY_KEY = 'paytrack.dirtyPush';
const dirtyIds = () => { try { return JSON.parse(localStorage.getItem(DIRTY_KEY) || '[]'); } catch { return []; } };
const setDirty = (ids) => { try { localStorage.setItem(DIRTY_KEY, JSON.stringify([...new Set(ids)].slice(-200))); } catch {} };
export function markDirty(id) { setDirty([...dirtyIds(), id]); }
export function pushSoon(job) {
  setDirty([...dirtyIds(), job.id]);
  const run = pushJob(job);
  return run.then((r) => {
    // Only the LAST queued push for this job clears its dirty mark — an
    // earlier success must not forget a later push that then fails.
    if (!pushQueues.has(job.id) || pushQueues.get(job.id) === run) setDirty(dirtyIds().filter(x => x !== job.id));
    return r;
  });
}
export async function pushDirty() {
  if (!settings().calendarId) return;
  for (const id of dirtyIds()) {
    const job = await store.getJob(id);
    if (!job) { setDirty(dirtyIds().filter(x => x !== id)); continue; }
    await pushJob(job).then(() => setDirty(dirtyIds().filter(x => x !== id)))
      .catch(e => log('dirtyPushErr', { project: job.project, msg: String(e.message).slice(0, 120) }));
  }
}

// One-time sweep: collapse every duplicated PayTrack event on the calendar.
// Keeps one event per job per day (preferring the ids the app remembers),
// deletes the rest, and heals the stored ids. Reminders likewise.
export async function cleanupCalendarDuplicates(onProgress) {
  const s = settings();
  if (!s.calendarId) throw new Error('Pick a calendar in Setup first.');
  // Work from merged data: a device that sat idle may still think a job is
  // deleted that another device restored.
  await pullSheet();
  const jobs = await store.allJobs({ includeDeleted: true });
  let removed = 0, i = 0;
  for (const job of jobs) {
    i++;
    if (onProgress && i % 5 === 0) onProgress(i, jobs.length, removed);
    let evs = [];
    try { evs = await g.eventsByPrivateProp(s.calendarId, 'paytrackJobId', job.id); }
    catch (e) { log('cleanupListErr', String(e.message)); continue; }
    if (evs.length && job.deleted && !job.keep_cal) {
      // A deleted job keeps NO events — remove every tagged one.
      for (const ev of evs) {
        await g.deleteEvent(s.calendarId, ev.id);
        removed++;
      }
    } else if (evs.length && !job.deleted) {
      const known = new Set([job.calendar_event_id, ...(job.calendar_event_ids || [])].filter(Boolean));
      const byDate = {};
      for (const ev of evs) {
        const d = ev.start?.date || (ev.start?.dateTime || '').slice(0, 10) || '?';
        (byDate[d] ||= []).push(ev);
      }
      const keepIds = [];
      for (const group of Object.values(byDate)) {
        group.sort((a, b) => (known.has(b.id) ? 1 : 0) - (known.has(a.id) ? 1 : 0)
          || (a.created || '').localeCompare(b.created || ''));
        keepIds.push(group[0].id);
        for (const ev of group.slice(1)) {
          await g.deleteEvent(s.calendarId, ev.id);
          removed++;
        }
      }
      if (!job.deleted) {
        if ((job.work_dates || []).length && keepIds.length > 1) {
          job.calendar_event_ids = keepIds;
          job.calendar_event_id = '';
        } else if (keepIds.length >= 1 && !(job.work_dates || []).length) {
          job.calendar_event_id = keepIds.includes(job.calendar_event_id) ? job.calendar_event_id : keepIds[0];
          job.calendar_event_ids = [];
        }
        await store.saveJobIds(job);
      }
    }
    let rem = [];
    try { rem = await g.eventsByPrivateProp(s.calendarId, 'paytrackReminderFor', job.id); }
    catch { continue; }
    const keepRem = new Set([job.reminder_event_id, job.gear_reminder_event_id, job.invoice_reminder_event_id].filter(Boolean));
    const bySummary = {};
    for (const ev of rem) (bySummary[ev.summary || ''] ||= []).push(ev);
    for (const group of Object.values(bySummary)) {
      group.sort((a, b) => (keepRem.has(b.id) ? 1 : 0) - (keepRem.has(a.id) ? 1 : 0)
        || (b.created || '').localeCompare(a.created || ''));
      // Deleted jobs keep no reminders at all; live jobs keep one per part.
      const keep = job.deleted ? null : group[0];
      for (const ev of group) {
        if (keep && ev.id === keep.id) continue;
        await g.deleteEvent(s.calendarId, ev.id);
        removed++;
      }
    }
  }
  log('cleanup', { removed, jobs: jobs.length });
  scheduleMirror();
  return removed;
}

// Catch-up: any job that never made it onto the calendar (e.g. created
// from a stub while offline) gets pushed on the next sync.
export async function pushUnsynced() {
  const s = settings();
  if (!s.calendarId) return;
  const jobs = await store.allJobs();
  for (const job of jobs) {
    if (!job.no_cal && !job.calendar_event_id && !(job.calendar_event_ids?.length) && job.start_date) {
      await pushJob(job).catch(e => console.warn('catch-up push', e));
    }
  }
}

// ---------- Calendar: calendar -> app ----------
export async function pullCalendar() {
  const s = settings();
  if (!s.calendarId) return;
  // Incremental sync with Google's own token: the exact change feed since the
  // last pull, no clock windows. The first pull (and a fresh one every 60
  // days, so the time horizon moves, or after a 410) lists the window and
  // keeps the token it returns. The token is only advanced when every change
  // was handled, so a skipped item is replayed next time.
  const windowParams = () => ({
    showDeleted: 'true', singleEvents: 'true',
    timeMin: new Date(Date.now() - 400 * 86400000).toISOString(),
    timeMax: new Date(Date.now() + 180 * 86400000).toISOString(),
  });
  let items, nextSyncToken = '', skipped = false, full = false;
  const stale = !s.calSyncAt || Date.now() - Date.parse(s.calSyncAt) > 60 * 86400000;
  const pullStarted = new Date(Date.now() - 120000).toISOString();
  try {
    if (s.calSyncToken && !stale) {
      ({ items, nextSyncToken } = await g.listEvents(s.calendarId, { syncToken: s.calSyncToken, showDeleted: 'true', singleEvents: 'true' }));
    } else {
      full = true;
      ({ items, nextSyncToken } = await g.listEvents(s.calendarId, windowParams()));
    }
  } catch (e) {
    // An expired token (410) or a malformed request (400): full re-list.
    if (/4(00|10)/.test(e.message)) {
      log('pullCalRetry', { msg: String(e.message).slice(0, 200) });
      full = true;
      ({ items, nextSyncToken } = await g.listEvents(s.calendarId, windowParams()));
    } else throw e;
  }
  for (const ev of items) {
    const jobId = ev.extendedProperties?.private?.paytrackJobId;
    if (jobId) {
      const job = await store.getJob(jobId);
      // A deleted job stays deleted — calendar edits must not revive or
      // touch it (its event may deliberately outlive it).
      if (!job || job.deleted) continue;
      // A full listing carries every cancellation ever made; only recent ones
      // can be the user's doing.
      if (full && ev.status === 'cancelled' && Date.parse(ev.updated || 0) < Date.now() - 7 * 86400000) continue;
      if ((ev.updated || '') <= (job.updated_at || '')) continue;  // our own push
      if (ev.status === 'cancelled') {
        // Only a CURRENTLY-linked event's cancellation can mean the user
        // removed the job from the calendar. The app itself cancels stale
        // tagged events whenever a push replaces them.
        const known = ev.id === job.calendar_event_id
          || (job.calendar_event_ids || []).includes(ev.id);
        if (!known) continue;
        // The other device may be mid-rebuild (old events cancelled, new ones
        // not inserted yet): a cancellation this fresh is re-examined next pull.
        if (Date.now() - Date.parse(ev.updated || 0) < 120000) { skipped = true; continue; }
        // Delete the job only when NONE of its events survive. If live tagged
        // events remain, relink to those instead of discarding the job.
        let live = [];
        try {
          live = (await g.eventsByPrivateProp(s.calendarId, 'paytrackJobId', job.id))
            .filter(e => e.status !== 'cancelled');
        } catch (e) { log('relinkListErr', String(e.message)); skipped = true; continue; }
        if (live.length) {
          if ((job.calendar_event_ids || []).length || live.length > 1) {
            job.calendar_event_ids = live.map(e => e.id);
            job.calendar_event_id = '';
          } else {
            job.calendar_event_id = live[0].id;
            job.calendar_event_ids = [];
          }
          await store.saveJobIds(job);
          log('calRelinked', { project: job.project, events: live.length });
        } else {
          // A real change: stamp it so the deletion syncs everywhere.
          const fresh = (await store.getJob(job.id)) || job;
          fresh.deleted = true;
          await store.putJob(fresh, { silent: true });
          await syncReminder(fresh).catch(() => {});
          await store.saveJobIds(fresh);
          log('calDeletedJob', { project: job.project });
        }
        continue;
      }
      // A live event changed. The ONLY thing taken from the calendar is a
      // date move of a whole-span event (the user dragged it). Pay status,
      // rates and gear are never read back from the event's note: the note
      // is generated by the app, so an older device re-reading another
      // device's push used to overwrite newer data with what it parsed.
      if (job.work_dates?.length || !ev.start?.date || !ev.end?.date) continue;
      const start = ev.start.date, end = addDays(ev.end.date, -1);
      if (start === job.start_date && end === (job.end_date || job.start_date)) continue;
      const fresh = (await store.getJob(job.id)) || job;
      fresh.start_date = start;
      fresh.end_date = end;
      await store.putJob(fresh, { silent: true });
      await syncReminder(fresh).catch(() => {});
      await store.saveJobIds(fresh);
      log('calMovedJob', { project: job.project, start, end });
    } else if (ev.status !== 'cancelled'
        && !ev.extendedProperties?.private?.paytrackReminderFor
        && looksLikeJob(ev.summary, ev.description)) {
      // Only recent events get auto-queued — an OLD event that merely got
      // touched shouldn't resurface as an import suggestion.
      const q = eventToQueued(ev);
      const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      if ((q.start || '') >= cutoff) await store.queueImport(q);
    }
  }
  // Next pull starts from just before THIS one began (events changed while
  // we were processing must not be missed); not advanced if anything was
  // skipped on an error.
  if (!skipped) {
    saveSettings({ lastCalPull: pullStarted, calSyncToken: nextSyncToken || s.calSyncToken || '',
      calSyncAt: full ? new Date().toISOString() : (s.calSyncAt || new Date().toISOString()) });
  }
  store.notifyChanged();
}

function eventToQueued(ev) {
  return {
    id: ev.id,
    summary: ev.summary || '',
    description: ev.description || '',
    start: ev.start?.date || (ev.start?.dateTime || '').slice(0, 10),
    end: ev.end?.date ? addDays(ev.end.date, -1) : (ev.end?.dateTime || '').slice(0, 10),
  };
}

// One-time scan of past events that look like job entries.
export async function historyImportScan(fromDate) {
  const s = settings();
  if (!s.calendarId) throw new Error('Pick a calendar in Setup first.');
  const from = fromDate || `${new Date().getFullYear()}-01-01`;
  const { items } = await g.listEvents(s.calendarId, {
    timeMin: `${from}T00:00:00Z`, singleEvents: 'true', orderBy: 'startTime',
  });
  let queued = 0;
  const existing = await store.allJobs({ includeDeleted: true });
  const linked = new Set(existing.map(j => j.calendar_event_id).filter(Boolean));
  for (const ev of items) {
    if (ev.extendedProperties?.private?.paytrackJobId) continue;
    if (ev.extendedProperties?.private?.paytrackReminderFor) continue;
    if (linked.has(ev.id)) continue;
    if (!looksLikeJob(ev.summary, ev.description)) continue;
    await store.queueImport(eventToQueued(ev));
    queued++;
  }
  return queued;
}

// Accept a queued calendar event as a job.
export async function importQueuedAsJob(item, { push = true } = {}) {
  const note = parseJobNote(`${item.summary} ${item.description}`);
  const job = {
    ...store.blankJob(),
    project: item.summary.replace(/\$\s?\d[^ ]*/g, '').trim() || item.summary,
    start_date: item.start || '',
    end_date: item.end || item.start || '',
    rate_amount: note.rate_amount, rate_hours: note.rate_hours,
    rate_text: note.rate_text,
    gear_total: note.gear_total, gear_rate: note.gear_rate,
    gear_period: note.gear_period || 'day',
    wages_status: note.wages_status || 'unpaid',
    gear_status: note.gear_status || (note.gear_total || note.gear_rate ? 'unpaid' : 'na'),
    job_status: /^\s*hold(\b|:)|\bshow\s+hold\b|\bhold\s+for\b/i.test(item.summary)
      && note.wages_status !== 'paid' ? 'hold' : 'confirmed',
    // Imported history that's already paid doesn't need invoice nagging.
    invoice_status: note.wages_status === 'paid' ? 'na' : 'unsent',
    calendar_event_id: item.no_cal ? '' : item.id,
    no_cal: !!item.no_cal,
    notes: item.description || '',
  };
  store.calcGearTotal(job);
  await store.putJob(job);
  await store.dequeueImport(item.id);
  if (push) {
    const s = settings();
    if (!job.no_cal) {
      // Tag the existing event so future edits round-trip; keep user's text.
      await g.patchEvent(s.calendarId, item.id,
        { extendedProperties: { private: { paytrackJobId: job.id } } })
        .catch(async (e) => {
          // Untagged, the link is blind: reconcile-by-tag would insert a
          // duplicate on the first edit. Forget the id and let the next push
          // create a tagged event instead.
          log('importTagErr', { project: job.project, msg: String(e.message).slice(0, 120) });
          job.calendar_event_id = '';
          await store.saveJobIds(job);
          markDirty(job.id);
        });
    }
    await syncReminder(job).catch(() => {});
    await store.putJob(job, { silent: true });
    scheduleMirror();
  }
  return job;
}
