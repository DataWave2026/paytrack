// Settings persisted in localStorage. The OAuth client ID is public by design
// (it only works from the authorized origins configured in Google Cloud).
const KEY = 'paytrack.settings';

const DEFAULTS = {
  clientId: '',
  calendarId: '',            // Google calendar to sync with
  calendarName: '',
  sheetId: '',               // "PayTrack DB" spreadsheet
  folderId: '',              // Drive folder for paystub photos
  alertDays: 14,             // days after wrap before payment counts as overdue
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
