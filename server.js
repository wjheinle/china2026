const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Data lives on the Railway volume. DATA_DIR wins, then /data if it exists, then the app folder.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : __dirname);
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Optional. Set EDIT_PIN in Railway variables to require a PIN for any schedule change.
const EDIT_PIN = String(process.env.EDIT_PIN || '').trim();

const MAX_ITEMS = 200;

// itinerary stays null until someone edits for the first time. The app shows its built-in
// schedule until then, and the first edit copies that schedule here.
let data = { itinerary: null };
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && (parsed.itinerary === null || Array.isArray(parsed.itinerary))) data.itinerary = parsed.itinerary;
  }
} catch (e) {
  console.error('Could not read data file, starting fresh:', e.message);
}

function saveNow() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Save failed:', e.message);
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 200);
}
// Redeploys send SIGTERM. Write anything pending before the process exits.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { clearTimeout(saveTimer); saveNow(); process.exit(0); });
}

app.use(express.json({ limit: '100kb' }));

/* ---------- helpers ---------- */
function pinOk(req) {
  if (!EDIT_PIN) return true;
  const given = Buffer.from(String(req.get('x-edit-pin') || ''));
  const want = Buffer.from(EDIT_PIN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}
function requirePin(req, res, next) {
  if (pinOk(req)) return next();
  res.status(401).json({ error: 'pin' });
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
// Returns { ok, item } or { ok: false, error }
function clean(body) {
  const b = body || {};
  const item = {
    date: String(b.date || '').trim(),
    time: String(b.time || '').trim().slice(0, 40),
    title: String(b.title || '').trim().slice(0, 120),
    note: String(b.note || '').trim().slice(0, 500)
  };
  if (!validDate(item.date)) return { ok: false, error: 'Pick a date.' };
  if (!item.title) return { ok: false, error: 'Add a title.' };
  return { ok: true, item };
}
// New items go after the last item on or before their date, so the list stays in date order.
function insertByDate(list, item) {
  let at = 0;
  list.forEach((x, i) => { if (x.date <= item.date) at = i + 1; });
  list.splice(at, 0, item);
}
function ensureList(res) {
  if (!Array.isArray(data.itinerary)) {
    res.status(409).json({ error: 'not-seeded' });
    return false;
  }
  return true;
}

/* ---------- itinerary API ---------- */
app.get('/api/itinerary', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ items: data.itinerary, locked: !!EDIT_PIN });
});

app.post('/api/itinerary/verify', requirePin, (req, res) => res.json({ ok: true }));

// First edit: copy the app's built-in schedule onto the server. Ignored if already seeded.
app.post('/api/itinerary/seed', requirePin, (req, res) => {
  if (!Array.isArray(data.itinerary)) {
    const src = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, MAX_ITEMS) : [];
    const items = [];
    for (const s of src) {
      const c = clean(s);
      if (c.ok) items.push(Object.assign({ id: crypto.randomUUID() }, c.item));
    }
    data.itinerary = items;
    save();
  }
  res.json({ items: data.itinerary, locked: !!EDIT_PIN });
});

app.post('/api/itinerary', requirePin, (req, res) => {
  if (!ensureList(res)) return;
  if (data.itinerary.length >= MAX_ITEMS) return res.status(400).json({ error: 'The schedule is full.' });
  const c = clean(req.body);
  if (!c.ok) return res.status(400).json({ error: c.error });
  insertByDate(data.itinerary, Object.assign({ id: crypto.randomUUID() }, c.item));
  save();
  res.json({ items: data.itinerary });
});

app.put('/api/itinerary/:id', requirePin, (req, res) => {
  if (!ensureList(res)) return;
  const i = data.itinerary.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'That stop was already removed.' });
  const c = clean(req.body);
  if (!c.ok) return res.status(400).json({ error: c.error });
  const old = data.itinerary[i];
  const next = Object.assign({ id: old.id }, c.item);
  if (next.date === old.date) {
    data.itinerary[i] = next;
  } else {
    data.itinerary.splice(i, 1);
    insertByDate(data.itinerary, next);
  }
  save();
  res.json({ items: data.itinerary });
});

app.delete('/api/itinerary/:id', requirePin, (req, res) => {
  if (!ensureList(res)) return;
  data.itinerary = data.itinerary.filter((x) => x.id !== req.params.id);
  save();
  res.json({ items: data.itinerary });
});

// Reorder within a day. dir is -1 (earlier) or 1 (later).
app.post('/api/itinerary/:id/move', requirePin, (req, res) => {
  if (!ensureList(res)) return;
  const dir = req.body && req.body.dir === -1 ? -1 : 1;
  const list = data.itinerary;
  const i = list.findIndex((x) => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'That stop was already removed.' });
  const j = i + dir;
  if (j >= 0 && j < list.length && list[j].date === list[i].date) {
    [list[i], list[j]] = [list[j], list[i]];
    save();
  }
  res.json({ items: list });
});

/* ---------- static files (only what the app needs) ---------- */
function sendPage(res) {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'index.html'));
}
app.get('/', (req, res) => sendPage(res));
app.get('/index.html', (req, res) => sendPage(res));
app.get('/manifest.webmanifest', (req, res) => res.sendFile(path.join(__dirname, 'manifest.webmanifest')));
app.use('/icons', express.static(path.join(__dirname, 'icons'), { maxAge: '7d' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('China 2026 app listening on ' + PORT);
  console.log('Data file: ' + DATA_FILE + (EDIT_PIN ? ' (edit PIN required)' : ' (open editing)'));
});
