// Score 7+ Backtest Engine
// Reads pre-simulated trade data from CSV — no Yahoo Finance needed.
// Computes P&L using $8,000 risk per trade (2% of $400K capital).

const fs   = require('fs');
const path = require('path');

const CSV_PATH     = path.join(__dirname, 'data', 'score7_trades.csv');
const RESULTS_FILE = path.join(__dirname, 'results.json');

const CAPITAL        = 400000;
const RISK_PER_TRADE = 8000;   // 2% of capital
const TOP_N_TICKERS  = 50;     // first N unique tickers by appearance order

// ─── CSV helpers ─────────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

function parseFloat2(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function parseInt2(v)   { const n = parseInt(v);   return isNaN(n) ? null : n; }
function bool(v)        { return v === 'True'; }

function loadCSV() {
  if (!fs.existsSync(CSV_PATH)) throw new Error(`CSV not found: ${CSV_PATH}`);
  const lines   = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(l => {
    const v = parseCSVLine(l);
    const o = {};
    headers.forEach((h, i) => o[h] = v[i] ?? '');
    return o;
  });
}

// ─── Build trade result from CSV row ─────────────────────────────────────────
function buildTrade(row) {
  const entryPrice = parseFloat2(row.entry_price);
  const exitPrice  = parseFloat2(row.exit_price);
  const stopPrice  = parseFloat2(row.stop_price);

  if (entryPrice == null || exitPrice == null || stopPrice == null) return null;

  const actualRisk = entryPrice - stopPrice;
  if (actualRisk <= 0.0001) return null;

  const positionSize    = RISK_PER_TRADE / actualRisk;
  const capitalDeployed = +(entryPrice * positionSize).toFixed(2);
  const pnl             = +(positionSize * (exitPrice - entryPrice)).toFixed(2);
  const rr              = +(pnl / RISK_PER_TRADE).toFixed(3);

  // Map exit_reason + flags to outcome label
  let outcome;
  if (bool(row.was_huge_win_3x))           outcome = '3x WIN';
  else if (bool(row.was_big_win_2x))       outcome = '2x WIN';
  else if (bool(row.was_win))              outcome = 'WIN';
  else if (row.exit_reason === 'stop_loss' || row.exit_reason === 'stop_loss_last_day') outcome = 'SL';
  else if (bool(row.was_loss))             outcome = 'LOSS';
  else                                     outcome = 'OPEN';

  return {
    tradeId:      row.trade_id,
    ticker:       row.ticker,
    signalDate:   row.signal_date,
    entryDate:    row.entry_date,
    exitDate:     row.exit_date,
    year:         parseInt2(row.signal_year),
    rubricScore:  parseFloat2(row.rubric_score),
    scoreBand:    row.score_band,
    entryPrice,
    exitPrice,
    stopPrice,
    pnl,
    rr,
    positionSize: +positionSize.toFixed(4),
    capitalDeployed,
    actualRisk:   +actualRisk.toFixed(4),
    realizedReturnPct: parseFloat2(row.realized_return_pct),
    holdDays:     parseInt2(row.hold_days),
    exitReason:   row.exit_reason,
    outcome,
    stopHit:      bool(row.stop_hit),
    wasHugeWin3x: bool(row.was_huge_win_3x),
    wasBigWin2x:  bool(row.was_big_win_2x),
    wasWin:       bool(row.was_win),
    wasLoss:      bool(row.was_loss),
    hit2x:        bool(row.hit_2x),
    hit3x:        bool(row.hit_3x),
    hit5x:        bool(row.hit_5x),
    daysTo2x:     parseFloat2(row.days_to_2x),
    daysTo3x:     parseFloat2(row.days_to_3x),
    daysTo5x:     parseFloat2(row.days_to_5x),
    mfePct:       parseFloat2(row.mfe_pct),
    maePct:       parseFloat2(row.mae_pct),
    fwdReturn5d:  parseFloat2(row.fwd_return_5d),
    fwdReturn10d: parseFloat2(row.fwd_return_10d),
    fwdReturn21d: parseFloat2(row.fwd_return_21d),
    fwdReturn42d: parseFloat2(row.fwd_return_42d),
    fwdReturn63d: parseFloat2(row.fwd_return_63d),
    fwdReturn90d: parseFloat2(row.fwd_return_90d),
    litScore:     parseFloat2(row.r_lit_score),
    anomalyScore: parseFloat2(row.r_anomaly_score),
    volZScore:    parseFloat2(row['Vol Z-Score (σ)']),
    callSharePct: parseFloat2(row['Call Share %']),
    otmSharePct:  parseFloat2(row['OTM Share %']),
    stockPrice:   parseFloat2(row['Stock Price ($)']),
    impliedVol:   parseFloat2(row.r_implied_volatility),
    pathEfficiency: parseFloat2(row.path_efficiency),
    maxDrawdown90d: parseFloat2(row.max_drawdown_90d),
  };
}

// ─── Aggregate stats ──────────────────────────────────────────────────────────
function aggregateStats(trades) {
  const wins    = trades.filter(t => ['WIN','2x WIN','3x WIN'].includes(t.outcome));
  const losses  = trades.filter(t => t.outcome === 'SL' || t.outcome === 'LOSS');
  const slOnly  = trades.filter(t => t.outcome === 'SL');
  const win3x   = trades.filter(t => t.outcome === '3x WIN');
  const win2x   = trades.filter(t => t.outcome === '2x WIN');
  const hit2x   = trades.filter(t => t.hit2x);
  const hit3x   = trades.filter(t => t.hit3x);
  const hit5x   = trades.filter(t => t.hit5x);

  const totalPnl   = trades.reduce((s, t) => s + t.pnl, 0);
  const avgRR      = trades.length ? trades.reduce((s, t) => s + t.rr, 0) / trades.length : 0;
  const avgDays    = trades.length ? trades.reduce((s, t) => s + (t.holdDays || 0), 0) / trades.length : 0;
  const avgMFE     = trades.filter(t => t.mfePct != null).reduce((s, t) => s + t.mfePct, 0) / Math.max(1, trades.filter(t => t.mfePct != null).length);
  const avgMAE     = trades.filter(t => t.maePct != null).reduce((s, t) => s + t.maePct, 0) / Math.max(1, trades.filter(t => t.maePct != null).length);

  const grossProfit  = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss    = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 999 : 0;

  // Avg forward returns
  const fwdAvg = (key) => {
    const vals = trades.map(t => t[key]).filter(v => v != null);
    return vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length * 100).toFixed(2) : null;
  };

  return {
    count:           trades.length,
    winCount:        wins.length,
    lossCount:       losses.length,
    slCount:         slOnly.length,
    win3xCount:      win3x.length,
    win2xCount:      win2x.length,
    hit2xCount:      hit2x.length,
    hit3xCount:      hit3x.length,
    hit5xCount:      hit5x.length,
    winRate:         trades.length ? +(100 * wins.length / trades.length).toFixed(1) : 0,
    hit2xRate:       trades.length ? +(100 * hit2x.length / trades.length).toFixed(1) : 0,
    hit3xRate:       trades.length ? +(100 * hit3x.length / trades.length).toFixed(1) : 0,
    hit5xRate:       trades.length ? +(100 * hit5x.length / trades.length).toFixed(1) : 0,
    totalPnl:        +totalPnl.toFixed(2),
    avgRR:           +avgRR.toFixed(3),
    avgDurationDays: +avgDays.toFixed(1),
    avgMFEPct:       +avgMFE.toFixed(3),
    avgMAEPct:       +avgMAE.toFixed(3),
    bestTrade:       trades.length ? Math.max(...trades.map(t => t.pnl)) : 0,
    worstTrade:      trades.length ? Math.min(...trades.map(t => t.pnl)) : 0,
    profitFactor,
    fwdAvg5d:   fwdAvg('fwdReturn5d'),
    fwdAvg10d:  fwdAvg('fwdReturn10d'),
    fwdAvg21d:  fwdAvg('fwdReturn21d'),
    fwdAvg42d:  fwdAvg('fwdReturn42d'),
    fwdAvg63d:  fwdAvg('fwdReturn63d'),
    fwdAvg90d:  fwdAvg('fwdReturn90d'),
  };
}

