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
  : '$' + Number(n).toLocaleString('en-US', Number.isInteger(n)
    ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);

function fmtRange(a, b, alwaysYear = false) {
  if (!a) return 'no dates';
  const cy = String(new Date().getFullYear());
  const f = (d) => {
    const opts = { month: 'short', day: 'numeric' };
    if (alwaysYear || !d.startsWith(cy)) opts.year = 'numeric';
    return new Date(d + 'T00:00:00').toLocaleDateString('en-US', opts);
  };
  return !b || b === a ? f(a) : `${f(a)} – ${f(b)}`;
}

function jobDays(job) {
  if (job.days_worked) return job.days_worked;
  if (!job.start_date) return 1;
  const d = Math.round((new Date(job.end_date || job.start_date) - new Date(job.start_date)) / 86400000) + 1;
  return Math.max(1, d);
}

function isOverdue(job) {
  return Object.values(sync.jobDueDates(job)).some(d => d < today());
}

// ---------- views ----------
let currentView = 'home';
const views = { home, jobs, stub, totals, review, settings: settingsView };

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
  const stubs = await store.allStubs();
  const stubsByJob = {};
  for (const s of stubs) {
    if (s.matched_job_id) (stubsByJob[s.matched_job_id] ||= []).push(s);
  }
  const unpaidWages = jobs.filter(j => j.wages_status !== 'paid');
  const unpaidGear = jobs.filter(j => j.gear_status !== 'paid' && j.gear_status !== 'na');
  const overdue = jobs.filter(isOverdue);
  const gearOut = unpaidGear.reduce((s, j) => s + (j.gear_total || 0), 0);
  const wagesOut = unpaidWages.reduce((s, j) => s + (j.rate_amount ? j.rate_amount * jobDays(j) : 0), 0);

  // Last three calendar months, oldest first (wages + gear combined).
  const nowD = new Date();
  const last3 = [2, 1, 0].map(k => {
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - k, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    let paid = 0, due = 0;
    for (const j of jobs.filter(x => x.start_date?.startsWith(m))) {
      const w = jobWages(j, stubsByJob);
      if (w) { if (j.wages_status === 'paid') paid += w.amount; else due += w.amount; }
      if (j.gear_status !== 'na' && j.gear_total !== null && j.gear_total !== undefined) {
        if (j.gear_status === 'paid') paid += j.gear_total; else due += j.gear_total;
      }
    }
    return { label: d.toLocaleString('en-US', { month: 'long' }), paid, due };
  });

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
    h('div', { class: 'card' },
      h('h2', {}, 'Last 3 months'),
      h('table', { class: 'tot' },
        h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Paid'), h('th', {}, 'Outstanding')),
        last3.map(r => h('tr', {},
          h('td', {}, r.label),
          h('td', {}, r.paid ? fmt$(r.paid) : '—'),
          h('td', { style: r.due ? 'color:var(--bad);font-weight:600' : '' }, r.due ? fmt$(r.due) : '—'))))),
    overdue.length ? h('div', { class: 'card' },
      h('h2', {}, 'Overdue'),
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
      h('div', { class: 'sub' }, [fmtRange(job.start_date, job.end_date),
        job.days_worked ? `${job.days_worked} day${job.days_worked === 1 ? '' : 's'}` : '', rate,
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

const { gearUnits, calcGearTotal } = store;

function addDaysStr(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function editJob(existing) {
  const job = existing ? { ...existing } : store.blankJob();
  let weeks = 1;
  const input = (key, attrs = {}) => h('input', {
    value: job[key] ?? '', ...attrs,
    oninput: (e) => {
      job[key] = attrs.type === 'number'
        ? (e.target.value === '' ? null : parseFloat(e.target.value))
        : e.target.value;
      if (['gear_rate', 'days_worked', 'start_date', 'end_date'].includes(key)) gearHintUpdate();
    },
  });

  const hoursInput = input('rate_hours', { type: 'number', inputmode: 'numeric', placeholder: 'other' });
  const hoursSeg = segmented('hours', String(job.rate_hours || ''),
    [['10', '10 hr'], ['12', '12 hr']],
    v => { job.rate_hours = parseInt(v, 10); hoursInput.value = v; });

  const gearHint = h('p', { class: 'muted small' }, '');
  const gearHintUpdate = () => {
    const u = gearUnits(job);
    gearHint.textContent = job.gear_rate && u
      ? `= ${fmt$(job.gear_rate * u)} gear total for ${u} ${job.gear_period === 'week' ? 'week' : 'day'}${u === 1 ? '' : 's'} (auto-filled on save if total left blank)`
      : '';
  };
  const gearSeg = segmented('gearper', job.gear_period || 'day',
    [['day', 'Per day'], ['week', 'Per week']],
    v => { job.gear_period = v; gearHintUpdate(); });
  gearHintUpdate();

  const form = h('div', { class: 'card' },
    h('h2', {}, existing ? 'Edit job' : 'New job'),
    h('label', {}, 'Project / show'), input('project', { placeholder: 'e.g. Ritual' }),
    h('label', {}, 'Company (optional)'), input('company', { placeholder: 'production co / who pays' }),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'First day'), input('start_date', { type: 'date' })),
      h('div', {}, h('label', {}, 'Last day'), input('end_date', { type: 'date' }))),
    h('label', {}, 'Days actually worked (optional — for owed-wages estimate)'),
    input('days_worked', { type: 'number', inputmode: 'numeric', placeholder: 'e.g. 2' }),
    existing ? null : h('div', {},
      h('label', {}, 'Weeks (multi-week job: creates Week 1, Week 2, … entries, each tracked separately)'),
      h('input', {
        type: 'number', inputmode: 'numeric', value: '1', min: '1', max: '26',
        oninput: (e) => weeks = Math.max(1, parseInt(e.target.value, 10) || 1),
      })),
    h('label', {}, 'Wages / day ($)'),
    input('rate_amount', { type: 'number', inputmode: 'decimal', placeholder: '955' }),
    h('label', {}, 'Guaranteed hours'),
    h('div', { class: 'row2' }, h('div', {}, hoursSeg), h('div', {}, hoursInput)),
    h('label', {}, 'Rate note (if not day rate — e.g. "scale", "$87/hr")'), input('rate_text', { placeholder: 'scale' }),
    h('label', {}, 'Wages'),
    segmented('wages', job.wages_status,
      [['unpaid', 'Unpaid'], ['partial', 'Partial'], ['paid', 'Paid']],
      v => job.wages_status = v),
    h('div', { class: 'row2 mt' },
      h('div', {}, h('label', {}, 'Gear rate ($)'), input('gear_rate', { type: 'number', inputmode: 'decimal', placeholder: '1200' })),
      h('div', {}, h('label', {}, 'Rate is'), gearSeg)),
    h('label', {}, 'Gear total ($, or leave blank to auto-fill from rate)'),
    input('gear_total', { type: 'number', inputmode: 'decimal' }),
    gearHint,
    h('label', {}, 'Gear payment'),
    segmented('gear', job.gear_status,
      [['na', 'No gear'], ['unpaid', 'Unpaid'], ['partial', 'Partial'], ['paid', 'Paid']],
      v => job.gear_status = v),
    h('label', {}, `Expect payment by (blank = wrap + ${settings().alertDaysWages}d wages / +${settings().alertDaysGear}d gear)`),
    input('expected_pay_date', { type: 'date' }),
    h('label', {}, 'Notes'), h('textarea', {
      oninput: (e) => job.notes = e.target.value,
    }, job.notes || ''),
    h('button', {
      class: 'primary', onclick: async () => {
        if (!job.project && !job.notes) return toast('Give the job at least a name.');
        if (job.end_date && job.start_date && job.end_date < job.start_date) job.end_date = job.start_date;
        if (weeks > 1 && !job.start_date) return toast('Multi-week jobs need a first day (of week 1).');
        if (job.gear_status === 'na' && (job.gear_rate || job.gear_total)) job.gear_status = 'unpaid';

        const toSave = [];
        if (!existing && weeks > 1) {
          for (let k = 0; k < weeks; k++) {
            toSave.push({
              ...job,
              id: k === 0 ? job.id : store.uid(),
              project: `${job.project} (Week ${k + 1})`,
              start_date: addDaysStr(job.start_date, 7 * k),
              end_date: addDaysStr(job.end_date || job.start_date, 7 * k),
            });
          }
        } else {
          toSave.push(job);
        }
        for (const j of toSave) {
          calcGearTotal(j);
          await store.putJob(j);
          if (auth.isConnected()) sync.pushJob(j).catch(e => toast('Calendar sync: ' + e.message, 5000));
        }
        toast(toSave.length > 1 ? `Saved ${toSave.length} weekly entries.` : 'Saved.');
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

// ---------- totals ----------
let totalsYear = new Date().getFullYear();

// Actual stub gross when paystubs are matched to the job; rate × days otherwise.
function jobWages(job, stubsByJob) {
  const grosses = (stubsByJob[job.id] || []).map(s => s.gross).filter(x => x !== null && x !== undefined);
  if (grosses.length) return { amount: grosses.reduce((a, b) => a + b, 0), actual: true };
  if (job.rate_amount) return { amount: job.rate_amount * jobDays(job), actual: false };
  return null;
}

async function totals() {
  const jobs = (await store.allJobs()).filter(j => j.start_date);
  const stubs = await store.allStubs();
  const stubsByJob = {};
  for (const s of stubs) {
    if (s.matched_job_id) (stubsByJob[s.matched_job_id] ||= []).push(s);
  }
  const years = [...new Set(jobs.map(j => j.start_date.slice(0, 4)))].sort().reverse();
  if (years.length && !years.includes(String(totalsYear))) totalsYear = Number(years[0]);

  const months = {};
  const acc = { wagesPaid: 0, wagesDue: 0, gearPaid: 0, gearDue: 0 };
  let estimated = 0, noAmount = 0;
  for (const j of jobs.filter(x => x.start_date.startsWith(String(totalsYear)))) {
    const m = j.start_date.slice(0, 7);
    const row = months[m] ||= { wages: 0, gear: 0 };
    const w = jobWages(j, stubsByJob);
    if (w) {
      row.wages += w.amount;
      if (!w.actual) estimated++;
      if (j.wages_status === 'paid') acc.wagesPaid += w.amount; else acc.wagesDue += w.amount;
    } else noAmount++;
    if (j.gear_status !== 'na' && j.gear_total !== null && j.gear_total !== undefined) {
      row.gear += j.gear_total;
      if (j.gear_status === 'paid') acc.gearPaid += j.gear_total; else acc.gearDue += j.gear_total;
    }
  }
  const monthKeys = Object.keys(months).sort();
  const monthName = (m) => new Date(m + '-02T00:00:00').toLocaleString('en-US', { month: 'long' });
  const yearSeg = h('div', { class: 'seg' },
    years.map(y => h('button', {
      class: String(totalsYear) === y ? 'sel' : '',
      onclick: () => { totalsYear = Number(y); render('totals'); },
    }, y)));

  return h('div', {},
    h('div', { class: 'card' },
      h('h2', {}, 'Year'),
      years.length ? yearSeg : h('p', { class: 'muted' }, 'No dated jobs yet.')),
    h('div', { class: 'card' },
      h('h2', {}, `${totalsYear} totals`),
      h('div', { class: 'stat-row' },
        h('div', { class: 'stat ok' },
          h('div', { class: 'num' }, fmt$(acc.wagesPaid)),
          h('div', { class: 'lbl' }, 'wages paid')),
        h('div', { class: 'stat ok' },
          h('div', { class: 'num' }, fmt$(acc.gearPaid)),
          h('div', { class: 'lbl' }, 'gear paid'))),
      h('div', { class: 'stat-row mt' },
        h('div', { class: 'stat ' + (acc.wagesDue ? 'bad' : '') },
          h('div', { class: 'num' }, fmt$(acc.wagesDue)),
          h('div', { class: 'lbl' }, 'wages still owed')),
        h('div', { class: 'stat ' + (acc.gearDue ? 'bad' : '') },
          h('div', { class: 'num' }, fmt$(acc.gearDue)),
          h('div', { class: 'lbl' }, 'gear still owed')))),
    h('div', { class: 'card' },
      h('h2', {}, 'By month'),
      monthKeys.length ? h('table', { class: 'tot' },
        h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Wages'), h('th', {}, 'Gear'), h('th', {}, 'Total')),
        monthKeys.map(m => h('tr', {},
          h('td', {}, monthName(m)),
          h('td', {}, months[m].wages ? fmt$(months[m].wages) : '—'),
          h('td', {}, months[m].gear ? fmt$(months[m].gear) : '—'),
          h('td', {}, (months[m].wages + months[m].gear) ? fmt$(months[m].wages + months[m].gear) : '—'))),
        h('tr', { class: 'sum' },
          h('td', {}, 'Year'),
          h('td', {}, fmt$(acc.wagesPaid + acc.wagesDue)),
          h('td', {}, fmt$(acc.gearPaid + acc.gearDue)),
          h('td', {}, fmt$(acc.wagesPaid + acc.wagesDue + acc.gearPaid + acc.gearDue))))
        : h('p', { class: 'muted' }, 'Nothing recorded for this year.'),
      (estimated || noAmount) ? h('p', { class: 'muted small mt' },
        [estimated ? `${estimated} job${estimated === 1 ? '' : 's'} counted at rate × days (no stub matched yet).` : '',
          noAmount ? `${noAmount} job${noAmount === 1 ? '' : 's'} with no amounts not included.` : ''].filter(Boolean).join(' ')) : null),
  );
}

// ---------- paystub ----------
let stubFile = null;

async function stub() {
  const onPick = (e) => {
    stubFile = e.target.files[0] || null;
    render('stub');
  };
  // Two hidden inputs behind clearly labeled buttons. `capture` jumps
  // straight to the camera on phones AND restricts the Mac file dialog, so
  // the file-picker input must not have it (and no accept filter either —
  // some pickers grey out HEIC/PDF regardless of what the filter says).
  const cameraInput = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment',
    style: 'display:none', onchange: onPick,
  });
  const libraryInput = h('input', { type: 'file', style: 'display:none', onchange: onPick });
  const connected = auth.isConnected() || auth.hasCredentials();

  const card = h('div', { class: 'card' },
    h('h2', {}, 'Scan a paystub'),
    h('p', { class: 'muted' }, 'Photograph the stub (flat, well lit). It is read with Google OCR and matched to your jobs — the photo itself is never stored, only the extracted details. You confirm everything before it counts.'),
    cameraInput, libraryInput,
    h('div', { class: 'row2 mt' },
      h('button', { class: 'secondary', style: 'margin-top:0', onclick: () => cameraInput.click() }, 'Take a photo'),
      h('button', { class: 'secondary', style: 'margin-top:0', onclick: () => libraryInput.click() }, 'Choose a file…')),
    h('p', { class: 'muted small mt' }, '…or drag a photo onto this box.'),
    h('div', {},
      stubFile ? h('img', { class: 'stub-preview', src: URL.createObjectURL(stubFile) }) : null,
      stubFile ? h('button', {
        class: 'primary', onclick: () => runStubPipeline(stubFile),
      }, connected ? 'Scan & match' : 'Scan (connect Google in Setup first)') : null,
      h('button', { class: 'secondary', onclick: () => confirmStubForm(blankParse(), null, null) },
        'Enter a stub manually instead')),
  );
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.style.borderColor = 'var(--accent)'; });
  card.addEventListener('dragleave', () => { card.style.borderColor = ''; });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.style.borderColor = '';
    const f = e.dataTransfer.files?.[0];
    if (f) { stubFile = f; render('stub'); }
  });
  return h('div', {}, card);
}

