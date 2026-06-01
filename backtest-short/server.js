// Short Backtest Server — Port 3214
const express = require('../node_modules/express');
const path    = require('path');
const { runBacktest, loadResults, getSignalsSummary } = require('./engine');

const app  = express();
const PORT = 3214;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Signal Summary ────────────────────────────────────────────────────────────
app.get('/api/signals-summary', (req, res) => {
  try { res.json({ ok: true, summary: getSignalsSummary() }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─── Load cached results ───────────────────────────────────────────────────────
app.get('/api/results', (req, res) => {
  const r = loadResults();
  if (!r) return res.json({ ok: false, error: 'No results yet. Run backtest first.' });
  res.json({ ok: true, results: r });
});

// ─── Run backtest (SSE stream) ─────────────────────────────────────────────────
app.get('/api/run-backtest', async (req, res) => {
  const structure  = req.query.structure || null;   // 'BULLISH' | 'BEARISH' | null (all)
  const yearFilter = req.query.year      || 'ALL';

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'start', msg: `Starting short backtest | Structure: ${structure || 'ALL'} | Year: ${yearFilter}` });

  try {
    await runBacktest({ structureFilter: structure, yearFilter }, evt => {
      send({ type: 'progress', ...evt });
    });
    const results = loadResults();
    send({ type: 'complete', results });
  } catch (e) {
    send({ type: 'error', msg: e.message });
  }
  res.end();
});

// ─── Clear price cache ─────────────────────────────────────────────────────────
app.post('/api/clear-cache', (req, res) => {
  const fs  = require('fs');
  const dir = path.join(__dirname, 'cache', 'prices');
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
  }
  res.json({ ok: true, msg: 'Price cache cleared' });
});

app.listen(PORT, () => {
  console.log(`\n📉 Short Backtest Dashboard → http://localhost:${PORT}`);
  console.log(`   Fib 0.50–0.628 (HH→HL) · SOW · SELL · Two-structure tabs\n`);
});
