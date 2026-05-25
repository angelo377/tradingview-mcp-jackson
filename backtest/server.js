// UOA Backtest Server — Port 3211
const express = require('../node_modules/express');
const path    = require('path');
const { runBacktest, loadResults, getSignalsSummary,
        runTABacktest, loadTAResults, getTASignalsSummary } = require('./engine');

const app  = express();
const PORT = 3211;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API: Signal Summary ────────────────────────────────────────────────────
app.get('/api/signals-summary', (req, res) => {
  try {
    const summary = getSignalsSummary();
    res.json({ ok: true, summary });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── API: Load cached results ───────────────────────────────────────────────
app.get('/api/results', (req, res) => {
  const results = loadResults();
  if (!results) return res.json({ ok: false, error: 'No results yet. Run backtest first.' });
  res.json({ ok: true, results });
});

// ─── API: Run Backtest (SSE stream) ─────────────────────────────────────────
app.get('/api/run-backtest', async (req, res) => {
  const direction  = req.query.direction  || 'BULLISH';
  const yearFilter = req.query.year       || 'ALL';
  const hpOnly     = req.query.hpOnly !== 'false';

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: 'start', msg: `Starting backtest: ${direction}, Year:${yearFilter}, HP:${hpOnly}` });

  try {
    await runBacktest({ direction, yearFilter, hpOnly }, (evt) => {
      send({ type: 'progress', ...evt });
    });
    const results = loadResults();
    send({ type: 'complete', results });
  } catch(e) {
    send({ type: 'error', msg: e.message });
  }
  res.end();
});

// ─── API: TA Signal Summary ─────────────────────────────────────────────────
app.get('/api/ta-signals-summary', (req, res) => {
  try { res.json({ ok: true, summary: getTASignalsSummary() }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

// ─── API: Load TA cached results ────────────────────────────────────────────
app.get('/api/ta-results', (req, res) => {
  const r = loadTAResults();
  if (!r) return res.json({ ok: false, error: 'No TA results yet. Run TA backtest first.' });
  res.json({ ok: true, results: r });
});

// ─── API: Run TA Backtest (SSE stream) ──────────────────────────────────────
app.get('/api/run-ta-backtest', async (req, res) => {
  const scoreMin   = parseInt(req.query.scoreMin)  || 0;
  const yearFilter = req.query.year                || 'ALL';

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: 'start', msg: `Starting TA Backtest: scoreMin:${scoreMin}, Year:${yearFilter}` });

  try {
    await runTABacktest({ scoreMin, yearFilter }, evt => send({ type: 'progress', ...evt }));
    const results = loadTAResults();
    send({ type: 'complete', results });
  } catch(e) {
    send({ type: 'error', msg: e.message });
  }
  res.end();
});

// ─── TA Results dedicated page ──────────────────────────────────────────────
app.get('/ta', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ta.html'));
});

// ─── API: Clear cache ───────────────────────────────────────────────────────
app.post('/api/clear-cache', (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const dir  = path.join(__dirname, 'cache', 'prices');
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
  }
  res.json({ ok: true, msg: 'Price cache cleared' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 UOA Backtest Dashboard running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`📡 API:       http://localhost:${PORT}/api/results\n`);
});
