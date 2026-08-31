import { settings, saveSettings } from './config.js';
import * as store from './store.js';
import * as auth from './auth.js';
import * as g from './google.js';
import * as sync from './sync.js';
import { parseStub, blankParse } from './parse.js';
import { matchStub } from './match.js';

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const viewEl = document.getElementById('view');
const toastEl = document.getElementById('toast');
let toastTimer;
function toast(msg, ms = 3000) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

const fmt$ = (n) => n === null || n === undefined || Number.isNaN(n) ? '—'
  : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

function fmtRange(a, b) {
  if (!a) return 'no dates';
  const f = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return !b || b === a ? f(a) : `${f(a)} – ${f(b)}`;
}

function jobDays(job) {
  if (job.days_worked) return job.days_worked;
  if (!job.start_date) return 1;
  const d = Math.round((new Date(job.end_date || job.start_date) - new Date(job.start_date)) / 86400000) + 1;
  return Math.max(1, d);
}

function dueDate(job) {
  if (job.expected_pay_date) return job.expected_pay_date;
  const base = job.end_date || job.start_date;
  if (!base) return '';
  const d = new Date(base + 'T00:00:00');
  d.setDate(d.getDate() + (Number(settings().alertDays) || 14));
  return d.toISOString().slice(0, 10);
}

function isOverdue(job) {
  return sync.unpaidParts(job).length > 0 && dueDate(job) && dueDate(job) < today();
}

// ---------- views ----------
let currentView = 'home';
const views = { home, jobs, stub, review, settings: settingsView };

async function render(name) {
  currentView = name || currentView;
  document.querySelectorAll('#tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === currentView));
  viewEl.replaceChildren(await views[currentView]());
  viewEl.scrollTop = 0;
}

document.getElementById('tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) render(btn.dataset.view);
});
store.bus.addEventListener('change', () => render());

// ---------- home ----------
async function home() {
  const jobs = await store.allJobs();
  const unpaidWages = jobs.filter(j => j.wages_status !== 'paid');
  const unpaidGear = jobs.filter(j => j.gear_status !== 'paid' && j.gear_status !== 'na');
  const overdue = jobs.filter(isOverdue);
  const gearOut = unpaidGear.reduce((s, j) => s + (j.gear_total || 0), 0);
  const wagesOut = unpaidWages.reduce((s, j) => s + (j.rate_amount ? j.rate_amount * jobDays(j) : 0), 0);

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Outstanding'),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat ' + (unpaidWages.length ? 'bad' : 'ok') },
          h('div', { class: 'num' }, String(unpaidWages.length)),
          h('div', { class: 'lbl' }, 'jobs awaiting wages')),
        h('div', { class: 'stat ' + (gearOut ? 'bad' : 'ok') },
          h('div', { class: 'num' }, fmt$(gearOut || 0)),
          h('div', { class: 'lbl' }, 'gear outstanding')),
        h('div', { class: 'stat' },
          h('div', { class: 'num' }, wagesOut ? '~' + fmt$(wagesOut) : '—'),
          h('div', { class: 'lbl' }, 'est. wages owed'))),
    ),
    overdue.length ? h('div', { class: 'card' },
      h('h2', {}, '⚠️ Overdue'),
      overdue.map(jobRow)) : null,
    h('div', { class: 'card' },
      h('h2', {}, 'Recent jobs'),
      jobs.length ? jobs.slice(0, 8).map(jobRow)
        : h('p', { class: 'muted' }, 'No jobs yet. Add one in the Jobs tab, or import your calendar history from the Review tab.')),
  );
}

function statusBadge(kind, status) {
  if (status === 'na') return h('span', { class: 'badge na' }, kind + ': —');
  const label = status === 'paid' ? 'paid' : status === 'partial' ? 'partial' : 'UNPAID';
  return h('span', { class: 'badge ' + status }, `${kind}: ${label}`);
}

function jobRow(job) {
  const rate = job.rate_amount && job.rate_hours ? `$${job.rate_amount}/${job.rate_hours}`
    : job.rate_text || '';
  return h('div', { class: 'job', onclick: () => render('jobs').then(() => editJob(job)) },
    h('div', {},
      h('div', { class: 'title' }, job.project || '(untitled)'),
      h('div', { class: 'sub' }, [fmtRange(job.start_date, job.end_date), rate,
        job.gear_total ? `gear ${fmt$(job.gear_total)}` : ''].filter(Boolean).join(' · '))),
    h('div', { class: 'badges' },
      statusBadge('wages', job.wages_status),
      statusBadge('gear', job.gear_status)));
}

