// Thin REST helpers over Google Drive / Sheets / Calendar. No SDKs, no
// model APIs — plain fetch with the user's own OAuth token.
import { token, trySilentRefresh, invalidate } from './auth.js';

// Every request has a deadline: a fetch that never settles (a phone suspended
// mid-request, a stalled connection on one bar of LTE) used to leave the whole
// sync hanging forever with the connection dot still green.
const TIMEOUT_MS = 45000, UPLOAD_TIMEOUT_MS = 120000;
async function call(url, { method = 'GET', json, body, headers = {}, raw = false } = {}, _retried = false) {
  const t = await token();
  const opts = { method, headers: { Authorization: `Bearer ${t}`, ...headers } };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (body !== undefined) {
    opts.body = body;
  }
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ac && setTimeout(() => ac.abort(), body !== undefined ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS);
  if (ac) opts.signal = ac.signal;
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error(`Google API timed out (${url.split('?')[0]})`);
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally { if (timer) clearTimeout(timer); }
  // Token died mid-session: refresh silently and retry once instead of
  // surfacing "disconnected".
  if (resp.status === 401 && !_retried) {
    invalidate();   // otherwise the "refresh" would hand back the same dead token
    if (await trySilentRefresh()) {
      return call(url, { method, json, body, headers, raw }, true);
    }
    const e = new Error('Google connection expired — tap the dot in the top bar to reconnect.');
    e.code = 'NEEDS_CONNECT';
    throw e;
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error?.message || ''; } catch {}
    throw new Error(`Google API ${resp.status}${detail ? ': ' + detail : ''} (${url.split('?')[0]})`);
  }
  if (raw) return resp;
  const text = await resp.text();
  return text ? JSON.parse(text) : {};
}

// ---------- Drive ----------
export async function findByName(name, mimeType, parentId) {
  let q = `name = '${name.replace(/'/g, "\\'")}' and trashed = false`;
  if (mimeType) q += ` and mimeType = '${mimeType}'`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const r = await call(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  return r.files?.[0] || null;
}

function multipartBody(meta, file) {
  const boundary = 'paytrack' + Math.random().toString(36).slice(2);
  const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${file.type || 'image/jpeg'}\r\n\r\n`;
  const post = `\r\n--${boundary}--`;
  return {
    body: new Blob([pre, file, post]),
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

// Troubleshooting archive: keep the scanned photo + its OCR text in the
// user's OWN Drive ("PayTrack Scans" folder) so a misparsed template can be
// examined later. Returns the photo's file id.
let scansFolderId = null;
async function ensureScansFolder() {
  if (scansFolderId) return scansFolderId;
  const existing = await findByName('PayTrack Scans', 'application/vnd.google-apps.folder');
  if (existing) scansFolderId = existing.id;
  else {
    const created = await call('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST', json: { name: 'PayTrack Scans', mimeType: 'application/vnd.google-apps.folder' },
    });
    scansFolderId = created.id;
  }
  return scansFolderId;
}

// Monthly hygiene: OCR text and word-layout sidecars older than `days` are
// trashed (the photos stay). Returns how many were removed.
export async function sweepScanSidecars(days = 90) {
  const folder = await ensureScansFolder();
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const q = `'${folder}' in parents and trashed = false and modifiedTime < '${cutoff}' and (name contains '.ocr.txt' or name contains '.layout.json')`;
  const r = await call(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=200`);
  let n = 0;
  for (const f of r.files || []) {
    await call(`https://www.googleapis.com/drive/v3/files/${f.id}?fields=id`, { method: 'PATCH', json: { trashed: true } });
    n++;
  }
  return n;
}

// Per-device diagnostics file, overwritten in place — one sign-in to the
// Drive folder reads every device's logs without exporting anything by hand.
export async function uploadDiagnostics(name, jsonString) {
  const folder = await ensureScansFolder();
  const existing = await findByName(name, null, folder);
  const blob = new Blob([jsonString], { type: 'application/json' });
  if (existing) {
    await call(`https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`, {
      method: 'PATCH', body: blob, headers: { 'Content-Type': 'application/json' },
    });
    return existing.id;
  }
  const { body, contentType } = multipartBody({ name, parents: [folder] }, blob);
  const created = await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', body, headers: { 'Content-Type': contentType },
  });
  return created.id;
}

