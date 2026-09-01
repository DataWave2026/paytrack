// Invisible flight recorder: a rolling buffer of app events kept on-device,
// surfaced only through Setup → "Copy diagnostics" for debugging. Never
// leaves the device on its own.
const KEY = 'paytrack.log';
const MAX = 400;

let buf = [];
try { buf = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch {}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(buf)); } catch {}
  }, 300);
}

export function log(tag, data) {
  buf.push({ t: new Date().toISOString(), tag, d: data === undefined ? null : data });
  if (buf.length > MAX) buf = buf.slice(-MAX);
  persist();
}

export function dump() { return buf; }

export function clearLog() {
  buf = [];
  try { localStorage.removeItem(KEY); } catch {}
}
