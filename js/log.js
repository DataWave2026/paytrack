// Invisible flight recorder: a rolling buffer of app events kept on-device,
// surfaced through Setup → diagnostics / bug report. Repeated "sync ok"
// heartbeats (one every 5 minutes on an open tab) collapse into a single
// entry with a count, so the buffer holds days of history instead of hours;
// errors are kept in their own ring so they survive the heartbeat churn.
const KEY = 'paytrack.log';
const MAX = 400;
const ERR_MAX = 100;

let buf = [], errs = [];
try {
  const stored = JSON.parse(localStorage.getItem(KEY) || '[]');
  if (Array.isArray(stored)) buf = stored;
  else { buf = stored.buf || []; errs = stored.errs || []; }
} catch {}

let saveTimer = null;
function write() { try { localStorage.setItem(KEY, JSON.stringify({ buf, errs })); } catch {} }
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(write, 300);
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { clearTimeout(saveTimer); write(); });

const okSync = (e) => e && e.tag === 'sync' && e.d && e.d.ok === true && !(e.d.failed || []).length;

export function log(tag, data) {
  const entry = { t: new Date().toISOString(), tag, d: data === undefined ? null : data };
  const last = buf[buf.length - 1];
  if (okSync(entry) && okSync(last)) {
    last.n = (last.n || 1) + 1;
    last.until = entry.t;
    persist();
    return;
  }
  buf.push(entry);
  if (buf.length > MAX) buf = buf.slice(-MAX);
  const bad = /err|fail|unhandled|refused|watchdog|retry/i.test(tag)
    || (data && typeof data === 'object' && data.ok === false);
  if (bad) {
    errs.push(entry);
    if (errs.length > ERR_MAX) errs = errs.slice(-ERR_MAX);
  }
  persist();
}

export function dump() { return buf; }
export function dumpErrors() { return errs; }

export function clearLog() {
  buf = []; errs = [];
  try { localStorage.removeItem(KEY); } catch {}
}
