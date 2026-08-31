# PayTrack

A personal PWA for tracking freelance film/TV jobs: work dates, day rates,
gear-rental amounts, and whether wages and gear have been **paid**. Photograph
a paystub in-app and PayTrack reads it (Google Drive OCR), matches it to the
right job by name / dates / rates, and marks it paid. The photo itself is
never stored — only the extracted details. Two-way sync with a Google
Calendar; unpaid jobs get "💰 Follow up" reminder events with email + push
notifications from Google Calendar.

**No backend.** Pure static PWA. All data lives in the owner's own Google
account: a "PayTrack DB" Google Sheet and the chosen calendar. Works offline
for viewing/adding jobs (IndexedDB), syncs when online. No LLM/model APIs
anywhere.

## One-time setup

1. **Host it** — any static host; GitHub Pages works (this repo).
2. **Create a Google OAuth Client ID** (free):
   - [console.cloud.google.com](https://console.cloud.google.com) → new project ("PayTrack").
   - *APIs & Services → Library*: enable **Google Drive API**, **Google Sheets
     API**, **Google Calendar API**.
   - *APIs & Services → OAuth consent screen*: External, app name "PayTrack",
     your email; add yourself as the only test user, or Publish the app
     (it stays unverified — you'll click through a one-time warning).
   - *Credentials → Create credentials → OAuth client ID → Web application*:
     add your Pages URL **and** `http://localhost:8123` as *Authorized
     JavaScript origins*.
   - Copy the Client ID.
3. Open the app → **Setup** tab → paste the Client ID → **Connect Google** →
   pick the calendar to sync → **Scan calendar history** in the Review tab.
4. iPhone: Share → *Add to Home Screen*. Mac Safari: File → *Add to Dock*.

## Dev

```
npm test          # parser + matcher unit tests (node --test)
npm run serve     # local server on :8123
```

Plain ES modules, no build step, no dependencies. `js/parse.js` holds the
per-payroll-vendor stub templates (Wrapbook implemented; add new vendors there
as real stubs arrive — keep fixtures in `tests/fixtures/` **redacted**: never
commit real names, addresses, or ID numbers).
