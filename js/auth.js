// Google Identity Services (token model). Access tokens last ~1h; we refresh
// silently when possible and surface a "reconnect" state otherwise.
import { settings, saveSettings, SCOPES } from './config.js';

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
      emit('connected');
      resolve(accessToken);
    };
    client.error_callback = (err) => reject(new Error(err.message || err.type || 'sign-in failed'));
    client.requestAccessToken({ prompt: promptMode });
  });
}

// Interactive connect (user taps the button — may show Google popup).
export function connect() { return requestToken(''); }

// Token is live but inside the renewal window (Google caps tokens at ~1h).
export function needsRefreshSoon(windowMs = 10 * 60 * 1000) {
  return !!accessToken && Date.now() > expiresAt - windowMs;
}

// Attempt a no-UI refresh; succeeds when called during a user gesture with an
// active Google session. Never throws.
export async function trySilentRefresh() {
  try { await requestToken('none'); return true; } catch { return false; }
}

// Get a token for an API call; tries silent refresh, otherwise throws
// NEEDS_CONNECT so the UI can show the reconnect button.
export async function token() {
  if (isConnected()) return accessToken;
  try {
    return await requestToken('none');
  } catch {
    emit('disconnected');
    const e = new Error('Google connection expired — tap the dot in the top bar to reconnect.');
    e.code = 'NEEDS_CONNECT';
    throw e;
  }
}

export function disconnect() {
  if (accessToken && window.google?.accounts?.oauth2) {
    try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch {}
  }
  accessToken = ''; expiresAt = 0;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  emit('disconnected');
}