// ---------- jobs ----------
async function jobs() {
  const jobs = await store.allJobs();
  return h('div', {},
    h('button', { class: 'primary', onclick: () => editJob(null) }, '+ Add job'),
    h('div', { class: 'card mt' },
      h('h2', {}, `All jobs (${jobs.length})`),
      jobs.length ? jobs.map(jobRow) : h('p', { class: 'muted' }, 'Nothing yet.')),
  );
}

function segmented(name, value, options, onChange) {
  const seg = h('div', { class: 'seg' });
  for (const [val, label] of options) {
    const b = h('button', {
      type: 'button',
      class: val === value ? `sel ${val}` : '',
      onclick: () => {
        seg.querySelectorAll('button').forEach(x => x.className = '');
        b.className = `sel ${val}`;
        onChange(val);
      },
    }, label);
    seg.append(b);
  }
  return seg;
}

function editJob(existing) {
  const job = existing ? { ...existing } : store.blankJob();
  const input = (key, attrs = {}) => h('input', {
    value: job[key] ?? '', ...attrs,
    oninput: (e) => {
      job[key] = attrs.type === 'number'
        ? (e.target.value === '' ? null : parseFloat(e.target.value))
        : e.target.value;
    },
  });

  const form = h('div', { class: 'card' },
    h('h2', {}, existing ? 'Edit job' : 'New job'),
    h('label', {}, 'Project / show'), input('project', { placeholder: 'e.g. Ritual' }),
    h('label', {}, 'Company (optional)'), input('company', { placeholder: 'production co / who pays' }),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'First day'), input('start_date', { type: 'date' })),
      h('div', {}, h('label', {}, 'Last day'), input('end_date', { type: 'date' }))),
    h('label', {}, 'Days actually worked (optional — for owed-wages estimate)'),
    input('days_worked', { type: 'number', inputmode: 'numeric', placeholder: 'e.g. 2' }),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Day rate ($)'), input('rate_amount', { type: 'number', inputmode: 'decimal', placeholder: '955' })),
      h('div', {}, h('label', {}, 'Guaranteed hours'), input('rate_hours', { type: 'number', inputmode: 'numeric', placeholder: '10' }))),
    h('label', {}, 'Rate note (if not $/hours — e.g. "scale")'), input('rate_text', { placeholder: 'scale' }),
    h('label', {}, 'Wages'),
    segmented('wages', job.wages_status,
      [['unpaid', 'Unpaid'], ['partial', 'Partial'], ['paid', 'Paid']],
      v => job.wages_status = v),
    h('div', { class: 'row2 mt' },
      h('div', {}, h('label', {}, 'Gear rental total ($)'), input('gear_total', { type: 'number', inputmode: 'decimal', placeholder: '1200' })),
      h('div', {}, h('label', {}, 'Gear $/day (optional)'), input('gear_rate', { type: 'number', inputmode: 'decimal' }))),
    h('label', {}, 'Gear payment'),
    segmented('gear', job.gear_status,
      [['na', 'No gear'], ['unpaid', 'Unpaid'], ['partial', 'Partial'], ['paid', 'Paid']],
      v => job.gear_status = v),
    h('label', {}, 'Expect payment by (blank = wrap + ' + settings().alertDays + ' days)'),
    input('expected_pay_date', { type: 'date' }),
    h('label', {}, 'Notes'), h('textarea', {
      oninput: (e) => job.notes = e.target.value,
    }, job.notes || ''),
    h('button', {
      class: 'primary', onclick: async () => {
        if (!job.project && !job.notes) return toast('Give the job at least a name.');
        if (job.end_date && job.start_date && job.end_date < job.start_date) job.end_date = job.start_date;
        await store.putJob(job);
        toast('Saved.');
        if (auth.isConnected()) sync.pushJob(job).catch(e => toast('Calendar sync: ' + e.message, 5000));
        render('jobs');
      },
    }, 'Save job'),
    existing ? h('button', {
      class: 'danger', onclick: async () => {
        if (!confirm('Delete this job (and its calendar event)?')) return;
        job.deleted = true;
        await store.putJob(job);
        if (auth.isConnected()) sync.pushJob(job).catch(() => {});
        render('jobs');
      },
    }, 'Delete job') : null,
    h('button', { class: 'secondary', onclick: () => render('jobs') }, 'Cancel'),
  );
  viewEl.replaceChildren(form);
  viewEl.scrollTop = 0;
}

