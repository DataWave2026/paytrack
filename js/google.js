// Thin REST helpers over Google Drive / Sheets / Calendar. No SDKs, no
// model APIs — plain fetch with the user's own OAuth token.
import { token } from './auth.js';

async function call(url, { method = 'GET', json, body, headers = {}, raw = false } = {}) {
  const t = await token();
  const opts = { method, headers: { Authorization: `Bearer ${t}`, ...headers } };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  } else if (body !== undefined) {
    opts.body = body;
  }
  const resp = await fetch(url, opts);
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

export async function createFolder(name, parentId) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  return call('https://www.googleapis.com/drive/v3/files?fields=id,name', { method: 'POST', json: meta });
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

export async function uploadFile(file, name, parentId) {
  const { body, contentType } = multipartBody({ name, parents: parentId ? [parentId] : undefined }, file);
  return call('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST', body, headers: { 'Content-Type': contentType },
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
