// Cloud sync: Google Sheet mirror (backup + multi-device bootstrap),
// two-way calendar sync, and reminder (alert) events.
import { settings, saveSettings } from './config.js';
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
  'rate_hourly', 'travel_dates', 'gear_invoices', 'keep_cal'];
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
  'gear_total', 'hours', 'gross', 'net', 'total_deductions'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const coerce = (c, raw) => {
  const v = raw ?? '';
  if (JSON_COLS.includes(c)) {
    try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  if (NUM_COLS.includes(c)) {
    const n = parseFloat(v);
    return v === '' || Number.isNaN(n) ? null : n;
  }
  if (c === 'deleted' || c === 'no_cal' || c === 'keep_cal') return v === 'true';
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
  return rows.slice(1).map(row => {
    const rec = {};
    if (known.length >= 5) {
      header.forEach((hc, i) => { if (cols.includes(hc)) rec[hc] = coerce(hc, row[i]); });
    } else {
      // No sane header (hand-edited sheet): fall back to positional.
      cols.forEach((c, i) => rec[c] = coerce(c, row[i]));
    }
    return rec;
  });
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
export async function syncCalendarChoice() {
  const s = settings();
  if (!s.sheetId) return;
  const props = await g.getFileProps(s.sheetId);
  const remoteAt = props.calendarChosenAt || '';
  const localAt = s.calendarChosenAt || '';
  if (props.calendarId && props.calendarId !== s.calendarId && (!s.calendarId || remoteAt > localAt)) {
    // Another device picked (or re-picked) the calendar more recently.
    saveSettings({ calendarId: props.calendarId, calendarName: props.calendarName || '',
      calendarChosenAt: remoteAt, lastCalPull: '' });
    log('calendarAdopted', { name: props.calendarName || '' });
  } else if (s.calendarId && (!props.calendarId || (props.calendarId !== s.calendarId && localAt > remoteAt))) {
    await publishCalendarChoice();
  }
}
export async function publishCalendarChoice() {
  const s = settings();
  if (s.sheetId && s.calendarId) {
    const at = s.calendarChosenAt || store.now();
    if (!s.calendarChosenAt) saveSettings({ calendarChosenAt: at });
    await g.setFileProps(s.sheetId, { calendarId: s.calendarId, calendarName: s.calendarName || '', calendarChosenAt: at });
  }
}

// ---------- Sheet mirror ----------
let mirrorTimer = null;
export function scheduleMirror() {
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => mirrorSheet().catch(e => console.warn('mirror failed', e)), 4000);
}

let mirrorInFlight = null;
export function mirrorSheet() {
  // One mirror at a time — overlapping clear+write pairs interleave.
  return mirrorInFlight ||= mirrorNow().finally(() => { mirrorInFlight = null; });
}
async function mirrorNow() {
  const s = settings();
  if (!s.sheetId) return;
  // Merge remote rows first so a full-table write never clobbers a job that
  // another device added since our last pull. If the pull FAILS (expired
  // login, network), abort: writing this device's possibly-stale table over
  // the sheet would erase other devices' records and revert their edits.
  await pullSheet();
  await store.dropStubHusks().catch(() => {});
  const jobs = await store.allJobs({ includeDeleted: true });
  const stubs = await store.allStubs({ includeDeleted: true });
  // Clear the header row too: a leftover header cell from a device with more
  // columns would sit over blank data and read back as "empty", wiping values.
  await g.clearRange(s.sheetId, 'Jobs!A1:ZZ');
  await g.writeRange(s.sheetId, 'Jobs!A1',
    [JOB_COLS, ...jobs.map(j => toRow(JOB_COLS, j))]);
  await g.clearRange(s.sheetId, 'Paystubs!A1:ZZ');
  await g.writeRange(s.sheetId, 'Paystubs!A1',
    [STUB_COLS, ...stubs.map(st => toRow(STUB_COLS, st))]);
  saveSettings({ lastSheetSync: store.now() });
}

export async function pullSheet() {
  const s = settings();
  if (!s.sheetId) return;
  const jobRows = await g.readRange(s.sheetId, 'Jobs!A1:ZZ');
  for (const rec of fromRows(JOB_COLS, jobRows)) {
    if (rec.id) await store.mergeRecord('jobs', rec);
  }
  const stubRows = await g.readRange(s.sheetId, 'Paystubs!A1:ZZ');
  for (const rec of fromRows(STUB_COLS, stubRows)) {
    if (rec.id) await store.mergeRecord('stubs', rec);
  }
  store.notifyChanged();
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
      for (const ev of await g.eventsByPrivateProp(s.calendarId, 'paytrackJobId', job.id)) {
        await g.deleteEvent(s.calendarId, ev.id);
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
      const want = new Set(perDay);
      const byDay = new Map();
      for (const ev of tagged) {
        const d = ev.start?.date;
        const oneDay = d && ev.end?.date === addDays(d, 1);
        if (oneDay && want.has(d) && !byDay.has(d)) byDay.set(d, ev);
        else await g.deleteEvent(s.calendarId, ev.id);   // extra day, duplicate, or old span
      }
      const ids = [];
      for (const d of perDay) {
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
    out.gear = job.expected_pay_date || addDays(base, Number(s.alertDaysGear) || 30);
  }
  return out;
}

async function upsertPartReminder(job, part, idField, due) {
  const s = settings();
  if (!due) {
    if (job[idField]) {
      await g.deleteEvent(s.calendarId, job[idField]);
      job[idField] = '';
    }
    return;
  }
  // A due date in the past would never notify — nudge it to tomorrow.
  const tomorrow = addDays(store.today(), 1);
  if (due < tomorrow) due = tomorrow;
  const event = {
    summary: `💰 Follow up: ${job.project || 'job'} ${part} unpaid`,
    description: `PayTrack alert — ${jobToNote(job)}`,
    start: { dateTime: `${due}T09:00:00`, timeZone: TZ },
    end: { dateTime: `${due}T09:30:00`, timeZone: TZ },
    reminders: {
      useDefault: false,
      overrides: [{ method: 'email', minutes: 1 }, { method: 'popup', minutes: 1 }],
    },
    extendedProperties: { private: { paytrackReminderFor: job.id } },
  };
  if (job[idField]) {
    await g.patchEvent(s.calendarId, job[idField], event)
      .catch(async e => {
        if (/404|410/.test(e.message)) {
          const created = await g.insertEvent(s.calendarId, event);
          job[idField] = created.id;
        } else throw e;
      });
  } else {
    // Adopt an existing reminder for this job+part before inserting a new one.
    let created = null;
    try {
      const existing = (await g.eventsByPrivateProp(s.calendarId, 'paytrackReminderFor', job.id))
        .filter(ev => (ev.summary || '').endsWith(`${part} unpaid`));
      if (existing.length) {
        created = existing[0];
        await g.patchEvent(s.calendarId, created.id, event).catch(() => {});
        for (const stray of existing.slice(1)) await g.deleteEvent(s.calendarId, stray.id);
      }
    } catch (e) { log('adoptRemErr', String(e.message)); }
    if (!created) created = await g.insertEvent(s.calendarId, event);
    job[idField] = created.id;
  }
}

// Unsent invoice: a DAILY recurring nag (email + notification) that starts
// the day after wrap and disappears the moment the invoice is marked sent.
async function upsertInvoiceReminder(job) {
  const s = settings();
  const todayIso = store.today();
  // Weekly gear invoices nag once their week has ended and they're not sent.
  const gearUnsent = (job.gear_invoices || [])
    .filter(i => i.status === 'unsent' && (i.end || i.start) && (i.end || i.start) <= todayIso);
  const wanted = !job.deleted && job.job_status !== 'hold'
    && ((job.invoice_status === 'unsent' && (job.end_date || job.start_date)) || gearUnsent.length);
  if (!wanted) {
    if (job.invoice_reminder_event_id) {
      await g.deleteEvent(s.calendarId, job.invoice_reminder_event_id);
      job.invoice_reminder_event_id = '';
    }
    return;
  }
  const tomorrow = addDays(todayIso, 1);
  const dueDates = [];
  if (job.invoice_status === 'unsent' && (job.end_date || job.start_date)) {
    dueDates.push(addDays(job.end_date || job.start_date, 1));
  }
  for (const i of gearUnsent) dueDates.push(addDays(i.end || i.start, 1));
  let due = dueDates.sort()[0];
  if (due < tomorrow) due = tomorrow;
  const gearNote = gearUnsent.length
    ? ` ${gearUnsent.length} weekly gear invoice${gearUnsent.length === 1 ? '' : 's'} unsent.`
    : '';
  const event = {
    summary: `Send invoice: ${job.project || 'job'}`,
    description: `PayTrack — invoice not sent yet.${gearNote} Mark it "Sent" in the app to stop this daily reminder.`,
    start: { dateTime: `${due}T09:00:00`, timeZone: TZ },
    end: { dateTime: `${due}T09:15:00`, timeZone: TZ },
    recurrence: ['RRULE:FREQ=DAILY'],
    reminders: {
      useDefault: false,
      overrides: [{ method: 'email', minutes: 1 }, { method: 'popup', minutes: 1 }],
    },
    extendedProperties: { private: { paytrackReminderFor: job.id } },
  };
  if (job.invoice_reminder_event_id) {
    await g.patchEvent(s.calendarId, job.invoice_reminder_event_id, event)
      .catch(async e => {
        if (/404|410/.test(e.message)) {
          const created = await g.insertEvent(s.calendarId, event);
          job.invoice_reminder_event_id = created.id;
        } else throw e;
      });
  } else {
    let created = null;
    try {
      const existing = (await g.eventsByPrivateProp(s.calendarId, 'paytrackReminderFor', job.id))
        .filter(ev => (ev.summary || '').startsWith('Send invoice:'));
      if (existing.length) {
        created = existing[0];
        await g.patchEvent(s.calendarId, created.id, event).catch(() => {});
        for (const stray of existing.slice(1)) await g.deleteEvent(s.calendarId, stray.id);
      }
    } catch (e) { log('adoptInvErr', String(e.message)); }
    if (!created) created = await g.insertEvent(s.calendarId, event);
    job.invoice_reminder_event_id = created.id;
  }
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
export function pushJob(job) {
  const id = job.id;
  const prev = pushQueues.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => pushJobNow(id, job));
  pushQueues.set(id, run);
  run.finally(() => { if (pushQueues.get(id) === run) pushQueues.delete(id); }).catch(() => {});
  return run;
}

async function pushJobNow(id, fallback) {
  const job = (await store.getJob(id)) || fallback;
  // Only the calendar ids are written back (onto the freshest stored copy,
  // stamp untouched): a save or merge that lands while the network calls
  // run must not be overwritten by this push's starting snapshot.
  try {
    await pushJobToCalendar(job);
  } finally {
    await store.saveJobIds(job);
  }
  try {
    await syncReminder(job);
  } finally {
    await store.saveJobIds(job);
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
export function pushSoon(job) {
  setDirty([...dirtyIds(), job.id]);
  return pushJob(job).then((r) => { setDirty(dirtyIds().filter(x => x !== job.id)); return r; });
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
  const recent = () => new Date(Date.now() - 7 * 86400000).toISOString();
  const params = (since) => ({
    updatedMin: since, showDeleted: 'true', singleEvents: 'true',
    timeMin: new Date(Date.now() - 400 * 86400000).toISOString(),
  });
  let items, skipped = false;
  const pullStarted = new Date(Date.now() - 120000).toISOString();
  try {
    ({ items } = await g.listEvents(s.calendarId, params(s.lastCalPull || recent())));
  } catch (e) {
    // Google rejects an updatedMin that lies too far in the past (410) or is
    // malformed (400) — fall back to a recent window and carry on.
    if (/4(00|10)/.test(e.message)) {
      log('pullCalRetry', { msg: String(e.message).slice(0, 200) });
      ({ items } = await g.listEvents(s.calendarId, params(recent())));
    } else throw e;
  }
  for (const ev of items) {
    const jobId = ev.extendedProperties?.private?.paytrackJobId;
    if (jobId) {
      const job = await store.getJob(jobId);
      // A deleted job stays deleted — calendar edits must not revive or
      // touch it (its event may deliberately outlive it).
      if (!job || job.deleted) continue;
      if ((ev.updated || '') <= (job.updated_at || '')) continue;  // our own push
      if (ev.status === 'cancelled') {
        // Only a CURRENTLY-linked event's cancellation can mean the user
        // removed the job from the calendar. The app itself cancels stale
        // tagged events whenever a push replaces them.
        const known = ev.id === job.calendar_event_id
          || (job.calendar_event_ids || []).includes(ev.id);
        if (!known) continue;
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
  if (!skipped) saveSettings({ lastCalPull: pullStarted });
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
        { extendedProperties: { private: { paytrackJobId: job.id } } }).catch(() => {});
    }
    await syncReminder(job).catch(() => {});
    await store.putJob(job, { silent: true });
    scheduleMirror();
  }
  return job;
}