// ─── Main runner ──────────────────────────────────────────────────────────────
function runBacktest(options = {}) {
  const { yearFilter = 'ALL', topN = TOP_N_TICKERS } = options;

  const rawRows = loadCSV();

  // Determine first N unique tickers (by appearance order)
  const seenTickers = [];
  for (const row of rawRows) {
    if (!seenTickers.includes(row.ticker)) seenTickers.push(row.ticker);
    if (seenTickers.length >= topN) break;
  }

  // Filter to those tickers
  let rows = rawRows.filter(r => seenTickers.includes(r.ticker));

  // Year filter
  if (yearFilter !== 'ALL') rows = rows.filter(r => r.signal_year === String(yearFilter));

  // Build trades
  const trades = rows.map(buildTrade).filter(Boolean);

  // Per-year breakdown
  const byYear = {};
  for (const year of [2022, 2023, 2024, 2025]) {
    const yt = trades.filter(t => t.year === year);
    byYear[year] = { trades: yt, stats: aggregateStats(yt) };
  }

  // Per-ticker breakdown
  const byTicker = {};
  for (const ticker of seenTickers) {
    const tt = trades.filter(t => t.ticker === ticker);
    byTicker[ticker] = { trades: tt, stats: aggregateStats(tt) };
  }

  const results = {
    generatedAt: new Date().toISOString(),
    config: { topNTickers: topN, yearFilter, capital: CAPITAL, riskPerTrade: RISK_PER_TRADE },
    tickerList: seenTickers,
    byYear,
    byTicker,
    overall: { trades, stats: aggregateStats(trades) },
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  return results;
}

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); }
  catch(e) { return null; }
}

function getSignalsSummary() {
  const rawRows = loadCSV();
  const allTickers = [...new Set(rawRows.map(r => r.ticker))];
  const top50 = allTickers.slice(0, 50);
  const filtered = rawRows.filter(r => top50.includes(r.ticker));
  const byYear = {};
  for (const y of [2022, 2023, 2024, 2025]) {
    byYear[y] = filtered.filter(r => r.signal_year === String(y)).length;
  }
  return {
    totalRows: rawRows.length,
    totalTickers: allTickers.length,
    top50Tickers: top50.length,
    top50Trades: filtered.length,
    byYear,
  };
}

module.exports = { runBacktest, loadResults, getSignalsSummary };
