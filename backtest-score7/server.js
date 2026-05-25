// Score 7+ Backtest Server — Port 3213
const express = require('../node_modules/express');
const path    = require('path');
const { runBacktest, loadResults, getSignalsSummary } = require('./engine');

const app  = express();
const PORT = 3213;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/signals-summary', (req, res) => {
  try { res.json({ ok: true, summary: getSignalsSummary() }); }
  catch(e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/results', (req, res) => {
  const results = loadResults();
  if (!results) return res.json({ ok: false, error: 'No results yet. Run backtest first.' });
  res.json({ ok: true, results });
});

// SSE backtest stream
app.get('/api/run-backtest', (req, res) => {
  const yearFilter = req.query.year  || 'ALL';
  const topN       = parseInt(req.query.topN) || 50;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'start', msg: `Running Score 7+ backtest: Year=${yearFilter}, Top ${topN} tickers` });

  try {
    send({ type: 'progress', msg: '📂 Loading CSV trade data...', progress: 10 });
    const results = runBacktest({ yearFilter, topN });
    send({ type: 'progress', msg: `✅ Processed ${results.overall.trades.length} trades across ${results.tickerList.length} tickers`, progress: 90 });
    send({ type: 'complete', results });
  } catch(e) {
    send({ type: 'error', msg: e.message });
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`\n🚀 Score 7+ Backtest Dashboard running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}/`);
  console.log(`📡 API:       http://localhost:${PORT}/api/results\n`);
});
