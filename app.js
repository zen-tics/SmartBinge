/* ============================================================
   BUY LATER — app logic
   100% offline. No fetch(), no XHR, no analytics, no network.
   Storage: IndexedDB (images as blobs) on this device only.
   ============================================================ */

'use strict';

/* ============================================================
   MONETIZATION CONFIG  ── edit these to control tiering.
   Set a number to cap projects for that tier, or 0 for unlimited.
   Both default to 0 (unlimited) so the app is fully open today.
   Example later:  FREE_PROJECT_LIMIT = 3;  PREMIUM_PROJECT_LIMIT = 0;
   ============================================================ */
const FREE_PROJECT_LIMIT = 0;     // 0 = unlimited
const PREMIUM_PROJECT_LIMIT = 0;  // 0 = unlimited

function projectLimit() {
  const lim = (settings.tier === 'premium') ? PREMIUM_PROJECT_LIMIT : FREE_PROJECT_LIMIT;
  return lim === 0 ? Infinity : lim;
}

/* ---------- Defaults / settings ---------- */
const DEFAULTS = {
  theme: 'dark',
  palette: 'A',             // A = Cobalt Dark, B = Electric Teal, C = Sunset Cobalt, D = Pastel
  tier: 'free',             // 'free' | 'premium' — gating flag, wired but unrestricted by default
  remindersOn: true,
  thresholdPrice: 50,      // SGD — global default, projects can override
  daysUnder: 7,            // cooling-off days for items < threshold
  minsUnder: 0,            // extra minutes on top of daysUnder
  daysOver: 14,            // cooling-off days for items >= threshold
  minsOver: 0,             // extra minutes on top of daysOver
  ocrOn: true,
  lastProjectId: null,     // remembers last project used for adding
};
let settings = { ...DEFAULTS };

