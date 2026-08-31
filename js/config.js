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
  companyName: '',           // user's loan-out company, for payee attribution
  personalName: '',          // user's own name as it appears on stubs
  alertDaysWages: 14,        // days after wrap before wages count as overdue
  alertDaysGear: 30,         // days after wrap before gear rental counts as overdue
  everConnected: false,      // gate for silent background re-auth attempts
  calSyncToken: '',
  lastSheetSync: '',
};

let cache = null;

export function settings() {
  if (!cache) {
    try { cache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
    catch { cache = { ...DEFAULTS }; }
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...settings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cache));
  return cache;
}

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar',
].join(' ');
