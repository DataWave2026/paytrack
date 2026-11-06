// Local-first storage: IndexedDB is the source of truth on this device.
// Google Sheet (when connected) is a mirror/backup that also bootstraps
// new devices. All records carry updated_at for newest-wins merging.

const DB_NAME = 'paytrack';
const DB_VER = 1;
let dbp = null;

export const bus = new EventTarget();
const changed = () => bus.dispatchEvent(new Event('change'));

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('stubs')) db.createObjectStore('stubs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('importQueue')) db.createObjectStore('importQueue', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(storeName, mode, fn) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

function getAll(storeName) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction(storeName).objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const now = () => new Date().toISOString();

// Calendar dates are plain YYYY-MM-DD strings. "Today" is the LOCAL date
// (toISOString() is UTC — after ~4pm Pacific it is already tomorrow), and day
// arithmetic runs in UTC so it is correct in every timezone.
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function addDays(iso, n) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;   // never throw on a bad date
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Gear math shared by the job form and the importer.
export function spanDays(j) {
  if (j.days_worked) return j.days_worked;
  if (!j.start_date) return null;
  return Math.max(1, Math.round((new Date(j.end_date || j.start_date) - new Date(j.start_date)) / 86400000) + 1);
}

export function gearUnits(j) {
  const d = spanDays(j);
  if (!d) return null;
  return j.gear_period === 'week' ? Math.ceil(d / 7) : d;
}

export function calcGearTotal(j) {
  const u = gearUnits(j);
  if (j.gear_rate && !j.gear_total && u) j.gear_total = j.gear_rate * u;
}

// ---- Jobs ----
// {id, project, company, start_date, end_date, rate_amount, rate_hours,
//  rate_text, gear_rate, gear_total, wages_status, gear_status,
//  expected_pay_date, calendar_event_id, reminder_event_id, notes, updated_at,
//  deleted}
export function blankJob() {
  return {
    id: uid(), project: '', company: '', start_date: '', end_date: '',
    days_worked: null,
    work_dates: [],            // specific days worked (ISO); empty = whole span
    travel_dates: [],          // subset of work_dates paid as travel days (4-hr min)
    calendar_event_ids: [],    // per-day calendar events when work_dates is set
    rate_amount: null, rate_hours: null, rate_hourly: null, rate_text: '', gear_rate: null,
    gear_period: 'day', gear_total: null, wages_status: 'unpaid', gear_status: 'na',
    gear_invoices: [],         // weekly gear billing: [{start, end, amount, status: unsent|sent|paid}]
    paid_via: '',              // wages recipient: '' unknown | 'me' | 'company'
    gear_paid_via: '',         // gear recipient, independent of wages
    job_status: 'confirmed',   // 'confirmed' | 'hold' (potential/upcoming)
    invoice_status: 'unsent',  // default: every new job owes an invoice until flipped
    invoice_reminder_event_id: '',
    expected_pay_date: '', calendar_event_id: '', reminder_event_id: '',
    gear_reminder_event_id: '', no_cal: false, notes: '', updated_at: now(), deleted: false,
  };
}

export async function allJobs({ includeDeleted = false } = {}) {
  const jobs = await getAll('jobs');
  return jobs
    .filter(j => includeDeleted || !j.deleted)
    .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
}

export async function getJob(id) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const req = db.transaction('jobs').objectStore('jobs').get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

// keepStamp: automatic repairs keep the record's edit time, so a repair run
// on a device holding an outdated copy can never outrank a real edit made
// elsewhere (newest updated_at wins every merge).
export async function putJob(job, { silent = false, keepStamp = false } = {}) {
  if (!keepStamp || !job.updated_at) job.updated_at = now();
  await tx('jobs', 'readwrite', s => s.put(job));
  if (!silent) changed();
  return job;
}

// Calendar ids are derived state. Persist ONLY them, onto the freshest stored
// copy, without touching the edit stamp: a push that started before a newer
// save (here or merged from another device) must not write its old snapshot
// back over it or outrank it.
export const ID_FIELDS = ['calendar_event_id', 'calendar_event_ids', 'reminder_event_id',
  'gear_reminder_event_id', 'invoice_reminder_event_id'];
export async function saveJobIds(job) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('jobs', 'readwrite');
    const st = t.objectStore('jobs');
    const g = st.get(job.id);
    g.onsuccess = () => {
      const fresh = g.result || job;
      for (const k of ID_FIELDS) if (job[k] !== undefined) fresh[k] = job[k];
      st.put(fresh);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Merge a record from a remote source (Sheet); newest updated_at wins —
// EXCEPT deletion, which is a tombstone: once either side has deleted a
// record, no sync may resurrect it.
// Failed-scan husks: a stub with NO check number duplicating another stub for
// the same job + check date is a retried scan. Keep the most complete one
// (highest gross). Runs at boot AND inside every sheet mirror — stub deletes
// have no tombstones, so pull-before-write would otherwise re-import them.
export async function dropStubHusks() {
  const all = await allStubs();
  let n = 0;
  const grps = {};
  for (const s of all) {
    if (!s.check_no) (grps[`${s.matched_job_id}|${s.check_date}`] ||= []).push(s);
  }
  for (const grp of Object.values(grps)) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => (b.gross || 0) - (a.gross || 0));
    for (const d of grp.slice(1)) { await deleteStub(d.id); n++; }
  }
  // The same check recorded twice on the same job: keep the newest.
  const dup = {};
  for (const s of all) {
    if (s.check_no && String(s.check_no).length >= 3) (dup[`${s.check_no}|${s.matched_job_id || ''}`] ||= []).push(s);
  }
  for (const grp of Object.values(dup)) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    for (const d of grp.slice(1)) { await deleteStub(d.id); n++; }
  }
  return n;
}

