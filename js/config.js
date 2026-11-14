// Settings persisted in localStorage. The OAuth client ID is public by design
// (it only works from the authorized origins configured in Google Cloud).
const KEY = 'paytrack.settings';

const DEFAULTS = {
  // Public OAuth client identifier (not a secret); only works from the
  // origins authorized in Google Cloud console.
  clientId: '7774373744-6s6fh8h37p8rfprkde3o4fs4vsug1vkj.apps.googleusercontent.com',
  calendarId: '',            // Google calendar to sync with
  calendarName: '',
  sheetId: '',               // "PayTrack DB" spreadsheet
  theme: '',                 // '' auto | 'dark' | 'light'
  hideMoney: false,          // privacy eye: mask all dollar amounts
  keepScans: true,           // archive scan photos + OCR text in Drive (troubleshooting)
  sidebarHidden: false,      // collapse the nav sidebar (handy on phones)
  companyName: '',           // user's loan-out company, for payee attribution
  personalName: '',          // user's own name as it appears on stubs
  alertDaysWages: 14,        // days after wrap before wages count as overdue
  alertDaysGear: 30,         // days after wrap before gear rental counts as overdue
  everConnected: false,      // gate for silent background re-auth attempts
  googleEmail: '',           // login_hint so silent renewal skips the account chooser
  calSyncToken: '',
  lastSheetSync: '',
  calendarChosenAt: '',
  prefsAt: '',               // when the shared prefs below were last edited (newest wins across devices)
  lastInvoiceNag: '',        // local day the unsent-invoice reminders were last re-armed
};

// Settings that change what the app DOES with shared data (reminder dates,
// payee attribution) are shared between devices through the sheet file's
// properties — a per-device copy made two devices fight over one reminder.
export const SHARED_PREFS = ['alertDaysWages', 'alertDaysGear', 'companyName', 'personalName'];

let cache = null;

export function settings() {
  if (!cache) {
    try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
    catch { cache = { ...DEFAULTS }; }
  }
  return cache;
}

export function saveSettings(patch) {
  // Re-read before merging: another tab may have written since this tab
  // cached its copy (a stale cache used to revert the other tab's values).
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  cache = { ...DEFAULTS, ...stored, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { console.warn('settings not saved', e); }
  return cache;
}
// A user edit to a shared pref: stamp it so the newest edit wins everywhere.
export function savePrefs(patch) {
  return saveSettings({ ...patch, prefsAt: new Date().toISOString() });
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === KEY) cache = null; });
}

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar',
].join(' ');
