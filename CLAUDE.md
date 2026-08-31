# PayTrack — instructions for Claude sessions in this project

Personal PWA for a freelance DIT: tracks jobs, day rates ("$955/10" = $955
for 10 guaranteed hours), gear-rental amounts, and wages/gear PAID status.
Deployed at https://datawave2026.github.io/paytrack/ from the public repo
github.com/DataWave2026/paytrack (GitHub Pages, main branch, root).

RULE ZERO (user-wide): never add a model-provider SDK or call a model API.
All "smart" behavior is heuristic code (see js/parse.js, js/match.js) plus
Google Drive's free OCR. Zero paid services of any kind.

Architecture rules:
- Pure static client-side PWA. No backend, no build step, no dependencies,
  plain ES modules. Keep it that way.
- All user data lives in the USER'S Google account (Sheet "PayTrack DB",
  Drive folder PayTrack/Paystubs, their Google Calendar) or in IndexedDB.
  The public repo must NEVER contain personal data: test fixtures in
  tests/fixtures/ stay redacted (no real names, addresses, ID numbers).
- Missing amounts stay null/blank, never 0.
- New payroll-vendor stub layouts get a template in js/parse.js VENDORS,
  driven by a redacted fixture + test. The generic parser is the fallback.
- Calendar sync must only touch events tagged with the paytrackJobId
  extended property or explicitly confirmed by the user in the Review tab —
  the synced calendar also holds personal events.

Tests: `npm test` (node --test). Must pass before and after any change.
Local run: `npm run serve` then http://localhost:8123. Bump the CACHE
version in sw.js whenever shipping changes, or clients keep the old cached
files.