// ---------- paystub ----------
let stubFile = null;

async function stub() {
  const fileInput = h('input', {
    type: 'file', accept: 'image/*,application/pdf', capture: 'environment',
    onchange: (e) => {
      stubFile = e.target.files[0] || null;
      render('stub');
    },
  });
  const connected = auth.isConnected() || auth.hasCredentials();

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, '📸 Scan a paystub'),
      h('p', { class: 'muted' }, 'Photograph the stub (flat, well lit). It is archived in Drive, read with Google OCR, then matched to your jobs — you confirm everything before it counts.'),
      h('label', {}, 'Take photo / choose file'),
      fileInput,
      stubFile ? h('img', { class: 'stub-preview', src: URL.createObjectURL(stubFile) }) : null,
      stubFile ? h('button', {
        class: 'primary', onclick: () => runStubPipeline(stubFile),
      }, connected ? 'Scan & match' : 'Scan (connect Google in Setup first)') : null,
      h('button', { class: 'secondary', onclick: () => confirmStubForm(blankParse(), null, null) },
        'Enter a stub manually instead')),
  );
}

async function runStubPipeline(file) {
  if (!auth.hasCredentials()) { toast('Connect Google in Setup first.'); return; }
  const status = h('div', { class: 'card center' }, h('span', { class: 'spinner' }, '⏳'), ' Uploading & reading stub…');
  viewEl.replaceChildren(status);
  try {
    const name = `stub-${today()}-${file.name || 'photo.jpg'}`;
    const [uploaded, text] = await Promise.all([
      g.uploadFile(file, name, settings().folderId),
      g.ocrImage(file),
    ]);
    const parsed = parseStub(text || '');
    confirmStubForm(parsed, uploaded, text);
  } catch (e) {
    toast(e.message, 6000);
    render('stub');
  }
}

