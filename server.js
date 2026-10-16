const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// The three couples. Votes and posts are tracked per couple.
const COUPLES = ['bill', 'rick', 'ted'];

// In-memory cache so the UI is instant; disk is written after changes.
let data = { ideas: [] };
try {
  if (fs.existsSync(DATA_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.ideas)) data = parsed;
  }
} catch (e) {
  console.error('Could not read data file, starting fresh:', e.message);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(data), (err) => {
      if (err) console.error('Save failed:', err.message);
    });
  }, 300);
}

app.use(express.json({ limit: '20kb' }));

app.get('/api/ideas', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(data.ideas);
});

app.post('/api/ideas', (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 200);
  const by = req.body && req.body.by;
  if (!text) return res.status(400).json({ error: 'Add some text for the idea.' });
  if (!COUPLES.includes(by)) return res.status(400).json({ error: 'Pick who you are first.' });
  const idea = {
    id: crypto.randomUUID(),
    text,
    by,
    votes: [by],
    created: Date.now()
  };
  data.ideas.unshift(idea);
  save();
  res.json(idea);
});

app.post('/api/ideas/:id/vote', (req, res) => {
  const by = req.body && req.body.by;
  if (!COUPLES.includes(by)) return res.status(400).json({ error: 'Pick who you are first.' });
  const idea = data.ideas.find((i) => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });
  const at = idea.votes.indexOf(by);
  if (at === -1) idea.votes.push(by);
  else idea.votes.splice(at, 1);
  save();
  res.json(idea);
});

app.delete('/api/ideas/:id', (req, res) => {
  const by = req.body && req.body.by;
  const idea = data.ideas.find((i) => i.id === req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });
  if (idea.by !== by) return res.status(403).json({ error: 'Only the couple who posted it can remove it.' });
  data.ideas = data.ideas.filter((i) => i.id !== idea.id);
  save();
  res.json({ ok: true });
});

app.use(express.static(__dirname, { index: 'index.html', extensions: ['html'] }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('China 2026 app listening on ' + PORT);
});