export async function mergeRecord(storeName, rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const s = t.objectStore(storeName);
    const g = s.get(rec.id);
    g.onsuccess = () => {
      const local = g.result;
      if (!local) { s.put(rec); return; }
      // Newest edit wins, deletion included: a delete only sticks while it is
      // the latest event, so restoring a job (fresh updated_at) beats stale
      // tombstones from other devices. Spread over local: a column the
      // writing device's app version didn't know is absent from rec and must
      // not wipe the local value.
      if ((rec.updated_at || '') > (local.updated_at || '')) s.put({ ...local, ...rec });
      else if (storeName === 'jobs' && rec.updated_at === local.updated_at) {
        // Same edit on both sides: adopt calendar ids the other device stored
        // (they are saved without bumping the stamp) when we have none.
        let changed = false;
        for (const k of ID_FIELDS) {
          const mine = local[k], theirs = rec[k];
          const empty = (v) => v === undefined || v === '' || (Array.isArray(v) && !v.length);
          if (empty(mine) && !empty(theirs)) { local[k] = theirs; changed = true; }
        }
        if (changed) s.put(local);
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- Stubs ----
// {id, drive_file_id, photo_name, vendor, project_name, employer,
//  period_start, period_end, hourly_rates, hours, gross, net, check_no,
//  check_date, matched_job_id, ocr_text_excerpt, created_at, updated_at}
export async function allStubs({ includeDeleted = false } = {}) {
  const stubs = await getAll('stubs');
  return stubs.filter(s => includeDeleted || !s.deleted)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

export async function putStub(stub, { keepStamp = false } = {}) {
  if (!keepStamp || !stub.updated_at) stub.updated_at = now();
  if (!stub.created_at) stub.created_at = stub.updated_at;
  await tx('stubs', 'readwrite', s => s.put(stub));
  changed();
  return stub;
}

// Deleting a stub leaves a tombstone (deleted: true) that syncs like any
// other edit — a plain local delete was re-imported from the sheet by the
// next pull, so removed duplicates kept coming back.
export async function deleteStub(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction('stubs', 'readwrite');
    const st = t.objectStore('stubs');
    const g = st.get(id);
    g.onsuccess = () => { if (g.result) st.put({ ...g.result, deleted: true, updated_at: now() }); };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  changed();
}

// ---- Import queue (calendar events awaiting review) ----
export async function allQueued() {
  return getAll('importQueue');
}
export async function queueImport(item) {
  await tx('importQueue', 'readwrite', s => s.put(item));
  changed();
}
export async function dequeueImport(id) {
  await tx('importQueue', 'readwrite', s => s.delete(id));
  changed();
}

export function notifyChanged() { changed(); }
