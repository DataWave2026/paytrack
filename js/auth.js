// Google Identity Services (token model). Access tokens last ~1h; we refresh
// silently when possible and surface a "reconnect" state otherwise.
import { settings, saveSettings, SCOPES } from './config.js';
import { log } from './log.js';

const TOKEN_KEY = 'paytrack.token';
let tokenClient = null;
let accessToken = '';
let expiresAt = 0;

// Restore a still-valid token across reloads (app updates auto-reload the
// page; the connection must survive that).
try {
  const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || '{}');
  if (saved.accessToken && saved.expiresAt > Date.now() + 60000) {
    accessToken = saved.accessToken;
    expiresAt = saved.expiresAt;
  }
} catch {}

export const authBus = new EventTarget();
const emit = (state) => authBus.dispatchEvent(new CustomEvent('state', { detail: state }));

// Another PayTrack tab renewed the token: adopt it instead of opening a
// second Google popup from this tab.
window.addEventListener('storage', (e) => {
  if (e.key !== TOKEN_KEY) return;
  try {
    const t = JSON.parse(e.newValue || '{}');
    if (t.accessToken && t.expiresAt > expiresAt) {
      accessToken = t.accessToken;
      expiresAt = t.expiresAt;
      emit('connected');
    }
  } catch {}
});

export function isConnected() { return !!accessToken && Date.now() < expiresAt - 60000; }
export function hasCredentials() { return !!settings().clientId; }

function ensureClient() {
  if (tokenClient) return tokenClient;
  if (!window.google?.accounts?.oauth2) throw new Error('Google sign-in library not loaded yet — check your connection and retry.');
  if (!settings().clientId) throw new Error('No OAuth Client ID configured (see Setup tab).');
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings().clientId,
    scope: SCOPES,
    callback: () => {}, // replaced per-request
  });
  return tokenClient;
}

function requestToken(promptMode) {
  return new Promise((resolve, reject) => {
    const client = ensureClient();
    client.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      accessToken = resp.access_token;
      expiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
      try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ accessToken, expiresAt })); } catch {}
      saveSettings({ everConnected: true });
      if (promptMode !== 'none' || !settings().googleEmail) rememberEmail(accessToken);
      emit('connected');
      resolve(accessToken);
    };
    client.error_callback = (err) => reject(new Error(err.message || err.type || 'sign-in failed'));
    const hint = settings().googleEmail;
    client.requestAccessToken(hint ? { prompt: promptMode, login_hint: hint } : { prompt: promptMode });
  });
}

// Silent renewal (prompt=none) fails whenever Google would have to show its
// account chooser, e.g. several accounts signed in. The email as login_hint
// lets it pick the right account without asking.
async function rememberEmail(t) {
  try {
    const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      { headers: { Authorization: `Bearer ${t}` } });
    const email = r.ok ? (await r.json()).user?.emailAddress : '';
    if (email) saveSettings({ googleEmail: email });
  } catch {}
}

// Only a real click/tap may open Google's renewal popup. Timers, hidden tabs
// and API retries never do — otherwise a forgotten tab flashes it all day.
function inUserGesture() {
  if (navigator.userActivation) return navigator.userActivation.isActive;
  return document.visibilityState === 'visible' && document.hasFocus();
}

// Interactive connect (user taps the button — may show Google popup).
export function connect() {
  lastRefreshFail = 0;   // a deliberate connect resets the silent-refresh backoff
  return requestToken('');
}

// Token is live but inside the renewal window (Google caps tokens at ~1h).
export function needsRefreshSoon(windowMs = 10 * 60 * 1000) {
  return !!accessToken && Date.now() > expiresAt - windowMs;
}

// Attempt a no-UI refresh; succeeds when called during a user gesture with an
// active Google session. Never throws.
// Silent renewal opens Google's brief self-closing popup — unavoidable, so
// keep it RARE: only inside a real click/tap, all callers share one in-flight
// attempt, and a failure backs off for 10 minutes. Outside a gesture an
// expired token just shows the disconnected dot until the next tap.
let refreshInFlight = null;
let lastRefreshFail = 0;
export async function trySilentRefresh() {
  if (isConnected()) return true;
  if (refreshInFlight) return refreshInFlight;
  if (!inUserGesture()) return false;
  if (Date.now() - lastRefreshFail < 10 * 60 * 1000) return false;
  refreshInFlight = requestToken('none')
    .then(() => true)
    .catch((e) => {
      lastRefreshFail = Date.now();
      log('auth:silent', { ok: false, msg: String(e.message).slice(0, 160) });
      return false;
    })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Get a token for an API call; tries silent refresh, otherwise throws
// NEEDS_CONNECT so the UI can show the reconnect button.
export async function token() {
  if (isConnected()) return accessToken;
  if (await trySilentRefresh()) return accessToken;
  emit('disconnected');
  const e = new Error('Google connection expired — tap the dot in the top bar to reconnect.');
  e.code = 'NEEDS_CONNECT';
  throw e;
}

export function disconnect() {
  if (accessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch {}
  }
  accessToken = ''; expiresAt = 0;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  saveSettings({ googleEmail: '' });
  emit('disconnected');
}