export async function uploadScan(file, name, ocrText) {
  await ensureScansFolder();
  const { body, contentType } = multipartBody({ name, parents: [scansFolderId] }, file);
  const photo = await call(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', body, headers: { 'Content-Type': contentType },
    });
  if (ocrText) {
    const txt = multipartBody({ name: name.replace(/\.\w+$/, '') + '.ocr.txt', parents: [scansFolderId] },
      new Blob([ocrText], { type: 'text/plain' }));
    await call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', body: txt.body, headers: { 'Content-Type': txt.contentType },
    }).catch(() => {});
  }
  return photo.id;
}

// Small shared settings stored ON the PayTrack DB sheet file itself (Drive
// appProperties) — every device reads the same values without a new tab.
export async function getFileProps(fileId) {
  const r = await call(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=appProperties`);
  return r.appProperties || {};
}
export async function setFileProps(fileId, props) {
  await call(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id`, {
    method: 'PATCH', json: { appProperties: props },
  });
}

// Drive's built-in OCR: upload the image converting it to a Google Doc,
// export the doc as plain text, then delete the temporary doc.
export async function ocrImage(file) {
  const { body, contentType } = multipartBody(
    { name: 'paytrack-ocr-temp', mimeType: 'application/vnd.google-apps.document' }, file);
  const doc = await call(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=en&fields=id', {
      method: 'POST', body, headers: { 'Content-Type': contentType },
    });
  try {
    const resp = await call(
      `https://www.googleapis.com/drive/v3/files/${doc.id}/export?mimeType=text%2Fplain`, { raw: true });
    return await resp.text();
  } finally {
    call(`https://www.googleapis.com/drive/v3/files/${doc.id}`, { method: 'DELETE' }).catch(() => {});
  }
}

// ---------- Sheets ----------
export async function createSpreadsheet(title, sheetTitles) {
  return call('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    json: { properties: { title }, sheets: sheetTitles.map(t => ({ properties: { title: t } })) },
  });
}

export async function readRange(sheetId, range) {
  const r = await call(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`);
  return r.values || [];
}

export async function writeRange(sheetId, range, values) {
  return call(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    { method: 'PUT', json: { values } });
}

export async function batchClear(sheetId, ranges) {
  return call(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchClear`,
    { method: 'POST', json: { ranges } });
}

export async function clearRange(sheetId, range) {
  return call(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', json: {} });
}

// ---------- Calendar ----------
export async function listCalendars() {
  const r = await call('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer');
  return r.items || [];
}

// All events tagged with one of our private extended properties, e.g.
// paytrackJobId=<id> — the ground truth for duplicate detection.
export async function eventsByPrivateProp(calendarId, key, value) {
  const { items } = await listEvents(calendarId, {
    privateExtendedProperty: `${key}=${value}`, singleEvents: 'false', showDeleted: 'false',
  });
  return items;
}

export async function listEvents(calendarId, params = {}) {
  const qs = new URLSearchParams({ maxResults: '250', singleEvents: 'false', ...params });
  let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${qs}`;
  const items = [];
  let r;
  do {
    r = await call(url);
    items.push(...(r.items || []));
    if (r.nextPageToken) {
      qs.set('pageToken', r.nextPageToken);
      url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${qs}`;
    }
  } while (r.nextPageToken);
  return { items, nextSyncToken: r.nextSyncToken || '' };
}

export async function insertEvent(calendarId, event) {
  return call(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'POST', json: event });
}

export async function patchEvent(calendarId, eventId, patch) {
  return call(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: 'PATCH', json: patch });
}

export async function deleteEvent(calendarId, eventId) {
  return call(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
    { method: 'DELETE' }).catch(e => { if (!/410|404/.test(e.message)) throw e; });
}
