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
    calendar_event_ids: [],    // per-day calendar events when work_dates is set
    rate_amount: null, rate_hours: null, rate_text: '', gear_rate: null,
    gear_period: 'day', gear_total: null, wages_status: 'unpaid', gear_status: 'na',
    paid_via: '',              // '' unknown | 'me' | 'company'
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

export async function putJob(job, { silent = false } = {}) {
  job.updated_at = now();
  await tx('jobs', 'readwrite', s => s.put(job));
  if (!silent) changed();
  return job;
}

// Merge a record from a remote source (Sheet); newest updated_at wins.
export async function mergeRecord(storeName, rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, 'readwrite');
    const s = t.objectStore(storeName);
    const g = s.get(rec.id);
    g.onsuccess = () => {
      const local = g.result;
      if (!local || (rec.updated_at || '') > (local.updated_at || '')) s.put(rec);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// ---- Stubs ----
// {id, drive_file_id, photo_name, vendor, project_name, employer,
//  period_start, period_end, hourly_rates, hours, gross, net, check_no,
//  check_date, matched_job_id, ocr_text_excerpt, created_at, updated_at}
export async function allStubs() {
  const stubs = await getAll('stubs');
  return stubs.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

export async function putStub(stub) {
  stub.updated_at = now();
  if (!stub.created_at) stub.created_at = stub.updated_at;
  await tx('stubs', 'readwrite', s => s.put(stub));
  changed();
  return stub;
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
