// Cloud sync: Google Sheet mirror (backup + multi-device bootstrap),
// two-way calendar sync, and reminder (alert) events.
import { settings, saveSettings } from './config.js';
import * as g from './google.js';
import * as store from './store.js';
import { parseJobNote, looksLikeJob, jobToNote } from './parse.js';

const JOB_COLS = ['id', 'project', 'company', 'start_date', 'end_date', 'days_worked', 'rate_amount',
  'rate_hours', 'rate_text', 'gear_rate', 'gear_period', 'gear_total', 'wages_status', 'gear_status',
  'expected_pay_date', 'calendar_event_id', 'reminder_event_id', 'gear_reminder_event_id',
  'no_cal', 'notes', 'updated_at', 'deleted'];
const STUB_COLS = ['id', 'drive_file_id', 'photo_name', 'vendor', 'project_name', 'employer',
  'payee', 'classification', 'period_start', 'period_end', 'hourly_rates', 'hours',
  'gross', 'net', 'check_no', 'check_date', 'matched_job_id', 'earnings',
  'created_at', 'updated_at'];

const toRow = (cols, rec) => cols.map(c => {
  const v = rec[c];
  if (c === 'earnings') return JSON.stringify(v || []);
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join('|');
  return String(v);
});

const fromRow = (cols, row) => {
  const rec = {};
  cols.forEach((c, i) => {
    let v = row[i] ?? '';
    if (c === 'earnings') {
      try { v = JSON.parse(v || '[]'); } catch { v = []; }
      rec[c] = v;
      return;
    }
    if (['days_worked', 'rate_amount', 'rate_hours', 'gear_rate', 'gear_total', 'hours', 'gross', 'net'].includes(c)) {
      v = v === '' ? null : parseFloat(v);
    } else if (c === 'deleted' || c === 'no_cal') v = v === 'true';
    else if (c === 'hourly_rates') v = v ? v.split('|').map(Number) : [];
    rec[c] = v;
  });
  return rec;
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

// ---------- Sheet mirror ----------
let mirrorTimer = null;
export function scheduleMirror() {
  clearTimeout(mirrorTimer);
  mirrorTimer = setTimeout(() => mirrorSheet().catch(e => console.warn('mirror failed', e)), 4000);
}

export async function mirrorSheet() {
  const s = settings();
  if (!s.sheetId) return;
  const jobs = await store.allJobs({ includeDeleted: true });
  const stubs = await store.allStubs();
  await g.clearRange(s.sheetId, 'Jobs!A2:Z');
  await g.writeRange(s.sheetId, 'Jobs!A1',
    [JOB_COLS, ...jobs.map(j => toRow(JOB_COLS, j))]);
  await g.clearRange(s.sheetId, 'Paystubs!A2:Z');
  await g.writeRange(s.sheetId, 'Paystubs!A1',
    [STUB_COLS, ...stubs.map(st => toRow(STUB_COLS, st))]);
  saveSettings({ lastSheetSync: store.now() });
}

export async function pullSheet() {
  const s = settings();
  if (!s.sheetId) return;
  const jobRows = await g.readRange(s.sheetId, 'Jobs!A2:Z');
  for (const row of jobRows) {
    const rec = fromRow(JOB_COLS, row);
    if (rec.id) await store.mergeRecord('jobs', rec);
  }
  const stubRows = await g.readRange(s.sheetId, 'Paystubs!A2:Z');
  for (const row of stubRows) {
    const rec = fromRow(STUB_COLS, row);
    if (rec.id) await store.mergeRecord('stubs', rec);
  }
  store.notifyChanged();
}

// ---------- Calendar: app -> calendar ----------
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function pushJobToCalendar(job) {
  const s = settings();
  // no_cal jobs (imported from the iCloud calendar) stay off the Google
  // calendar — their original event already exists in Apple Calendar.
  if (job.no_cal || !s.calendarId || !job.start_date) return job;
  const event = {
    summary: job.project + (job.company ? ` (${job.company})` : ''),
    description: jobToNote(job) + (job.notes ? `\n${job.notes}` : ''),
    start: { date: job.start_date },
    end: { date: addDays(job.end_date || job.start_date, 1) },
    extendedProperties: { private: { paytrackJobId: job.id } },
  };
  if (job.deleted) {
    if (job.calendar_event_id) await g.deleteEvent(s.calendarId, job.calendar_event_id);
    job.calendar_event_id = '';
  } else if (job.calendar_event_id) {
    await g.patchEvent(s.calendarId, job.calendar_event_id, event)
      .catch(async e => {
        if (/404|410/.test(e.message)) {
          const created = await g.insertEvent(s.calendarId, event);
          job.calendar_event_id = created.id;
        } else throw e;
      });
  } else {
    const created = await g.insertEvent(s.calendarId, event);
    job.calendar_event_id = created.id;
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
  if (!base || job.deleted) return {};
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
  const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
  if (due < tomorrow) due = tomorrow;
  const event = {
    summary: `💰 Follow up: ${job.project || 'job'} ${part} unpaid`,
    description: `PayTrack alert — ${jobToNote(job)}`,
    start: { dateTime: `${due}T09:00:00` },
    end: { dateTime: `${due}T09:30:00` },
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
    const created = await g.insertEvent(s.calendarId, event);
    job[idField] = created.id;
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
  return job;
}

// Push a job everywhere after an in-app edit.
export async function pushJob(job) {
  await pushJobToCalendar(job);
  await syncReminder(job);
  await store.putJob(job, { silent: true });   // persist event ids
  scheduleMirror();
}

// Catch-up: any job that never made it onto the calendar (e.g. created
// from a stub while offline) gets pushed on the next sync.
export async function pushUnsynced() {
  const s = settings();
  if (!s.calendarId) return;
  const jobs = await store.allJobs();
  for (const job of jobs) {
    if (!job.no_cal && !job.calendar_event_id && job.start_date) {
      await pushJob(job).catch(e => console.warn('catch-up push', e));
    }
  }
}

// ---------- Calendar: calendar -> app ----------
export async function pullCalendar() {
  const s = settings();
  if (!s.calendarId) return;
  const since = s.lastCalPull || new Date(Date.now() - 30 * 86400000).toISOString();
  const { items } = await g.listEvents(s.calendarId, {
    updatedMin: since, showDeleted: 'true', singleEvents: 'true',
    timeMin: new Date(Date.now() - 400 * 86400000).toISOString(),
  });
  for (const ev of items) {
    const jobId = ev.extendedProperties?.private?.paytrackJobId;
    if (jobId) {
      const job = await store.getJob(jobId);
      if (!job) continue;
      if ((ev.updated || '') <= (job.updated_at || '')) continue;  // our own push
      if (ev.status === 'cancelled') { job.deleted = true; }
      else {
        if (ev.start?.date) job.start_date = ev.start.date;
        if (ev.end?.date) job.end_date = addDays(ev.end.date, -1);
        const note = parseJobNote(ev.description || '');
        if (note.wages_status) job.wages_status = note.wages_status;
        if (note.gear_status) job.gear_status = note.gear_status;
        if (note.rate_amount) { job.rate_amount = note.rate_amount; job.rate_hours = note.rate_hours; }
        if (note.gear_total) job.gear_total = note.gear_total;
      }
      await store.putJob(job, { silent: true });
      await syncReminder(job).catch(() => {});
      await store.putJob(job, { silent: true });
    } else if (ev.status !== 'cancelled'
        && !ev.extendedProperties?.private?.paytrackReminderFor
        && looksLikeJob(ev.summary, ev.description)) {
      await store.queueImport(eventToQueued(ev));
    }
  }
  saveSettings({ lastCalPull: store.now() });
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
export async function historyImportScan(fromYear = 2018) {
  const s = settings();
  if (!s.calendarId) throw new Error('Pick a calendar in Setup first.');
  const { items } = await g.listEvents(s.calendarId, {
    timeMin: `${fromYear}-01-01T00:00:00Z`, singleEvents: 'true', orderBy: 'startTime',
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