function confirmStubForm(parsed, uploaded, ocrText) {
  const p = { ...parsed };
  const input = (key, attrs = {}) => h('input', {
    value: Array.isArray(p[key]) ? p[key].join(', ') : (p[key] ?? ''), ...attrs,
    oninput: (e) => {
      if (key === 'hourly_rates') p[key] = e.target.value.split(/[,\s]+/).map(Number).filter(n => !Number.isNaN(n));
      else if (attrs.type === 'number') p[key] = e.target.value === '' ? null : parseFloat(e.target.value);
      else p[key] = e.target.value;
    },
  });
  viewEl.replaceChildren(h('div', { class: 'card' },
    h('h2', {}, 'Confirm stub details' + (p.vendor ? ` — ${p.vendor}` : '')),
    h('p', { class: 'muted small' }, 'OCR pre-filled what it could. Fix anything that looks wrong.'),
    h('label', {}, 'Project'), input('project_name'),
    h('label', {}, 'Employer / production co'), input('employer'),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Period start'), input('period_start', { type: 'date' })),
      h('div', {}, h('label', {}, 'Period end'), input('period_end', { type: 'date' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Gross ($)'), input('gross', { type: 'number', inputmode: 'decimal' })),
      h('div', {}, h('label', {}, 'Net ($)'), input('net', { type: 'number', inputmode: 'decimal' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Check #'), input('check_no')),
      h('div', {}, h('label', {}, 'Check date'), input('check_date', { type: 'date' }))),
    h('label', {}, 'Hourly rates seen (comma-separated)'), input('hourly_rates', { placeholder: '81.82, 90' }),
    h('button', { class: 'primary', onclick: () => pickMatch(p, uploaded, ocrText) }, 'Find matching job →'),
    h('button', { class: 'secondary', onclick: () => render('stub') }, 'Cancel'),
  ));
  viewEl.scrollTop = 0;
}

async function pickMatch(p, uploaded, ocrText) {
  const jobsList = await store.allJobs();
  const candidates = matchStub(p, jobsList);
  let chosen = candidates[0]?.job || null;
  let markPaid = true;

  const list = h('div', {});
  const redraw = () => {
    list.replaceChildren(
      ...candidates.map((c, i) => h('div', {
        class: 'candidate' + (chosen?.id === c.job.id ? ' best' : ''),
        onclick: () => { chosen = c.job; redraw(); },
      },
        h('span', { class: 'score' }, c.reasons.join(', ') || 'weak match'),
        h('div', { class: 'title' }, (chosen?.id === c.job.id ? '✓ ' : '') + (c.job.project || '(untitled)')),
        h('div', { class: 'sub muted small' }, fmtRange(c.job.start_date, c.job.end_date)))),
      h('div', {
        class: 'candidate' + (chosen === null ? ' best' : ''),
        onclick: () => { chosen = null; redraw(); },
      }, h('div', { class: 'title' }, (chosen === null ? '✓ ' : '') + 'None of these — create a new job from this stub')));
  };
  redraw();

  viewEl.replaceChildren(h('div', { class: 'card' },
    h('h2', {}, candidates.length ? 'Which job is this stub for?' : 'No matching job found'),
    list,
    h('label', { class: 'mt' },
      h('input', {
        type: 'checkbox', checked: 'checked', style: 'width:auto;margin-right:8px',
        onchange: (e) => markPaid = e.target.checked,
      }), 'Mark wages PAID on that job'),
    h('button', {
      class: 'primary', onclick: async () => {
        let job = chosen;
        if (!job) {
          job = {
            ...store.blankJob(),
            project: p.project_name || p.employer || 'Job from stub',
            company: p.employer || '',
            start_date: p.period_start || '', end_date: p.period_end || '',
          };
        }
        if (markPaid) job.wages_status = 'paid';
        await store.putJob(job);
        const stubRec = {
          id: store.uid(),
          drive_file_id: uploaded?.id || '', photo_name: uploaded?.name || '',
          vendor: p.vendor, project_name: p.project_name, employer: p.employer,
          period_start: p.period_start, period_end: p.period_end,
          hourly_rates: p.hourly_rates || [], hours: p.hours,
          gross: p.gross, net: p.net, check_no: p.check_no, check_date: p.check_date,
          matched_job_id: job.id,
          ocr_text_excerpt: (ocrText || '').slice(0, 500),
        };
        await store.putStub(stubRec);
        if (auth.isConnected()) sync.pushJob(job).catch(e => toast('Sync: ' + e.message, 5000));
        toast(markPaid ? `Stub filed — ${job.project} wages marked paid ✓` : 'Stub filed.');
        render('home');
      },
    }, 'Save'),
    h('button', { class: 'secondary', onclick: () => confirmStubForm(p, uploaded, ocrText) }, '← Back'),
  ));
  viewEl.scrollTop = 0;
}

// ---------- review (calendar import) ----------
async function review() {
  const queued = await store.allQueued();
  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, '📥 Calendar import'),
      h('p', { class: 'muted' }, 'Events on your calendar that look like job entries (rates, "gear", "paid"…) land here for review — nothing is imported without your OK.'),
      h('button', {
        class: 'secondary', onclick: async () => {
          try {
            toast('Scanning calendar history…');
            const n = await sync.historyImportScan();
            toast(n ? `Found ${n} job-looking event${n > 1 ? 's' : ''} to review.` : 'No new job-looking events found.');
            render('review');
          } catch (e) { toast(e.message, 6000); }
        },
      }, 'Scan calendar history')),
    queued.length ? h('div', { class: 'card' },
      h('h2', {}, `To review (${queued.length})`),
      queued.map(item => h('div', { class: 'candidate' },
        h('div', { class: 'title' }, item.summary),
        h('div', { class: 'sub muted small' }, [fmtRange(item.start, item.end), item.description].filter(Boolean).join(' · ')),
        h('div', { class: 'row2 mt' },
          h('button', {
            class: 'primary inline', onclick: async () => {
              try {
                const job = await sync.importQueuedAsJob(item, { push: auth.isConnected() });
                toast(`Imported "${job.project}".`);
              } catch (e) { toast(e.message, 5000); }
            },
          }, 'Import as job'),
          h('button', {
            class: 'secondary inline', onclick: () => store.dequeueImport(item.id),
          }, 'Not a job'))))) : null,
  );
}

// ---------- settings ----------
async function settingsView() {
  const s = settings();
  const clientIdInput = h('input', {
    value: s.clientId, placeholder: '1234…apps.googleusercontent.com',
    onchange: (e) => saveSettings({ clientId: e.target.value.trim() }),
  });
  const alertInput = h('input', {
    type: 'number', value: s.alertDays, inputmode: 'numeric',
    onchange: (e) => saveSettings({ alertDays: parseInt(e.target.value, 10) || 14 }),
  });

  const calCard = h('div', { class: 'card' },
    h('h2', {}, 'Calendar'),
    s.calendarId
      ? h('p', {}, 'Syncing with: ', h('b', {}, s.calendarName || s.calendarId))
      : h('p', { class: 'muted' }, 'Connect Google, then pick the calendar to sync with.'),
    h('button', {
      class: 'secondary', onclick: async () => {
        try {
          const cals = await g.listCalendars();
          const picker = h('div', {},
            cals.map(c => h('div', {
              class: 'candidate' + (c.id === s.calendarId ? ' best' : ''),
              onclick: () => {
                saveSettings({ calendarId: c.id, calendarName: c.summary, lastCalPull: '' });
                toast(`Syncing with "${c.summary}".`);
                render('settings');
              },
            }, c.summary)));
          calCard.append(picker);
        } catch (e) { toast(e.message, 6000); }
      },
    }, s.calendarId ? 'Change calendar' : 'Pick calendar'));

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Google connection'),
      h('p', { class: 'muted small' }, 'One-time: create an OAuth Client ID in Google Cloud console (see README) and paste it here. Your data never leaves your own Google account.'),
      h('label', {}, 'OAuth Client ID'), clientIdInput,
      h('button', {
        class: 'primary', onclick: async () => {
          try {
            await auth.connect();
            toast('Connected ✓ — setting up Drive & Sheet…');
            await sync.ensureCloudSetup();
            await sync.pullSheet();
            sync.scheduleMirror();
            render('settings');
          } catch (e) { toast(e.message, 8000); }
        },
      }, auth.isConnected() ? 'Reconnect Google' : 'Connect Google'),
      auth.isConnected() ? h('button', { class: 'secondary', onclick: () => { auth.disconnect(); render('settings'); } }, 'Disconnect') : null),
    calCard,
    h('div', { class: 'card' },
      h('h2', {}, 'Alerts'),
      h('label', {}, 'Consider unpaid overdue after (days past wrap)'), alertInput,
      h('p', { class: 'muted small mt' }, 'Unpaid jobs get a "💰 Follow up" calendar event at that date with an email + notification from Google Calendar. Marking the job paid removes it.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Data'),
      h('p', { class: 'muted small' },
        s.sheetId ? h('span', {}, 'Database: ', h('a', { href: `https://docs.google.com/spreadsheets/d/${s.sheetId}`, target: '_blank' }, 'PayTrack DB sheet'), ' in your Drive. Stub photos: PayTrack/Paystubs folder.')
          : 'Connect Google to create the PayTrack DB sheet + Drive folder.'),
      h('button', {
        class: 'secondary', onclick: async () => {
          try { await sync.pullSheet(); await sync.pullCalendar(); await sync.mirrorSheet(); toast('Synced ✓'); }
          catch (e) { toast(e.message, 6000); }
        },
      }, 'Sync now')),
  );
}

// ---------- boot ----------
function setConnDot(state) {
  const dot = document.getElementById('conn-status');
  dot.className = state === 'connected' ? 'on' : (auth.hasCredentials() ? 'warn' : '');
  dot.title = state === 'connected' ? 'Google connected' : 'Google not connected';
}
auth.authBus.addEventListener('state', (e) => setConnDot(e.detail));

async function backgroundSync() {
  if (!auth.hasCredentials()) return;
  try {
    await auth.token();               // silent refresh if possible
    await sync.pullCalendar();
    await sync.pullSheet();
  } catch (e) {
    if (e.code !== 'NEEDS_CONNECT') console.warn('sync', e);
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render('home');
window.addEventListener('load', () => setTimeout(backgroundSync, 1500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') backgroundSync();
});