// Google's image-to-Doc OCR conversion rejects large files (~2MB cap) and
// some phone formats (HEIC), so shrink + re-encode to JPEG in the browser.
async function normalizeImage(file, maxDim = 2200, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    let blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
    if (blob && blob.size > 1900000) {
      blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.6));
    }
    return blob || file;
  } catch {
    return file;   // e.g. PDFs — upload as-is
  }
}

async function runStubPipeline(file) {
  if (!auth.hasCredentials()) { toast('Connect Google in Setup first.'); return; }
  const status = h('div', { class: 'card center' }, h('span', { class: 'spinner' }, '…'), ' Reading stub…');
  viewEl.replaceChildren(status);
  try {
    const img = file.type === 'application/pdf' ? file : await normalizeImage(file);
    const text = await g.ocrImage(img);   // temp OCR doc is deleted; photo is not stored
    const parsed = parseStub(text || '');
    confirmStubForm(parsed, null, text);
  } catch (e) {
    toast(/400/.test(e.message)
      ? 'Google couldn\'t read that file (format or size). Take the photo with the in-app camera, or use a JPEG/PNG.'
      : e.message, 7000);
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
  if (!Array.isArray(p.earnings)) p.earnings = [];
  const earnBox = h('div', {});
  const redrawEarn = () => {
    const num = (obj, key) => (ev) => obj[key] = ev.target.value === '' ? null : parseFloat(ev.target.value);
    earnBox.replaceChildren(
      ...p.earnings.map((e, i) => h('div', { class: 'earnrow' },
        h('input', { value: e.type || '', placeholder: 'Type', oninput: ev => e.type = ev.target.value }),
        h('input', { value: e.hours ?? '', placeholder: 'hrs', type: 'number', inputmode: 'decimal', oninput: num(e, 'hours') }),
        h('input', { value: e.rate ?? '', placeholder: '$/hr', type: 'number', inputmode: 'decimal', oninput: num(e, 'rate') }),
        h('input', { value: e.amount ?? '', placeholder: '$', type: 'number', inputmode: 'decimal', oninput: num(e, 'amount') }),
        h('button', {
          class: 'inline secondary', type: 'button',
          onclick: () => { p.earnings.splice(i, 1); redrawEarn(); },
        }, '×'))),
      h('button', {
        class: 'inline secondary', type: 'button', style: 'margin-top:8px',
        onclick: () => { p.earnings.push({ type: '', hours: null, rate: null, amount: null }); redrawEarn(); },
      }, '+ Add line'));
  };
  redrawEarn();

  viewEl.replaceChildren(h('div', { class: 'card' },
    h('h2', {}, 'Confirm stub details' + (p.vendor ? ` — ${p.vendor}` : '')),
    h('p', { class: 'muted small' }, 'OCR pre-filled what it could. Fix anything that looks wrong.'),
    h('label', {}, 'Project'), input('project_name'),
    h('label', {}, 'Employer / production co'), input('employer'),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Paid to (you or your company)'), input('payee')),
      h('div', {}, h('label', {}, 'Classification'), input('classification', { placeholder: 'Loan Out / W-2 …' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Period start'), input('period_start', { type: 'date' })),
      h('div', {}, h('label', {}, 'Period end'), input('period_end', { type: 'date' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Days worked'), input('day_count', { type: 'number', inputmode: 'numeric' })),
      h('div', {}, h('label', {}, 'Total hours'), input('hours', { type: 'number', inputmode: 'decimal' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Gross ($)'), input('gross', { type: 'number', inputmode: 'decimal' })),
      h('div', {}, h('label', {}, 'Net ($)'), input('net', { type: 'number', inputmode: 'decimal' }))),
    h('div', { class: 'row2' },
      h('div', {}, h('label', {}, 'Check #'), input('check_no')),
      h('div', {}, h('label', {}, 'Check date'), input('check_date', { type: 'date' }))),
    h('label', {}, 'Hourly rates seen (comma-separated)'), input('hourly_rates', { placeholder: '81.82, 90' }),
    h('label', {}, 'Earnings breakdown (kept with the stub record)'),
    earnBox,
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
          // Job was never logged (user error) but the payment came through:
          // create it from the stub and it gets pushed to the calendar as
          // a PAID event below, so the record exists everywhere.
          job = {
            ...store.blankJob(),
            project: p.project_name || p.employer || 'Job from stub',
            company: p.employer || '',
            start_date: p.period_start || '', end_date: p.period_end || '',
            days_worked: p.day_count || null,
            notes: ['Created from paystub', p.gross ? `gross ${fmt$(p.gross)}` : '',
              p.check_no ? `check #${p.check_no}` : ''].filter(Boolean).join(' · '),
          };
        }
        if (markPaid) job.wages_status = 'paid';
        // Backfill basics the job was missing, so the calendar event ends up
        // with company etc. without dumping the whole stub into it.
        if (!job.company && p.employer) job.company = p.employer;
        if (!job.days_worked && p.day_count) job.days_worked = p.day_count;
        if (markPaid && p.check_date) {
          const extras = [p.gross ? `gross ${fmt$(p.gross)}` : '',
            p.hours ? `${p.hours} hrs` : '', p.day_count ? `${p.day_count} days` : '']
            .filter(Boolean).join(' · ');
          const line = `Paid ${p.check_date}${p.check_no ? `, check #${p.check_no}` : ''}${extras ? ` (${extras})` : ''}`;
          if (!job.notes.includes(line)) job.notes = job.notes ? `${job.notes}\n${line}` : line;
        }
        await store.putJob(job);
        const stubRec = {
          id: store.uid(),
          drive_file_id: '', photo_name: '',
          vendor: p.vendor, project_name: p.project_name, employer: p.employer,
          payee: p.payee || '', classification: p.classification || '',
          earnings: p.earnings || [],
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
      h('h2', {}, 'Calendar import'),
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
      }, 'Scan calendar history'),
      h('label', {}, 'Or import an events file (.json)'),
      h('input', {
        type: 'file', accept: '.json,application/json',
        onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          try {
            const items = JSON.parse(await f.text());
            if (!Array.isArray(items)) throw new Error('File must contain a JSON array.');
            let n = 0;
            for (const it of items) {
              if (!it || !it.summary || !it.start) continue;
              await store.queueImport({
                id: String(it.id || store.uid()), summary: String(it.summary),
                description: String(it.description || ''),
                start: String(it.start), end: String(it.end || it.start),
                no_cal: !!it.no_cal,
              });
              n++;
            }
            toast(`Queued ${n} event${n === 1 ? '' : 's'} for review.`);
          } catch (err) { toast('Import failed: ' + err.message, 6000); }
        },
      })),
    queued.length ? h('div', { class: 'card' },
      h('h2', {}, `To review (${queued.length})`),
      h('button', {
        class: 'primary', onclick: async () => {
          const items = await store.allQueued();
          let n = 0;
          for (const item of items) {
            try { await sync.importQueuedAsJob(item, { push: auth.isConnected() }); n++; }
            catch (e) { console.warn('import', e); }
          }
          toast(`Imported ${n} job${n === 1 ? '' : 's'}.`);
          render('jobs');
        },
      }, `Import all ${queued.length} as jobs`),
      queued.map(item => h('div', { class: 'candidate' },
        h('div', { class: 'title' }, item.summary),
        h('div', { class: 'sub muted small' }, [fmtRange(item.start, item.end, true), item.description].filter(Boolean).join(' · ')),
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
  const wagesAlertInput = h('input', {
    type: 'number', value: s.alertDaysWages, inputmode: 'numeric',
    onchange: (e) => saveSettings({ alertDaysWages: parseInt(e.target.value, 10) || 14 }),
  });
  const gearAlertInput = h('input', {
    type: 'number', value: s.alertDaysGear, inputmode: 'numeric',
    onchange: (e) => saveSettings({ alertDaysGear: parseInt(e.target.value, 10) || 30 }),
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
      h('div', { class: 'row2' },
        h('div', {}, h('label', {}, 'Wages overdue after (days past wrap)'), wagesAlertInput),
        h('div', {}, h('label', {}, 'Gear overdue after (days past wrap)'), gearAlertInput)),
      h('p', { class: 'muted small mt' }, 'Wages and gear each get their own "Follow up" calendar event on their own timer, with an email + notification from Google Calendar. Marking a part paid removes its reminder. A job\'s "expect payment by" date overrides both timers.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Data'),
      h('p', { class: 'muted small' },
        s.sheetId ? h('span', {}, 'Database: ', h('a', { href: `https://docs.google.com/spreadsheets/d/${s.sheetId}`, target: '_blank' }, 'PayTrack DB sheet'), ' in your Drive. Stub photos are never stored — only extracted details.')
          : 'Connect Google to create the PayTrack DB sheet.'),
      h('button', {
        class: 'secondary', onclick: async () => {
          try { await sync.pullSheet(); await sync.pullCalendar(); await sync.mirrorSheet(); toast('Synced ✓'); }
          catch (e) { toast(e.message, 6000); }
        },
      }, 'Sync now')),
  );
}

// ---------- boot ----------
// Keep in sync with the CACHE version in sw.js on every release.
const APP_VERSION = 'v18';
document.getElementById('ver').textContent = APP_VERSION;
function setConnDot(state) {
  const dot = document.getElementById('conn-status');
  dot.className = state === 'connected' ? 'on' : (auth.hasCredentials() ? 'warn' : '');
  dot.title = state === 'connected' ? 'Google connected' : 'Google not connected — tap to reconnect';
}
auth.authBus.addEventListener('state', (e) => setConnDot(e.detail));
setConnDot(auth.isConnected() ? 'connected' : 'disconnected');
// One-tap reconnect: a real click is a user gesture, so the Google popup
// is allowed here even when silent refresh was blocked.
document.getElementById('conn-status').addEventListener('click', async () => {
  if (auth.isConnected()) return toast('Google connected.');
  try {
    await auth.connect();
    toast('Reconnected ✓');
    backgroundSync();
  } catch (e) { toast(e.message, 6000); }
});

async function backgroundSync() {
  if (!auth.hasCredentials() || !settings().everConnected) return;
  try {
    await auth.token();               // silent refresh if possible
    await sync.pullCalendar();
    await sync.pullSheet();
    await sync.pushUnsynced();
  } catch (e) {
    if (e.code !== 'NEEDS_CONNECT') console.warn('sync', e);
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // When an UPDATED service worker takes control, reload once so the page
  // immediately runs the new version instead of the stale cached one. The
  // hadController check keeps the very first visit from reloading.
  const hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloadedForUpdate) {
      reloadedForUpdate = true;
      location.reload();
    }
  });
}
render('home');
window.addEventListener('load', () => setTimeout(backgroundSync, 1500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    backgroundSync();
    navigator.serviceWorker?.getRegistration?.().then(r => r?.update()).catch(() => {});
  }
});