/* ---------- IndexedDB ---------- */
const DB_NAME = 'buylater', DB_VER = 2;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('items')) {
        const s = d.createObjectStore('items', { keyPath: 'id' });
        s.createIndex('status', 'status', { unique: false });
      }
      if (!d.objectStoreNames.contains('settings')) {
        d.createObjectStore('settings', { keyPath: 'k' });
      }
      // v2: projects store
      if (!d.objectStoreNames.contains('projects')) {
        d.createObjectStore('projects', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
function dbGetAll(store) {
  return new Promise((res, rej) => { const r = tx(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function dbPut(store, val) {
  return new Promise((res, rej) => { const r = tx(store, 'readwrite').put(val); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}
function dbGet(store, key) {
  return new Promise((res, rej) => { const r = tx(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function dbDelete(store, key) {
  return new Promise((res, rej) => { const r = tx(store, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}

async function loadSettings() {
  const rows = await dbGetAll('settings');
  rows.forEach(r => { if (r.k in settings) settings[r.k] = r.v; });
}
async function saveSetting(k, v) { settings[k] = v; await dbPut('settings', { k, v }); }

/* ============================================================
   PROJECTS  (v2)
   A project = a folder with its own colour, optional per-price
   wait rules, and an optional budget envelope.
   ============================================================ */

// Pastel folder colours (Sanrio / Little-Twin-Stars spirit).
const FOLDER_COLORS = [
  { id: 'blue',     name: 'Baby Blue',  hex: '#A8D8F0' },
  { id: 'pink',     name: 'Baby Pink',  hex: '#F8C8DC' },
  { id: 'mint',     name: 'Mint',       hex: '#B8E6D1' },
  { id: 'lavender', name: 'Lavender',   hex: '#D4C5F0' },
  { id: 'butter',   name: 'Butter',     hex: '#F8E8B0' },
  { id: 'peach',    name: 'Peach',      hex: '#F8D0B8' },
  { id: 'lilac',    name: 'Lilac',      hex: '#E5C8E8' },
  { id: 'sky',      name: 'Sky',        hex: '#C5E3F0' },
];
function folderHex(colorId) {
  const c = FOLDER_COLORS.find(c => c.id === colorId);
  return c ? c.hex : FOLDER_COLORS[0].hex;
}

/* Build a fresh project object. Wait rules default to null = inherit global. */
function newProject(name, colorId) {
  return {
    id: uid(),
    name: name,
    color: colorId || 'blue',
    createdOn: new Date().toISOString(),
    // per-project wait rules — null means "use the global SmartBinge default"
    thresholdPrice: null,
    daysUnder: null, minsUnder: null,
    daysOver: null,  minsOver: null,
    // budget envelope — null means "no budget set" (dormant, Option A empty state)
    budget: null,            // the original/base amount the user set
    budgetLog: [],           // [{type:'set'|'topup'|'reduce'|'spend', amount, on, itemName?}]
  };
}

async function getProjects() { return (await dbGetAll('projects')) || []; }
async function getProject(id) { return id ? await dbGet('projects', id) : null; }
async function saveProject(p) { await dbPut('projects', p); }

/* Effective wait rule for a project: its own value, or the global fallback. */
function projThreshold(p) { return (p && p.thresholdPrice != null) ? p.thresholdPrice : settings.thresholdPrice; }
function projWait(p, isOver) {
  if (isOver) {
    return {
      days: (p && p.daysOver != null) ? p.daysOver : settings.daysOver,
      mins: (p && p.minsOver != null) ? p.minsOver : settings.minsOver,
    };
  }
  return {
    days: (p && p.daysUnder != null) ? p.daysUnder : settings.daysUnder,
    mins: (p && p.minsUnder != null) ? p.minsUnder : settings.minsUnder,
  };
}

/* Budget maths from the log (single source of truth). */
function budgetState(p) {
  if (!p || p.budget == null) return null;
  let base = 0, spent = 0, topped = 0, reduced = 0;
  (p.budgetLog || []).forEach(e => {
    if (e.type === 'set') base = e.amount;
    else if (e.type === 'topup') topped += e.amount;
    else if (e.type === 'reduce') reduced += e.amount;
    else if (e.type === 'spend') spent += e.amount;
  });
  const allowance = base + topped - reduced;
  return { base, spent, topped, reduced, allowance, remaining: allowance - spent };
}

/* One-time migration: if items exist but no project does, create "My List"
   and assign every existing (unassigned) item to it. Idempotent. */
async function migrateToProjects() {
  const projects = await getProjects();
  const items = await dbGetAll('items');

  if (projects.length === 0) {
    // first run of v2 — make the default project
    const def = newProject('My List', 'blue');
    await saveProject(def);
    // move any pre-existing items into it
    for (const it of items) {
      if (!it.projectId) { it.projectId = def.id; await dbPut('items', it); }
    }
    if (settings.lastProjectId == null) await saveSetting('lastProjectId', def.id);
    return def.id;
  }

  // projects already exist — just catch any stray unassigned items
  const fallbackId = settings.lastProjectId || projects[0].id;
  for (const it of items) {
    if (!it.projectId) { it.projectId = fallbackId; await dbPut('items', it); }
  }
  return fallbackId;
}

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const DAY = 86400000;
const todayISO = () => new Date().toISOString().slice(0, 10);
function fmtDate(iso) {
  if (!iso) return '';
  // handle both "2026-06-22" and full ISO timestamps
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = iso.includes('T') ? new Date(iso) : new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}
function fmtMoney(n) {
  if (n == null || n === '' || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/* In-memory project cache, refreshed before each render so the synchronous
   cooling-off helpers can look up a project without async calls. */
let projCache = {};
async function refreshProjCache() {
  const ps = await getProjects();
  projCache = {};
  ps.forEach(p => { projCache[p.id] = p; });
  return ps;
}
function projOf(item) { return item && item.projectId ? projCache[item.projectId] : null; }

function coolingMs(price, project) {
  const p = project || null;
  const isOver = Number(price) >= projThreshold(p);
  const w = projWait(p, isOver);
  return ((w.days || 0) * DAY) + ((w.mins || 0) * 60000);
}
function coolingLabel(price, project) {
  const p = project || null;
  const isOver = Number(price) >= projThreshold(p);
  const w = projWait(p, isOver);
  const parts = [];
  if (w.days) parts.push(w.days + 'd');
  if (w.mins) parts.push(w.mins + 'm');
  return parts.length ? parts.join(' ') : '0d';
}
function reviewDate(item) {
  const base = new Date((item.lastDeferredOn || item.addedOn) + 'T00:00:00').getTime();
  return base + coolingMs(item.price, projOf(item));
}
function isDue(item) {
  return item.status === 'waiting' && Date.now() >= reviewDate(item);
}
function timeLeft(item) {
  const ms = reviewDate(item) - Date.now();
  if (ms <= 0) return 'now';
  const totalMins = Math.ceil(ms / 60000);
  if (totalMins < 60) return totalMins + 'm';
  const hrs = Math.floor(totalMins / 60);
  if (hrs < 24) return hrs + 'h';
  return Math.ceil(ms / DAY) + 'd';
}
let blobURLs = [];
function blobURL(blob) { const u = URL.createObjectURL(blob); blobURLs.push(u); return u; }
function revokeURLs() { blobURLs.forEach(u => URL.revokeObjectURL(u)); blobURLs = []; }

/* ---------- Toast ---------- */
let toastT;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- Navigation ---------- */
let current = 'list';
let currentProjectId = null;   // when viewing inside a single project
async function go(tab) {
  current = tab;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const viewEl = $('view-' + tab);
  if (viewEl) viewEl.classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('main').scrollTop = 0;
  await refreshProjCache();
  if (tab === 'list') renderProjects();        // "list" tab now shows the Projects overview
  if (tab === 'project') renderProject();      // single project detail
  if (tab === 'inbox') renderInbox();
  if (tab === 'stats') renderStats();
  if (tab === 'settings') renderSettings();
}

/* ============================================================
   ADD FLOW
   ============================================================ */
let draft = null; // { blob, imgURL, source, url, projectId }

async function openAdd(forceProjectId) {
  await refreshProjCache();
  const projects = await getProjects();
  // default to: explicit target, or current project, or last used, or first
  let targetId = forceProjectId || currentProjectId || settings.lastProjectId;
  if (!targetId || !projects.find(p => p.id === targetId)) {
    targetId = projects[0] ? projects[0].id : null;
  }
  draft = { blob: null, imgURL: null, source: '', url: '', projectId: targetId };

  // render the project picker chip row
  renderAddProjectPicker(projects, targetId);

  $('urlField').style.display = 'none';
  $('previewWrap').style.display = 'none';
  $('formFields').style.display = 'none';
  $('urlInput').value = '';
  document.querySelectorAll('.src-opt').forEach(o => o.classList.remove('on'));
  showSheet('add');
}
function closeAdd() { hideSheet('add'); }

function renderAddProjectPicker(projects, selectedId) {
  const el = $('addProjectPicker');
  if (!el) return;
  const chips = projects.map(p => {
    const hex = folderHex(p.color);
    return `<button class="proj-chip ${p.id===selectedId?'on':''}" style="--fc:${hex}" data-pid="${p.id}" onclick="pickAddProject('${p.id}')">
      <span class="proj-chip-dot"></span>${esc(p.name)}
    </button>`;
  }).join('');
  el.innerHTML = `<div class="add-proj-label">Adding to</div><div class="proj-chip-row">${chips}</div>`;
}
function pickAddProject(pid) {
  draft.projectId = pid;
  document.querySelectorAll('#addProjectPicker .proj-chip').forEach(c => c.classList.toggle('on', c.dataset.pid === pid));
}

function pickSource(kind) {
  document.querySelectorAll('.src-opt').forEach(o => o.classList.remove('on'));
  $('src' + kind.charAt(0).toUpperCase() + kind.slice(1)).classList.add('on');
  $('screenshotTip').style.display = 'none';
  if (kind === 'camera') { $('urlField').style.display = 'none'; $('fileCamera').click(); }
  else if (kind === 'upload') { $('urlField').style.display = 'none'; $('fileUpload').click(); }
  else if (kind === 'screenshot') {
    $('urlField').style.display = 'none';
    $('previewWrap').style.display = 'none';
    $('formFields').style.display = 'none';
    $('screenshotTip').style.display = 'block';
  }
  else if (kind === 'url') {
    $('urlField').style.display = 'block';
    $('previewWrap').style.display = 'none';
    $('formFields').style.display = 'block';
    prefillForm({});
    draft.source = '';
  }
}

async function takeScreenshot() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast('Screen capture not supported in this browser');
    return;
  }
  let stream;
  try {
    // Ask the browser to share the screen — a system-level permission prompt
    // appears; the user chooses what to share. This is enforced by the OS and
    // cannot be bypassed. The app captures ONE frame then immediately stops.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: false,
    });
  } catch (err) {
    // User cancelled or denied — not an error, just close the tip
    $('screenshotTip').style.display = 'none';
    $('srcScreenshot').classList.remove('on');
    return;
  }

  // Grab a single frame via an offscreen video element -> canvas -> blob
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();

  // Give the video one frame to render
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);

  // Stop sharing immediately — single frame captured, nothing more is read
  stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;

  // Convert to blob and process exactly like a photo upload
  canvas.toBlob(async (blob) => {
    if (!blob) { toast('Capture failed — try again'); return; }
    $('screenshotTip').style.display = 'none';
    const scaled = await downscale(blob, 1280);
    draft.blob = scaled;
    draft.imgURL = blobURL(scaled);
    $('previewImg').src = draft.imgURL;
    $('previewWrap').style.display = 'block';
    $('formFields').style.display = 'block';
    prefillForm({});
    if (settings.ocrOn) runOCR(scaled);
  }, 'image/jpeg', 0.85);
}

$('urlInput')?.addEventListener('input', (e) => {
  const v = e.target.value.trim();
  draft.url = v;
  try { const h = new URL(v).hostname.replace(/^www\./, ''); if (h) $('fSource').value = h; } catch (_) {}
});

async function onFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  // downscale to keep storage light & speed OCR — all in-browser
  const blob = await downscale(file, 1280);
  draft.blob = blob;
  draft.imgURL = blobURL(blob);
  $('previewImg').src = draft.imgURL;
  $('previewWrap').style.display = 'block';
  $('formFields').style.display = 'block';
  prefillForm({});
  if (settings.ocrOn) runOCR(blob);
}

function downscale(file, maxDim) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      c.toBlob(b => resolve(b), 'image/jpeg', 0.82);
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}

function prefillForm({ name, price, source, date }) {
  $('fName').value = name || '';
  $('fPrice').value = price != null ? price : '';
  $('fSource').value = source || $('fSource').value || '';
  $('fDate').value = date || todayISO();
  $('fNote').value = '';
}

/* ---------- On-device OCR (Tesseract.js, model bundled locally) ---------- */
async function runOCR(blob) {
  if (typeof Tesseract === 'undefined') { return; } // bundle missing — skip silently
  const status = $('scanStatus'); status.style.display = 'flex';
  $('scanText').textContent = 'Reading details on-device…';
  try {
    const { data } = await Tesseract.recognize(blob, 'eng', {
      // point Tesseract at LOCAL assets so it never reaches the internet
      workerPath: 'tess/worker.min.js',
      corePath: 'tess/tesseract-core-simd-lstm.wasm.js',
      langPath: 'tess/',
      logger: m => {
        if (m.status === 'recognizing text') $('scanText').textContent = 'Reading details… ' + Math.round(m.progress * 100) + '%';
      }
    });
    const text = (data && data.text) ? data.text : '';
    const found = applyOCR(text) || {};
    status.style.display = 'none';
    const got = ['name', 'price', 'source'].filter(k => found[k]);
    if (got.length >= 2) toast('Scanned — check the details');
    else if (got.length === 1) toast('Got the ' + got[0] + ' — add the rest');
    else toast("Couldn't read it — type the details");
  } catch (err) {
    status.style.display = 'none';
    // OCR is best-effort; the user can always type the fields.
    console.warn('OCR unavailable:', err && err.message);
  }
}

function applyOCR(text) {
  if (!text) return;
  const rawLines = text.split('\n').map(s => s.replace(/\s{2,}/g, ' ').trim()).filter(Boolean);
  const joined = text.replace(/\n/g, ' ');

  /* ---------- PRICE ----------
     Prefer a value attached to a currency symbol. Also handle "split" prices
     where a retail tag shows the dollars big and the cents small, so OCR
     reads "$9 10" or "$9" then "10" on separate tokens -> 9.10. */
  const price = detectPrice(text);

  /* ---------- NAME ----------
     Score each line. A product name is usually a SHORT, prominent line with
     capital letters, near the top — not a long lowercase marketing sentence
     and not a block of non-Latin script. We score and pick the best. */
  const name = detectName(rawLines);

  /* ---------- SOURCE ---------- */
  const sources = ['Shopee', 'Lazada', 'Taobao', 'Amazon', 'Qoo10', 'Carousell', 'AliExpress', 'Zalora', 'IKEA', 'Decathlon', 'Guardian', 'Watsons', 'Unity', 'NTUC', 'FairPrice', 'Cold Storage'];
  let source = '';
  for (const s of sources) { if (new RegExp('\\b' + s.replace(/\s/g, '\\s?') + '\\b', 'i').test(joined)) { source = s; break; } }

  if (name && !$('fName').value) $('fName').value = name;
  if (price != null && !$('fPrice').value) $('fPrice').value = price;
  if (source && !$('fSource').value) $('fSource').value = source;

  return { name: !!name, price: price != null, source: !!source };
}

/* Remove characters OCR shouldn't be putting in a text field, collapse spaces. */
function sanitizeField(s) {
  return String(s || '')
    .replace(/[<>{}\\|`~^]/g, ' ')      // strip markup-ish / junk chars
    .replace(/[^\w\s.,&+%/()'°-]/g, ' ') // keep letters, digits, common punctuation
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* Detect a price. Only currency-anchored numbers are trusted, so we don't grab
   random digits (sizes, quantities, SKU codes) by mistake. */
function detectPrice(text) {
  const joined = text.replace(/\n/g, ' ');
  const candidates = [];
  let m;

  // 1) symbol + decimal e.g. $9.10, SGD 12.90, RM8.80  [score 4]
  const full = /(?:S?\$|SGD|RM|USD|US\$|£|€|¥)\s?(\d{1,3}(?:,\d{3})*\.\d{2}|\d+\.\d{2})/gi;
  while ((m = full.exec(joined)) !== null) {
    const v = parseFloat(m[1].replace(/,/g, ''));
    if (!isNaN(v) && v > 0 && v < 100000) candidates.push({ v, score: 4 });
  }

  // 2) split price: symbol, dollars, then exactly 2 cents digits (no decimal)
  //    e.g. "$9 10" on a shelf tag -> 9.10  [score 3]
  const split = /(?:S?\$|SGD|RM)\s?(\d{1,4})\s+(\d{2})\b(?!\s*[\d.])/gi;
  while ((m = split.exec(joined)) !== null) {
    const v = parseFloat(parseInt(m[1], 10) + '.' + m[2]);
    if (!isNaN(v) && v > 0 && v < 100000) candidates.push({ v, score: 3 });
  }

  // 3) bare "N.NN" on its OWN line (shelf tag like "5.00" or "12.90")  [score 3]
  text.split('\n').forEach(line => {
    const t = line.trim();
    if (/^\d{1,4}\.\d{2}$/.test(t)) {
      const v = parseFloat(t);
      if (v > 0 && v < 100000) candidates.push({ v, score: 3 });
    }
  });

  // 4) bare whole number on its OWN line — e.g. "5" alone on a shelf tag line.
  //    Accept with currency context anywhere, OR if the number appears between
  //    product-name lines and barcode/sku lines (sandwich pattern on receipts).  [score 2]
  const hasCurrencyContext = /(?:S?\$|SGD|RM|USD|\$|£|€|¥)/i.test(joined);
  const allLines = text.split('\n').map(l => l.trim());
  allLines.forEach((line, li) => {
    const t = line.trim();
    if (/^\d{1,4}$/.test(t)) {
      const v = parseFloat(t);
      if (v > 0 && v < 10000) {
        // accept if there's currency context anywhere, OR if this line is
        // flanked by non-numeric product lines (not just surrounded by codes)
        const prevLine = allLines[li - 1] || '';
        const nextLine = allLines[li + 1] || '';
        const prevHasLetters = /[A-Za-z]{3,}/.test(prevLine);
        const nextHasLetters = /[A-Za-z]{3,}/.test(nextLine) || /\d{5,}/.test(nextLine);
        if (hasCurrencyContext || (prevHasLetters && nextHasLetters)) {
          candidates.push({ v, score: 2 });
        }
      }
    }
  });

  // 5) symbol + whole number e.g. $9, RM 80 (least specific)  [score 1]
  const whole = /(?:S?\$|SGD|RM|USD|US\$|£|€|¥)\s?(\d{1,5})\b(?!\s*[.\d])/gi;
  while ((m = whole.exec(joined)) !== null) {
    const v = parseFloat(m[1]);
    if (!isNaN(v) && v > 0 && v < 100000) candidates.push({ v, score: 1 });
  }

  if (!candidates.length) return null;
  // highest score wins; tie-break: prefer values that look like realistic prices
  // (avoid single digits unless nothing else found)
  candidates.sort((a, b) => b.score - a.score || b.v - a.v);
  return candidates[0].v;
}

/* Pick the most name-like line. Conservative: if nothing scores well, return
   '' and let the user type it — a blank beats a wrong guess they must delete. */
function detectName(lines) {
  // Words that mean "this line is packaging boilerplate, not the product name"
  const stop = /(^sterile$|strips?$|pcs$|pieces$|net wt|barcode|qty|made in|expiry|best before|ingredients|warning|directions|hypoallergenic|www\.|http|\.com|reg\.?\s?no|illustration|availability|visuals are|more information|flexible fabric|low allergy|low adherent|for cuts|for grazes|skin friendly)/i;
  // Promo-poster phrases (Image 4): "BUY ANY 2 ... GET 1 ..."
  const promo = /(buy any|get \d|play mode|free|% off|promo|offer|discount|drinks?)/i;

  let best = null, bestScore = 0; // guards are latin<4 and realWords<1; don't double-gate with a score floor
  lines.forEach((ln, idx) => {
    const clean = sanitizeField(ln);
    if (!clean) return;
    const latin = (clean.match(/[A-Za-z]/g) || []).length;
    const total = clean.replace(/\s/g, '').length || 1;
    if (latin / total < 0.6) return;        // mostly non-Latin script -> skip
    if (latin < 4) return;                   // too few letters (e.g. "N Cs") -> skip

    const words = clean.split(/\s+/).filter(Boolean);
    const realWords = words.filter(w => /[A-Za-z]{3,}/.test(w)); // words with >=3 letters
    if (realWords.length < 1) return;        // all fragments/codes -> skip

    // reject SKU/receipt code lines like "G ADH D/S6X8.3CM (N)" — lots of
    // single letters, slashes and digits, few real words
    const codey = words.filter(w => /[/\d]/.test(w) || w.length <= 2).length;
    if (codey >= words.length * 0.5 && realWords.length < 2) return;

    let score = 0;
    score += Math.max(0, 8 - idx) * 1.5;     // earlier lines strongly favoured
    score += realWords.length * 2;            // more real words = more name-like
    const capWords = words.filter(w => /^[A-Z]/.test(w)).length;
    score += capWords * 2;                    // Title/UPPER case = brand/product
    // single short capitalised word on an early line = strong brand signal (e.g. "Meiji")
    if (realWords.length === 1 && capWords === 1 && idx <= 2 && clean.length <= 20) score += 4;
    const lowerStart = words.filter(w => /^[a-z]/.test(w)).length;
    score -= lowerStart * 1.5;                // lowercase prose -> description
    if (clean.includes(' - ') || clean.includes('·')) score -= 6;
    if (realWords.length >= 1 && words.length <= 6) score += 2;
    if (words.length > 8) score -= 6;
    if (clean.length > 45) score -= 4;
    if (stop.test(clean)) score -= 10;
    if (promo.test(clean)) score -= 10;

    if (score > bestScore) { bestScore = score; best = clean; }
  });

  if (!best) return '';

  // Stitch adjacent lines: prepend brand above, or append product line below.
  // e.g. "Meiji" (line 0) + "Lactose Free Milk" (line 1) -> "Meiji Lactose Free Milk"
  const storeName = /^(guardian|watsons|unity|ntuc|fairprice|cold storage|shopee|lazada)$/i;
  const bi = lines.findIndex(l => sanitizeField(l) === best);

  // Try prepending the line above (brand above product)
  if (bi > 0) {
    const nb = sanitizeField(lines[bi - 1]);
    const nbWords = nb.split(/\s+/).filter(Boolean);
    const nbReal = nbWords.filter(w => /[A-Za-z]{3,}/.test(w));
    if (nbReal.length >= 1 && nbWords.length <= 3 && /^[A-Z]/.test(nb) &&
        !storeName.test(nb) && !stop.test(nb) && !promo.test(nb) && !nb.includes(' - ')) {
      best = (nb + ' ' + best).trim();
    }
  }

  // Try appending the line below (product descriptor below brand name)
  // Only if best is currently just 1-2 short words (brand only)
  const bestWords = best.split(/\s+/).filter(Boolean);
  if (bestWords.length <= 2 && bi + 1 < lines.length) {
    const nb = sanitizeField(lines[bi + 1]);
    const nbWords = nb.split(/\s+/).filter(Boolean);
    const nbReal = nbWords.filter(w => /[A-Za-z]{3,}/.test(w));
    if (nbReal.length >= 2 && nbWords.length <= 6 && !stop.test(nb) && !promo.test(nb) && !nb.includes(' - ')) {
      best = (best + ' ' + nb).trim();
    }
  }
  best = best.replace(/\s{2,}/g, ' ').trim();
  if (best.length > 60) best = best.slice(0, 60).trim();
  return best;
}

async function saveItem() {
  const name = $('fName').value.trim();
  const price = parseFloat($('fPrice').value);
  if (!name) { toast('Give it a name first'); $('fName').focus(); return; }

  // which project this item belongs to (the currently selected add-target)
  const projectId = draft.projectId || settings.lastProjectId || null;

  const item = {
    id: uid(),
    projectId,
    name,
    price: isNaN(price) ? null : price,
    source: $('fSource').value.trim(),
    note: $('fNote').value.trim(),
    url: draft.url || '',
    addedOn: $('fDate').value || todayISO(),
    lastDeferredOn: null,
    status: 'waiting',          // waiting | bought | dropped
    deferCount: 0,
    blob: draft.blob || null,
    decidedOn: null,
    history: [{ action: 'added', on: todayISO() }],
  };
  await dbPut('items', item);
  // remember this project for next time
  if (projectId) await saveSetting('lastProjectId', projectId);
  await refreshProjCache();
  closeAdd();
  toast('Saved — review in ' + coolingLabel(item.price, projCache[projectId]));
  go(currentProjectId ? 'project' : 'list');
  await refreshBadge();
}

/* ============================================================
   RENDER: PROJECTS OVERVIEW (the "List" tab)
   ============================================================ */
async function renderProjects() {
  revokeURLs();
  const projects = await refreshProjCache();
  const allItems = await dbGetAll('items');
  const el = $('projectsContent');

  // count due items per project for the badge
  const dueByProj = {};
  allItems.forEach(i => { if (isDue(i)) dueByProj[i.projectId] = (dueByProj[i.projectId] || 0) + 1; });
  const countByProj = {};
  allItems.forEach(i => { if (i.status === 'waiting') countByProj[i.projectId] = (countByProj[i.projectId] || 0) + 1; });

  // sort: projects with due items first, then by created date
  projects.sort((a, b) => (dueByProj[b.id] || 0) - (dueByProj[a.id] || 0)
    || new Date(b.createdOn) - new Date(a.createdOn));

  let html = `<div class="proj-head-row">
    <div class="eyebrow" style="margin:0">Your projects</div>
    <button class="proj-add-btn" onclick="openProjectEditor()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="16" height="16"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New
    </button>
  </div>`;

  if (!projects.length) {
    html += emptyState('grid', 'No projects yet', 'Create a project like "Reno" or "Treats" to start organising what you want to buy.');
    el.innerHTML = html;
    return;
  }

  html += '<div class="proj-grid">';
  projects.forEach(p => {
    const hex = folderHex(p.color);
    const due = dueByProj[p.id] || 0;
    const waiting = countByProj[p.id] || 0;
    const bs = budgetState(p);
    const budgetLine = bs
      ? `<div class="proj-budget"><span>${fmtMoney(bs.remaining)}</span> left of ${fmtMoney(bs.allowance)}</div>`
      : `<div class="proj-budget none">No budget set</div>`;
    html += `<div class="proj-card" style="--fc:${hex}" onclick="openProject('${p.id}')">
      <div class="proj-folder-tab"></div>
      <div class="proj-card-body">
        <div class="proj-name">${esc(p.name)}</div>
        <div class="proj-stats">${waiting} waiting${due ? ` · <b>${due} due</b>` : ''}</div>
        ${budgetLine}
      </div>
      ${due ? `<div class="proj-due-badge">${due}</div>` : ''}
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

/* ============================================================
   RENDER: PROJECT DETAIL (items in one project)
   ============================================================ */
async function renderProject() {
  revokeURLs();
  await refreshProjCache();
  const p = await getProject(currentProjectId);
  if (!p) { go('list'); return; }

  const hex = folderHex(p.color);
  const all = (await dbGetAll('items')).filter(i => i.projectId === p.id);
  const due      = all.filter(i => isDue(i));
  const waiting  = all.filter(i => i.status === 'waiting' && !isDue(i));
  const decided  = all.filter(i => i.status === 'bought' || i.status === 'dropped');
  due.sort((a, b) => reviewDate(a) - reviewDate(b));
  waiting.sort((a, b) => reviewDate(a) - reviewDate(b));
  decided.sort((a, b) => (b.decidedOn ? new Date(b.decidedOn) : 0) - (a.decidedOn ? new Date(a.decidedOn) : 0));

  // Header: back button, name, edit, and budget panel
  const bs = budgetState(p);
  const wThresh = projThreshold(p);
  const wU = projWait(p, false), wO = projWait(p, true);
  const ruleText = `Under ${fmtMoney(wThresh)}: ${wU.days||0}d${wU.mins?' '+wU.mins+'m':''} · ${fmtMoney(wThresh)}+: ${wO.days||0}d${wO.mins?' '+wO.mins+'m':''}`;

  let budgetPanel;
  if (bs) {
    const pct = bs.allowance > 0 ? Math.max(0, Math.min(100, (bs.remaining / bs.allowance) * 100)) : 0;
    const over = bs.remaining < 0;
    budgetPanel = `<div class="budget-panel" style="--fc:${hex}">
      <div class="budget-top">
        <div>
          <div class="budget-remaining ${over?'over':''}">${fmtMoney(bs.remaining)}</div>
          <div class="budget-sub">left of ${fmtMoney(bs.allowance)}</div>
        </div>
        <button class="budget-manage" onclick="openBudgetSheet('${p.id}')">Manage</button>
      </div>
      <div class="budget-bar"><div class="budget-fill ${over?'over':''}" style="width:${pct}%"></div></div>
      <div class="budget-breakdown">Spent ${fmtMoney(bs.spent)}${bs.topped?` · Topped up ${fmtMoney(bs.topped)}`:''}${bs.reduced?` · Reduced ${fmtMoney(bs.reduced)}`:''}</div>
    </div>`;
  } else {
    budgetPanel = `<button class="budget-setbtn" style="--fc:${hex}" onclick="openBudgetSheet('${p.id}')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Set a budget for this project
    </button>`;
  }

  $('projectHeader').innerHTML = `
    <div class="proj-detail-head" style="--fc:${hex}">
      <button class="back-btn" onclick="go('list')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="22" height="22"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="proj-detail-title">
        <span class="proj-dot"></span>
        <span>${esc(p.name)}</span>
      </div>
      <button class="iconbtn" onclick="openProjectEditor('${p.id}')" aria-label="Edit project">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="18" height="18"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>
      </button>
    </div>
    <div class="proj-rule-chip">${ruleText}</div>
    ${budgetPanel}
  `;

  const el = $('projectContent');
  if (!all.length) {
    el.innerHTML = emptyState('grid', 'Empty project', 'Tap + to add the first item you\'re thinking of buying for this project.');
    return;
  }
  let html = '';
  if (due.length) { html += sectionHeader('Decide now', due.length, 'var(--defer)'); html += '<div class="grid">' + due.map(cardHTML).join('') + '</div>'; }
  if (waiting.length) { html += sectionHeader('Cooling off', waiting.length, 'var(--accent)'); html += '<div class="grid">' + waiting.map(cardHTML).join('') + '</div>'; }
  if (decided.length) { html += sectionHeader('Decided', decided.length, 'var(--text-faint)'); html += '<div class="grid">' + decided.map(cardHTML).join('') + '</div>'; }
  el.innerHTML = html;
}

async function openProject(id) {
  currentProjectId = id;
  await saveSetting('lastProjectId', id);   // opening a project also makes it the add-default
  go('project');
}

/* ============================================================
   PROJECT EDITOR (create / edit / delete)
   ============================================================ */
let editingProjectId = null;

async function openProjectEditor(id) {
  editingProjectId = id || null;
  const p = id ? await getProject(id) : null;

  // tier gate (no-op while limits are unlimited)
  if (!p) {
    const count = (await getProjects()).length;
    if (count >= projectLimit()) {
      toast('Project limit reached for your plan');
      return;
    }
  }

  const name = p ? p.name : '';
  const color = p ? p.color : 'blue';
  const t = p && p.thresholdPrice != null ? p.thresholdPrice : '';
  const du = p && p.daysUnder != null ? p.daysUnder : '';
  const mu = p && p.minsUnder != null ? p.minsUnder : '';
  const dov = p && p.daysOver != null ? p.daysOver : '';
  const mov = p && p.minsOver != null ? p.minsOver : '';

  const swatches = FOLDER_COLORS.map(c =>
    `<button class="color-swatch ${c.id===color?'on':''}" style="background:${c.hex}" onclick="pickProjColor('${c.id}')" data-color="${c.id}" aria-label="${c.name}"></button>`
  ).join('');

  $('projEditContent').innerHTML = `
    <h2>${p ? 'Edit project' : 'New project'}</h2>
    <div class="sub">Give it a name and colour. Wait rules are optional — leave blank to use your global defaults.</div>

    <div class="field">
      <label>Project name</label>
      <input type="text" id="peName" placeholder="e.g. Reno, Treats, Gifts" value="${esc(name)}">
    </div>

    <div class="field">
      <label>Folder colour</label>
      <div class="color-row" id="peColors">${swatches}</div>
      <input type="hidden" id="peColor" value="${color}">
    </div>

    <div class="field">
      <label>Custom wait rules (optional)</label>
      <div class="hint" style="margin-top:0;margin-bottom:10px">Leave blank to inherit your global defaults (${fmtMoney(settings.thresholdPrice)} threshold · ${settings.daysUnder}d under · ${settings.daysOver}d over).</div>
      <div class="pe-rule">
        <span class="pe-rule-label">Price threshold</span>
        <div class="num"><input type="number" id="peThresh" placeholder="${settings.thresholdPrice}" value="${t}" inputmode="decimal"></div>
      </div>
      <div class="pe-rule">
        <span class="pe-rule-label">Under threshold</span>
        <div class="dur-mini"><input type="number" id="peDaysU" placeholder="${settings.daysUnder}" value="${du}" inputmode="numeric"><span>d</span></div>
        <div class="dur-mini"><input type="number" id="peMinsU" placeholder="${settings.minsUnder}" value="${mu}" inputmode="numeric"><span>m</span></div>
      </div>
      <div class="pe-rule">
        <span class="pe-rule-label">Over threshold</span>
        <div class="dur-mini"><input type="number" id="peDaysO" placeholder="${settings.daysOver}" value="${dov}" inputmode="numeric"><span>d</span></div>
        <div class="dur-mini"><input type="number" id="peMinsO" placeholder="${settings.minsOver}" value="${mov}" inputmode="numeric"><span>m</span></div>
      </div>
    </div>

    <button class="btn primary" onclick="saveProjectFromEditor()" style="margin-top:6px">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      ${p ? 'Save changes' : 'Create project'}
    </button>
    ${p ? `<button class="btn ghost" onclick="confirmDeleteProject('${p.id}')" style="margin-top:10px;color:var(--drop)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      Delete project
    </button>` : ''}
  `;
  showSheet('projEdit');
}
function closeProjectEditor() { hideSheet('projEdit'); }

function pickProjColor(cid) {
  document.querySelectorAll('#peColors .color-swatch').forEach(s => s.classList.toggle('on', s.dataset.color === cid));
  $('peColor').value = cid;
}

function numOrNull(id) {
  const v = $(id).value.trim();
  if (v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

async function saveProjectFromEditor() {
  const name = $('peName').value.trim();
  if (!name) { toast('Give the project a name'); $('peName').focus(); return; }

  let p;
  if (editingProjectId) {
    p = await getProject(editingProjectId);
  } else {
    p = newProject(name, $('peColor').value);
  }
  p.name = name;
  p.color = $('peColor').value;
  p.thresholdPrice = numOrNull('peThresh');
  p.daysUnder = numOrNull('peDaysU');
  p.minsUnder = numOrNull('peMinsU');
  p.daysOver  = numOrNull('peDaysO');
  p.minsOver  = numOrNull('peMinsO');

  await saveProject(p);
  await refreshProjCache();
  if (!editingProjectId) await saveSetting('lastProjectId', p.id);
  closeProjectEditor();
  toast(editingProjectId ? 'Project updated' : 'Project created');
  if (currentProjectId === p.id) go('project'); else go('list');
}

async function confirmDeleteProject(id) {
  const items = (await dbGetAll('items')).filter(i => i.projectId === id);
  const projects = await getProjects();
  if (projects.length <= 1) { toast('Keep at least one project'); return; }
  const msg = items.length
    ? `Delete this project and its ${items.length} item${items.length>1?'s':''}? This cannot be undone.`
    : 'Delete this empty project?';
  if (!confirm(msg)) return;
  for (const it of items) await dbDelete('items', it.id);
  await dbDelete('projects', id);
  // fix lastProjectId if it pointed here
  if (settings.lastProjectId === id) {
    const remaining = (await getProjects())[0];
    await saveSetting('lastProjectId', remaining ? remaining.id : null);
  }
  await refreshProjCache();
  closeProjectEditor();
  currentProjectId = null;
  toast('Project deleted');
  go('list');
}

/* ============================================================
   BUDGET MANAGEMENT (set / top-up / reduce, with logged history)
   ============================================================ */
let budgetProjectId = null;

async function openBudgetSheet(id) {
  budgetProjectId = id;
  const p = await getProject(id);
  if (!p) return;
  const bs = budgetState(p);

  let body;
  if (!bs) {
    // Option A empty state — invite to set a budget
    body = `
      <h2>Set a budget</h2>
      <div class="sub">Give "${esc(p.name)}" a spending envelope. Each buy decision will draw it down so you can see what's left. Optional — set it only if you want.</div>
      <div class="field">
        <label>Budget amount (SGD)</label>
        <input type="number" id="bdAmount" placeholder="0.00" inputmode="decimal" step="0.01" autofocus>
      </div>
      <button class="btn primary" onclick="setBudget()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        Start budget
      </button>
    `;
  } else {
    const over = bs.remaining < 0;
    const log = (p.budgetLog || []).slice().reverse().map(e => {
      const label = e.type === 'set' ? 'Budget set'
        : e.type === 'topup' ? 'Topped up'
        : e.type === 'reduce' ? 'Reduced'
        : 'Bought: ' + (e.itemName || 'item');
      const sign = (e.type === 'spend' || e.type === 'reduce') ? '−' : '+';
      const cls = (e.type === 'spend' || e.type === 'reduce') ? 'minus' : 'plus';
      return `<div class="blog-row">
        <div class="blog-label">${esc(label)}<span class="blog-date">${fmtDate(e.on)}</span></div>
        <div class="blog-amt ${cls}">${sign}${fmtMoney(e.amount)}</div>
      </div>`;
    }).join('');

    body = `
      <h2>${esc(p.name)} budget</h2>
      <div class="budget-hero ${over?'over':''}">
        <div class="budget-hero-num">${fmtMoney(bs.remaining)}</div>
        <div class="budget-hero-sub">remaining of ${fmtMoney(bs.allowance)}</div>
      </div>
      <div class="budget-actions">
        <button class="btn defer" onclick="showBudgetInput('topup')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Top up
        </button>
        <button class="btn ghost" onclick="showBudgetInput('reduce')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Reduce
        </button>
      </div>
      <div id="budgetInputArea"></div>
      <div class="blog-head">History</div>
      <div class="blog-list">${log || '<div class="blog-empty">No activity yet</div>'}</div>
      <button class="btn ghost" onclick="clearBudget()" style="margin-top:14px;color:var(--text-dim)">Remove budget</button>
    `;
  }
  $('budgetContent').innerHTML = body;
  showSheet('budget');
}
function closeBudgetSheet() { hideSheet('budget'); }

async function setBudget() {
  const amt = parseFloat($('bdAmount').value);
  if (isNaN(amt) || amt <= 0) { toast('Enter a budget amount'); return; }
  const p = await getProject(budgetProjectId);
  p.budget = amt;
  p.budgetLog = [{ type: 'set', amount: amt, on: new Date().toISOString() }];
  await saveProject(p);
  await refreshProjCache();
  toast('Budget set');
  openBudgetSheet(budgetProjectId);  // refresh sheet
  if (currentProjectId === p.id) renderProject();
}

function showBudgetInput(mode) {
  const area = $('budgetInputArea');
  const verb = mode === 'topup' ? 'Top up by' : 'Reduce by';
  area.innerHTML = `
    <div class="budget-input-row">
      <input type="number" id="bdDelta" placeholder="0.00" inputmode="decimal" step="0.01" autofocus>
      <button class="btn primary" style="width:auto;padding:13px 18px" onclick="applyBudgetDelta('${mode}')">${verb}</button>
    </div>`;
  $('bdDelta').focus();
}

async function applyBudgetDelta(mode) {
  const amt = parseFloat($('bdDelta').value);
  if (isNaN(amt) || amt <= 0) { toast('Enter an amount'); return; }
  const p = await getProject(budgetProjectId);
  p.budgetLog = p.budgetLog || [];
  p.budgetLog.push({ type: mode, amount: amt, on: new Date().toISOString() });
  await saveProject(p);
  await refreshProjCache();
  toast(mode === 'topup' ? 'Topped up' : 'Reduced');
  openBudgetSheet(budgetProjectId);
  if (currentProjectId === p.id) renderProject();
}

async function clearBudget() {
  if (!confirm('Remove this budget? Spending history will be cleared.')) return;
  const p = await getProject(budgetProjectId);
  p.budget = null;
  p.budgetLog = [];
  await saveProject(p);
  await refreshProjCache();
  closeBudgetSheet();
  toast('Budget removed');
  if (currentProjectId === p.id) renderProject();
}

function sectionHeader(label, count, color) {
  return `<div class="list-section-head" style="--sc:${color}">
    <span class="lsh-label">${label}</span>
    <span class="lsh-count">${count}</span>
  </div>`;
}

function cardHTML(i) {
  const due = isDue(i);
  const decided = i.status === 'bought' || i.status === 'dropped';
  const img = i.blob
    ? `<img class="thumb" src="${blobURL(i.blob)}" alt="">`
    : `<div class="thumb placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></div>`;

  let pill, when, overlay = '';

  if (i.status === 'bought') {
    pill = '<span class="pill bought">Bought</span>';
    when = `<div class="when decided-ts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="11" height="11"><path d="M20 6 9 17l-5-5"/></svg>
      ${fmtDateTime(i.decidedOn)}
    </div>`;
    overlay = `<div class="card-decided-bar bought"></div>`;
  } else if (i.status === 'dropped') {
    pill = '<span class="pill dropped">Dropped</span>';
    when = `<div class="when decided-ts">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="11" height="11"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      ${fmtDateTime(i.decidedOn)}
    </div>`;
    overlay = `<div class="card-decided-bar dropped"></div>`;
  } else if (due) {
    pill = '<span class="pill due">Decide now</span>';
    when = `<div class="when">Added ${fmtDate(i.addedOn)}</div>`;
  } else {
    pill = `<span class="pill waiting">${timeLeft(i)} left</span>`;
    when = `<div class="when">Added ${fmtDate(i.addedOn)}</div>`;
  }

  return `<div class="card ${decided ? 'card-decided' : ''}" onclick="openDetail('${i.id}')">
    ${due ? '<div class="due-dot"></div>' : ''}
    ${overlay}
    ${img}
    <div class="body">
      <div class="name">${esc(i.name)}</div>
      <div class="meta"><span class="price">${fmtMoney(i.price)}</span>${pill}</div>
      ${when}
    </div>
  </div>`;
}

/* ============================================================
   RENDER: INBOX (due reviews)
   ============================================================ */
async function renderInbox() {
  revokeURLs();
  const items = (await dbGetAll('items')).filter(i => isDue(i));
  items.sort((a, b) => reviewDate(a) - reviewDate(b));
  const el = $('inboxContent');
  if (!items.length) {
    el.innerHTML = emptyState('check', 'Inbox zero',
      'No items are due for review. When a cooling-off period ends, the item shows up here to decide on.');
    return;
  }
  el.innerHTML = items.map(i => {
    const img = i.blob
      ? `<img class="ithumb" src="${blobURL(i.blob)}" alt="">`
      : `<div class="ithumb placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg></div>`;
    const waited = Math.round((Date.now() - new Date(i.addedOn + 'T00:00:00').getTime()) / DAY);
    return `<div class="inbox-row" onclick="openDetail('${i.id}')">
      ${img}
      <div class="info">
        <div class="n">${esc(i.name)}</div>
        <div class="d">${fmtMoney(i.price)} · <b>waited ${waited}d</b>${i.deferCount ? ' · deferred ' + i.deferCount + '×' : ''}</div>
      </div>
      <div class="chev"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div>
    </div>`;
  }).join('');
}

/* ============================================================
   DETAIL + ACTIONS
   ============================================================ */
let activeId = null;
async function openDetail(id) {
  const i = await dbGet('items', id);
  if (!i) return;
  activeId = id;
  const due = isDue(i);
  const img = i.blob
    ? `<img class="detail-img" src="${blobURL(i.blob)}" alt="">` : '';
  const banner = i.status === 'waiting'
    ? (due
      ? `<div class="review-banner due"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Cooling-off complete. Still want it?</div>`
      : `<div class="review-banner waiting"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Cooling off — ${timeLeft(i)} left to review.</div>`)
    : `<div class="review-banner ${i.status === 'bought' ? 'waiting' : 'due'}" style="background:var(--${i.status==='bought'?'buy':'drop'}-soft);color:var(--${i.status==='bought'?'buy':'drop'})">${i.status === 'bought' ? 'You bought this' : 'You dropped this'} on ${fmtDateTime(i.decidedOn)}.</div>`;

  const urlChip = i.url ? `<a class="chip" href="${esc(i.url)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Open link</a>` : '';

  const actions = i.status === 'waiting' ? `
    <div class="action-grid">
      <button class="btn buy" onclick="decide('buy')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>Buy it</button>
      <button class="btn defer" onclick="decide('defer')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Defer</button>
      <button class="btn drop" onclick="decide('drop')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>Drop it</button>
    </div>` : `
    <button class="btn ghost" onclick="reopen()" style="margin-top:6px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Move back to waiting</button>`;

  $('detailContent').innerHTML = `
    <h2 style="margin-bottom:14px">Item</h2>
    ${img}
    <div class="detail-price">${fmtMoney(i.price)}</div>
    <div class="detail-name">${esc(i.name)}</div>
    <div class="detail-meta">
      ${i.source ? `<span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>${esc(i.source)}</span>` : ''}
      <span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>${fmtDate(i.addedOn)}</span>
      ${i.deferCount ? `<span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Deferred ${i.deferCount}×</span>` : ''}
      ${urlChip}
    </div>
    ${i.note ? `<div class="chip" style="display:block;width:100%;text-align:left;white-space:normal;line-height:1.5;padding:12px 14px;margin-bottom:16px">${esc(i.note)}</div>` : ''}
    ${banner}
    ${actions}
    <button class="btn ghost" onclick="deleteItem()" style="margin-top:10px;color:var(--text-dim)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>Delete permanently</button>
  `;
  showSheet('detail');
}
function closeDetail() { hideSheet('detail'); }

async function decide(action) {
  const i = await dbGet('items', activeId);
  if (!i) return;
  const proj = projOf(i);
  if (action === 'defer') {
    i.lastDeferredOn = todayISO();
    i.deferCount = (i.deferCount || 0) + 1;
    i.history.push({ action: 'deferred', on: todayISO() });
    await dbPut('items', i);
    toast('Deferred — back in ' + coolingLabel(i.price, proj));
  } else {
    i.status = action === 'buy' ? 'bought' : 'dropped';
    i.decidedOn = new Date().toISOString();   // full timestamp for date+time display
    i.history.push({ action: action === 'buy' ? 'bought' : 'dropped', on: todayISO() });
    await dbPut('items', i);

    // Budget envelope: a "buy" decision depletes the project's budget (if set).
    if (action === 'buy' && proj && proj.budget != null && i.price) {
      proj.budgetLog = proj.budgetLog || [];
      proj.budgetLog.push({ type: 'spend', amount: Number(i.price), on: new Date().toISOString(), itemName: i.name });
      await saveProject(proj);
      await refreshProjCache();
      const st = budgetState(proj);
      toast('Bought ✓ · ' + fmtMoney(st.remaining) + ' left in ' + proj.name);
    } else {
      toast(action === 'buy' ? 'Marked as bought ✓' : 'Dropped — money saved 🎉');
    }
  }
  closeDetail();
  await refreshBadge();
  go(current);
}

async function reopen() {
  const i = await dbGet('items', activeId);
  i.status = 'waiting'; i.decidedOn = null; i.lastDeferredOn = todayISO();
  i.history.push({ action: 'reopened', on: todayISO() });
  await dbPut('items', i);
  closeDetail(); await refreshBadge(); go(current);
  toast('Back in waiting');
}

async function deleteItem() {
  await dbDelete('items', activeId);
  closeDetail(); await refreshBadge(); go(current);
  toast('Deleted');
}

/* ============================================================
   RENDER: STATS / TRENDS
   ============================================================ */
async function renderStats() {
  const items = await dbGetAll('items');
  const bought = items.filter(i => i.status === 'bought').length;
  const dropped = items.filter(i => i.status === 'dropped').length;
  const deferTotal = items.reduce((s, i) => s + (i.deferCount || 0), 0);
  const waiting = items.filter(i => i.status === 'waiting').length;
  const decided = bought + dropped;

  const el = $('statsContent');
  if (!items.length) {
    el.innerHTML = emptyState('chart', 'No data yet',
      'Once you start deciding on items, your buy / drop / defer patterns appear here.');
    return;
  }

  const dropRate = decided ? Math.round(dropped / decided * 100) : 0;
  const savedAmt = items.filter(i => i.status === 'dropped').reduce((s, i) => s + (Number(i.price) || 0), 0);

  // Build 6-month trend of decisions
  const months = lastNMonths(6);
  const buySeries = months.map(() => 0), dropSeries = months.map(() => 0), deferSeries = months.map(() => 0);
  items.forEach(i => {
    (i.history || []).forEach(h => {
      const idx = months.findIndex(m => h.on && h.on.startsWith(m.key));
      if (idx === -1) return;
      if (h.action === 'bought') buySeries[idx]++;
      else if (h.action === 'dropped') dropSeries[idx]++;
      else if (h.action === 'deferred') deferSeries[idx]++;
    });
  });

  el.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card buy"><div class="v">${bought}</div><div class="k">Bought</div></div>
      <div class="stat-card drop"><div class="v">${dropped}</div><div class="k">Dropped</div></div>
      <div class="stat-card defer"><div class="v">${deferTotal}</div><div class="k">Defers</div></div>
    </div>

    <div class="chart-card">
      <h4>Decisions over time</h4>
      <div class="cs">Last 6 months — buy vs drop vs defer</div>
      <canvas id="trendChart" height="200"></canvas>
      <div class="chart-legend">
        <span><i style="background:var(--buy)"></i>Bought</span>
        <span><i style="background:var(--drop)"></i>Dropped</span>
        <span><i style="background:var(--defer)"></i>Deferred</span>
      </div>
    </div>

    <div class="chart-card">
      <h4>Where they end up</h4>
      <div class="cs">Of everything you've decided on</div>
      <canvas id="donutChart" height="180"></canvas>
    </div>

    <div class="insight">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/></svg>
      <div class="it">You dropped <b>${dropRate}%</b> of items you've decided on${savedAmt > 0 ? `, avoiding about <b>${fmtMoney(savedAmt)}</b> in impulse spending` : ''}. ${waiting ? `<b>${waiting}</b> still cooling off.` : 'The cooling-off habit is working.'}</div>
    </div>
  `;

  drawTrend('trendChart', months.map(m => m.label), buySeries, dropSeries, deferSeries);
  drawDonut('donutChart', bought, dropped, deferTotal);
}

function lastNMonths(n) {
  const out = [], d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: m.toISOString().slice(0, 7), label: m.toLocaleDateString(undefined, { month: 'short' }) });
  }
  return out;
}

function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

/* Lightweight canvas charts (no external chart lib needed -> smaller, offline) */
function drawTrend(id, labels, s1, s2, s3) {
  const cv = $(id); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 200;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 26, r: 8, t: 12, b: 24 };
  const maxV = Math.max(1, ...s1, ...s2, ...s3);
  const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;
  const x = i => pad.l + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = v => pad.t + plotH - (v / maxV) * plotH;

  // grid
  ctx.strokeStyle = cssVar('--line'); ctx.lineWidth = 1; ctx.fillStyle = cssVar('--text-faint'); ctx.font = '10px system-ui';
  const steps = Math.min(maxV, 4);
  for (let g = 0; g <= steps; g++) {
    const val = Math.round(maxV * g / steps), yy = y(val);
    ctx.globalAlpha = .5; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillText(val, 4, yy + 3);
  }
  labels.forEach((lb, i) => { ctx.textAlign = 'center'; ctx.fillText(lb, x(i), H - 7); });
  ctx.textAlign = 'left';

  const series = [[s1, cssVar('--buy')], [s2, cssVar('--drop')], [s3, cssVar('--defer')]];
  series.forEach(([data, color]) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.beginPath();
    data.forEach((v, i) => { i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)); });
    ctx.stroke();
    data.forEach((v, i) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x(i), y(v), 3, 0, 7); ctx.fill(); });
  });
}

function drawDonut(id, buy, drop, defer) {
  const cv = $(id); if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 180;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const total = buy + drop + defer;
  const cx = W / 2, cy = H / 2, r = 62, lw = 26;
  if (total === 0) {
    ctx.strokeStyle = cssVar('--line'); ctx.lineWidth = lw; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    ctx.fillStyle = cssVar('--text-faint'); ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.fillText('No decisions yet', cx, cy + 4);
    return;
  }
  const parts = [[buy, cssVar('--buy')], [drop, cssVar('--drop')], [defer, cssVar('--defer')]];
  let a = -Math.PI / 2;
  parts.forEach(([v, c]) => {
    if (!v) return;
    const ang = v / total * Math.PI * 2;
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(cx, cy, r, a, a + ang); ctx.stroke();
    a += ang;
  });
  ctx.fillStyle = cssVar('--text'); ctx.font = '700 26px system-ui'; ctx.textAlign = 'center';
  ctx.fillText(total, cx, cy - 2);
  ctx.fillStyle = cssVar('--text-dim'); ctx.font = '11px system-ui';
  ctx.fillText('actions', cx, cy + 16);
}

/* ============================================================
   RENDER: SETTINGS
   ============================================================ */
function renderSettings() {
  const el = $('settingsContent');
  el.innerHTML = `
    <div class="eyebrow" style="margin-top:8px">Appearance</div>
    <div class="set-group">
      <div class="set-row">
        <div class="l"><div class="t">Theme</div><div class="s">Light or dark — your eyes, your call.</div></div>
      </div>
      <div style="padding:0 16px 16px">
        <div class="segment">
          <button class="${settings.theme==='light'?'on':''}" onclick="setTheme('light')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/></svg>Light</button>
          <button class="${settings.theme==='dark'?'on':''}" onclick="setTheme('dark')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>Dark</button>
        </div>
      </div>
      <div class="set-row" style="border-top:1px solid var(--line)">
        <div class="l"><div class="t">Colour palette</div><div class="s">4 vibes, from cobalt blue to soft pastel.</div></div>
      </div>
      <div class="palette-grid">
        <div class="palette-opt ${(settings.palette||'A')==='A'?'on':''}" onclick="setPalette('A')">
          <div class="palette-swatch">
            <span style="background:#0047AB"></span>
            <span style="background:#07091A"></span>
            <span style="background:#00D97E"></span>
          </div>
          <div class="palette-label">Cobalt Dark</div>
        </div>
        <div class="palette-opt ${(settings.palette||'A')==='B'?'on':''}" onclick="setPalette('B')">
          <div class="palette-swatch">
            <span style="background:#0047AB"></span>
            <span style="background:#050E18"></span>
            <span style="background:#00C3FF"></span>
          </div>
          <div class="palette-label">Electric Teal</div>
        </div>
        <div class="palette-opt ${(settings.palette||'A')==='C'?'on':''}" onclick="setPalette('C')">
          <div class="palette-swatch">
            <span style="background:#0047AB"></span>
            <span style="background:#0C0A14"></span>
            <span style="background:#FF8C00"></span>
          </div>
          <div class="palette-label">Sunset Cobalt</div>
        </div>
        <div class="palette-opt ${(settings.palette||'A')==='D'?'on':''}" onclick="setPalette('D')">
          <div class="palette-swatch">
            <span style="background:#A8D8F0"></span>
            <span style="background:#F8C8DC"></span>
            <span style="background:#D4C5F0"></span>
          </div>
          <div class="palette-label">Pastel Dream</div>
        </div>
      </div>
    </div>

    <div class="eyebrow">Cooling-off rules</div>
    <div class="set-group">
      <div class="set-row">
        <div class="l"><div class="t">Price threshold (SGD)</div><div class="s">Items at or above this wait longer.</div></div>
        <div class="num"><input type="number" id="setThresh" value="${settings.thresholdPrice}" inputmode="decimal" onchange="saveNum('thresholdPrice',this.value,1)"></div>
      </div>
      <div class="set-row" style="flex-direction:column;align-items:stretch;gap:10px">
        <div class="l"><div class="t">Wait — under threshold</div><div class="s">Cooling-off for cheaper items. Set days, minutes, or both.</div></div>
        <div class="dur-row">
          <div class="dur-field"><input type="number" min="0" value="${settings.daysUnder}" inputmode="numeric" onchange="saveNum('daysUnder',this.value,0)"><span>days</span></div>
          <div class="dur-sep">+</div>
          <div class="dur-field"><input type="number" min="0" value="${settings.minsUnder}" inputmode="numeric" onchange="saveNum('minsUnder',this.value,0)"><span>min</span></div>
        </div>
      </div>
      <div class="set-row" style="flex-direction:column;align-items:stretch;gap:10px">
        <div class="l"><div class="t">Wait — over threshold</div><div class="s">Cooling-off for pricier items. Set days, minutes, or both.</div></div>
        <div class="dur-row">
          <div class="dur-field"><input type="number" min="0" value="${settings.daysOver}" inputmode="numeric" onchange="saveNum('daysOver',this.value,0)"><span>days</span></div>
          <div class="dur-sep">+</div>
          <div class="dur-field"><input type="number" min="0" value="${settings.minsOver}" inputmode="numeric" onchange="saveNum('minsOver',this.value,0)"><span>min</span></div>
        </div>
      </div>
    </div>

    <div class="eyebrow">Reminders & scanning</div>
    <div class="set-group">
      <div class="set-row">
        <div class="l"><div class="t">Review reminders</div><div class="s">Notify when an item's cooling-off ends. Works while the app is open; install to home screen for background nudges where supported.</div></div>
        <div class="toggle ${settings.remindersOn?'on':''}" onclick="toggleSet('remindersOn',this)"><div class="knob"></div></div>
      </div>
      <div class="set-row">
        <div class="l"><div class="t">Auto-scan photos</div><div class="s">Read name, price & store from the image on-device. Turn off to always type by hand.</div></div>
        <div class="toggle ${settings.ocrOn?'on':''}" onclick="toggleSet('ocrOn',this)"><div class="knob"></div></div>
      </div>
    </div>

    <div class="eyebrow">Your data</div>
    <div class="set-group">
      <div class="set-row" onclick="exportData()">
        <div class="l"><div class="t">Export backup</div><div class="s">Save all items as a file you control.</div></div>
        <div class="chev"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></div>
      </div>
      <div class="set-row" onclick="clearAll()">
        <div class="l"><div class="t" style="color:var(--drop)">Erase everything</div><div class="s">Permanently delete all items from this device.</div></div>
        <div class="chev"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg></div>
      </div>
    </div>

    <div class="privacy">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Fully offline · No accounts · Data never leaves this device
    </div>

    <div class="eyebrow" style="margin-top:28px">About SmartBinge</div>
    <div class="about-card">
      <div class="about-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="#0047AB" stroke-width="2" width="32" height="32"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
      </div>
      <div class="about-name">SmartBinge</div>
      <div class="about-tag">Binge less. Live more.</div>
      <div class="about-desc">SmartBinge is your mindful shopping companion. See something you want? Add it, let the cooling-off timer run, then decide with a clear head. Studies show a waiting period cuts impulse buys by 30–40%. Fully private — no accounts, no internet, no tracking. Everything lives on your phone.</div>
    </div>
  `;
}

async function setTheme(t) {
  document.body.setAttribute('data-theme', t);
  await saveSetting('theme', t);
  renderSettings();
}
async function setPalette(p) {
  document.body.setAttribute('data-palette', p);
  await saveSetting('palette', p);
  renderSettings();
}
async function saveNum(k, v, min) { let n = parseFloat(v); if (isNaN(n) || n < min) n = DEFAULTS[k]; await saveSetting(k, n); }
async function toggleSet(k, el) {
  const v = !settings[k]; el.classList.toggle('on', v); await saveSetting(k, v);
  if (k === 'remindersOn' && v) requestNotifyPermission();
}

async function exportData() {
  const items = await dbGetAll('items');
  // strip blobs (binary) -> JSON keeps it portable & private
  const clean = items.map(({ blob, ...rest }) => ({ ...rest, hadImage: !!blob }));
  const data = { app: 'SmartBinge', exportedOn: new Date().toISOString(), settings, items: clean };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'smartbinge-backup.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Backup saved');
}

async function clearAll() {
  if (!confirm('Erase all items permanently? This cannot be undone.')) return;
  const items = await dbGetAll('items');
  for (const i of items) await dbDelete('items', i.id);
  await refreshBadge(); go('list');
  toast('Everything erased');
}

/* ============================================================
   Reminders (local, no server)
   ============================================================ */
function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}
async function checkDueReminders() {
  if (!settings.remindersOn) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const items = (await dbGetAll('items')).filter(isDue);
  // notify once per item per day
  const today = todayISO();
  const notifiedKey = 'bl_notified_' + today;
  let notified = [];
  try { notified = JSON.parse(localStorage.getItem(notifiedKey) || '[]'); } catch (_) {}
  const fresh = items.filter(i => !notified.includes(i.id));
  if (fresh.length) {
    new Notification('SmartBinge — time to review', {
      body: fresh.length === 1
        ? `"${fresh[0].name}" finished cooling off. Still want it?`
        : `${fresh.length} items are ready for your decision.`,
      tag: 'buylater-review'
    });
    try { localStorage.setItem(notifiedKey, JSON.stringify([...notified, ...fresh.map(i => i.id)])); } catch (_) {}
  }
}

/* ---------- Badge ---------- */
async function refreshBadge() {
  const items = (await dbGetAll('items')).filter(isDue);
  const b = $('inboxBadge');
  b.textContent = items.length ? items.length : '';
  b.className = items.length ? 'badge' : '';
}

/* ---------- Sheets ---------- */
function showSheet(name) { $(name + 'Scrim').classList.add('show'); $(name + 'Sheet').classList.add('show'); document.body.style.overflow = 'hidden'; }
function hideSheet(name) { $(name + 'Scrim').classList.remove('show'); $(name + 'Sheet').classList.remove('show'); document.body.style.overflow = ''; }

/* ---------- utils ---------- */
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function emptyState(icon, title, body) {
  const icons = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    chart: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  };
  return `<div class="empty"><div class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor">${icons[icon]}</svg></div><h3>${title}</h3><p>${body}</p></div>`;
}

/* ---------- PWA Install prompt ---------- */
let _installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Chrome fired this — app meets install criteria.
  // Prevent the mini info-bar; we'll show our own button instead.
  e.preventDefault();
  _installPrompt = e;
  const btn = $('installBtn');
  if (btn) btn.style.display = 'grid';
});

window.addEventListener('appinstalled', () => {
  // App was installed — hide the button
  _installPrompt = null;
  const btn = $('installBtn');
  if (btn) btn.style.display = 'none';
  toast('SmartBinge installed — find it on your home screen');
});

async function triggerInstall() {
  if (!_installPrompt) return;
  _installPrompt.prompt();
  const { outcome } = await _installPrompt.userChoice;
  if (outcome === 'accepted') {
    _installPrompt = null;
    const btn = $('installBtn');
    if (btn) btn.style.display = 'none';
  }
}

/* ============================================================
   INIT
   ============================================================ */
(async function init() {
  await openDB();
  await loadSettings();
  await migrateToProjects();      // create "My List" + assign existing items (idempotent)
  await refreshProjCache();
  document.body.setAttribute('data-theme', settings.theme);
  document.body.setAttribute('data-palette', settings.palette || 'A');
  await refreshBadge();
  renderProjects();
  checkDueReminders();
  setInterval(checkDueReminders, 60 * 60 * 1000); // hourly while open
  if (settings.remindersOn) requestNotifyPermission();

  // register service worker for offline + installability
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
