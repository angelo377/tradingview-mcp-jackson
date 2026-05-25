// UOA Compounding Backtest Server — Port 3212
const express = require('../node_modules/express');
const path    = require('path');
const { runBacktest, loadResults, getSignalsSummary } = require('./engine');

const app  = express();
const PORT = 3212;

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
  const yearFilter = req.query.year    || 'ALL';
  const hpOnly     = req.query.hpOnly !== 'false';

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: 'start', msg: `Starting compounding backtest: Year:${yearFilter}, HP:${hpOnly}` });

  try {
    await runBacktest({ yearFilter, hpOnly }, (evt) => {
      send({ type: 'progress', ...evt });
    });
    const results = loadResults();
    send({ type: 'complete', results });
  } catch(e) {
    send({ type: 'error', msg: e.message });
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`\n🚀 UOA Compounding Backtest running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`📡 API:       http://localhost:${PORT}/api/results\n`);
});
