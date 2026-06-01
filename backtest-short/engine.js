// Short Backtest Engine — Port 3214
// Entry: Fib 0.50–0.628 retracement (HH → HL)
// Confirmation: SOW Red Dot + Auto Metrics SELL
// SL: 0.2% above HH  |  TP1: 1.4R  |  BE at TP1  |  Trail after TP1

'use strict';
const fs   = require('fs');
const path = require('path');
const https = require('https');

// ─── Constants ────────────────────────────────────────────────────────────────
const CAPITAL        = 400_000;
const RISK_AMT       = 8_000;      // 2% of capital
const TP1_R          = 1.4;        // take profit 1 at 1.4R
const SL_BUFFER_PCT  = 0.002;      // 0.2% above HH for stop loss
const FIB_ENTRY      = 0.500;      // short entry at 0.50 retracement
const FIB_ZONE_TOP   = 0.628;      // zone top — 0.628 retracement
const MAX_WAIT_BARS  = 20;         // bars to wait for price to enter fib zone
const MAX_HOLD_BARS  = 130;        // ~6 months max trade duration
const TRAIL_PCT      = 0.005;      // 0.5% trail above lowest low after TP1

const CACHE_DIR    = path.join(__dirname, 'cache', 'prices');
const RESULTS_FILE = path.join(__dirname, 'results.json');
const SIGNALS_DIR  = path.join(__dirname, 'signals');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── CSV Parser ───────────────────────────────────────────────────────────────
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

// ─── Load signals from CSV ────────────────────────────────────────────────────
// CSV format: date,ticker,year,structure,sosSow,amSignal,hhPrice,hlPrice,notes
function loadSignals(structureFilter = null, yearFilter = 'ALL') {
  const signals = [];
  if (!fs.existsSync(SIGNALS_DIR)) return signals;

  const files = fs.readdirSync(SIGNALS_DIR).filter(f => f.endsWith('.csv'));
  for (const file of files) {
    const lines = fs.readFileSync(path.join(SIGNALS_DIR, file), 'utf-8')
                    .trim().split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());

    for (let i = 1; i < lines.length; i++) {
      const v   = parseCSVLine(lines[i]);
      const row = {};
      headers.forEach((h, idx) => { row[h] = v[idx] || ''; });

      const hhPrice = parseFloat(row.hhprice || row.hh_price || '0');
      const hlPrice = parseFloat(row.hlprice || row.hl_price || '0');
      if (!row.date || !row.ticker || isNaN(hhPrice) || isNaN(hlPrice)) continue;
      if (hhPrice <= hlPrice) continue;  // invalid fib range

      const structure = (row.structure || '').toUpperCase();
      const year      = row.year || row.date.slice(0, 4);

      if (structureFilter && structure !== structureFilter) continue;
      if (yearFilter !== 'ALL' && year !== yearFilter) continue;

      signals.push({
        date:      row.date,
        ticker:    row.ticker.toUpperCase(),
        year:      String(year),
        structure,
        sosSow:    (row.sossow || row.sos_sow || '').toUpperCase(),
        amSignal:  (row.amsignal || row.am_signal || '').toUpperCase(),
        hhPrice,
        hlPrice,
        notes:     row.notes || '',
      });
    }
  }

  // Sort by date ascending
  return signals.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Signal summary ───────────────────────────────────────────────────────────
function getSignalsSummary() {
  const all     = loadSignals();
  const bull    = all.filter(s => s.structure === 'BULLISH');
  const bear    = all.filter(s => s.structure === 'BEARISH');
  const sowCount  = all.filter(s => s.sosSow === 'SOW').length;
  const sellCount = all.filter(s => s.amSignal === 'SELL').length;
  const byYear  = {};
  all.forEach(s => { byYear[s.year] = (byYear[s.year] || 0) + 1; });
  return { total: all.length, bullish: bull.length, bearish: bear.length, sowCount, sellCount, byYear };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateToEpoch(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
}

// ─── Yahoo Finance price fetcher ──────────────────────────────────────────────
function fetchYahooFinance(ticker, startEpoch, endEpoch) {
  return new Promise((resolve, reject) => {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${startEpoch}&period2=${endEpoch}&events=history`;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'Accept': 'application/json',
      },
      timeout: 15000,
    };
    const req = https.get(url, opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, opts, (r2) => {
          let d = '';
          r2.on('data', c => d += c);
          r2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getPriceBars(ticker, onStatus) {
  const cacheFile = path.join(CACHE_DIR, `${ticker.replace(/[^A-Z0-9]/g, '_')}.json`);

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached?.bars?.length > 0) return cached.bars;
    } catch (_) {}
  }

  if (onStatus) onStatus(`Fetching ${ticker} from Yahoo Finance…`);

  const startEpoch = dateToEpoch('2021-01-01');
  const endEpoch   = Math.floor(Date.now() / 1000);

  try {
    const json   = await fetchYahooFinance(ticker, startEpoch, endEpoch);
    const result = json?.chart?.result?.[0];
    if (!result?.timestamp) {
      fs.writeFileSync(cacheFile, JSON.stringify({ bars: [] }));
      return [];
    }
    const ts    = result.timestamp;
    const quote = result.indicators.quote[0];
    const bars  = [];
    for (let i = 0; i < ts.length; i++) {
      if (quote.close[i] == null) continue;
      bars.push({
        date:   new Date(ts[i] * 1000).toISOString().slice(0, 10),
        open:   quote.open[i],
        high:   quote.high[i],
        low:    quote.low[i],
        close:  quote.close[i],
        volume: quote.volume[i],
      });
    }
    fs.writeFileSync(cacheFile, JSON.stringify({ bars }, null, 0));
    return bars;
  } catch (e) {
    if (onStatus) onStatus(`⚠ Error fetching ${ticker}: ${e.message}`);
    fs.writeFileSync(cacheFile, JSON.stringify({ bars: [] }));
    return [];
  }
}

// ─── Short trade simulator ────────────────────────────────────────────────────
// Fib zone: measured from HL (bottom) to HH (top)
//   0.50 level = HL + 0.50 * (HH - HL)  ← short entry
//   0.618 level = HL + 0.618 * (HH - HL) ← zone top / invalidation
//
// Entry: price bounces UP into fib zone on a daily bar
// SL   : 0.2% ABOVE HH
// TP1  : 1.4R BELOW entry  → move SL to entry (BE)
// Trail: after TP1, trail SL 0.5% above running lowest low
function simulateShortTrade(signal, bars) {
  const { hhPrice, hlPrice, date: signalDate, ticker } = signal;

  // ── Fib levels ──────────────────────────────────────────────────────────────
  const range   = hhPrice - hlPrice;
  const fib50   = hlPrice + FIB_ENTRY    * range;   // 0.50 — entry level
  const fib618  = hlPrice + FIB_ZONE_TOP * range;   // 0.628 — zone top
  const slPrice = hhPrice * (1 + SL_BUFFER_PCT);    // stop above HH

  // ── Find signal bar index ────────────────────────────────────────────────────
  const signalIdx = bars.findIndex(b => b.date >= signalDate);
  if (signalIdx < 0 || signalIdx >= bars.length - 1) {
    return trade(signal, null, null, 'NO_ENTRY', fib50, fib618, slPrice, 0, 0, 0, 0);
  }

  // ── Scan for fib zone entry (price bounces up into 0.50–0.628 zone) ────────
  // Entry: bar.high touches fib50 AND bar.close stays at or below fib618
  // Invalidation: bar.high >= slPrice (price blew through HH)
  let entryBar = null, entryIdx = -1;

  for (let i = signalIdx + 1; i < Math.min(signalIdx + MAX_WAIT_BARS + 1, bars.length); i++) {
    const b = bars[i];
    if (b.high >= slPrice)                     { break; } // HH broken — setup invalid
    if (b.high >= fib50 && b.close <= fib618)  { entryBar = b; entryIdx = i; break; }
  }

  if (!entryBar) {
    return trade(signal, null, null, 'NO_ENTRY', fib50, fib618, slPrice, 0, 0, 0, 0);
  }

  // ── Position sizing ──────────────────────────────────────────────────────────
  const entry       = fib50;
  const riskPerShare = slPrice - entry;
  if (riskPerShare <= 0) {
    return trade(signal, entryBar, entryBar, 'NO_ENTRY', fib50, fib618, slPrice, 0, 0, 0, 0);
  }
  const shares   = Math.floor(RISK_AMT / riskPerShare);
  const tp1Price = entry - TP1_R * riskPerShare;   // 1.4R below entry

  // ── Simulate trade bar by bar ────────────────────────────────────────────────
  let sl       = slPrice;
  let tp1Hit   = false;
  let trailLow = Infinity;

  for (let i = entryIdx + 1; i < bars.length; i++) {
    const b        = bars[i];
    const barsHeld = i - entryIdx;

    // SL hit (for SHORT: price goes UP above stop)
    if (b.high >= sl) {
      const exitP  = sl;
      const pnl    = (entry - exitP) * shares;
      const rr     = (entry - exitP) / riskPerShare;
      return trade(signal, entryBar, b, tp1Hit ? 'BE' : 'LOSS_SL',
                   fib50, fib618, slPrice, entry, exitP, pnl, rr, shares, barsHeld);
    }

    // TP1 hit (for SHORT: price goes DOWN to tp1Price)
    if (!tp1Hit && b.low <= tp1Price) {
      tp1Hit   = true;
      sl       = entry;       // move stop to breakeven
      trailLow = b.low;
    }

    // Trailing stop after TP1
    if (tp1Hit) {
      if (b.low < trailLow) trailLow = b.low;
      const newSl = trailLow * (1 + TRAIL_PCT);
      if (newSl < sl) sl = newSl;
    }

    // Max hold
    if (barsHeld >= MAX_HOLD_BARS) {
      const exitP = b.close;
      const pnl   = (entry - exitP) * shares;
      const rr    = (entry - exitP) / riskPerShare;
      return trade(signal, entryBar, b, 'TIMEOUT',
                   fib50, fib618, slPrice, entry, exitP, pnl, rr, shares, barsHeld);
    }
  }

  // End of data — mark open
  const last  = bars[bars.length - 1];
  const exitP = last.close;
  const pnl   = (entry - exitP) * shares;
  const rr    = (entry - exitP) / riskPerShare;
  return trade(signal, entryBar, last, 'OPEN',
               fib50, fib618, slPrice, entry, exitP, pnl, rr, shares, bars.length - entryIdx);
}

// ─── Trade result builder ─────────────────────────────────────────────────────
function trade(signal, entryBar, exitBar, outcome, fib50, fib618, slPrice,
               entry, exitP, pnl, rr, shares = 0, barsHeld = 0) {
  return {
    ticker:    signal.ticker,
    year:      signal.year,
    structure: signal.structure,
    signalDate: signal.date,
    sosSow:    signal.sosSow,
    amSignal:  signal.amSignal,
    hhPrice:   signal.hhPrice,
    hlPrice:   signal.hlPrice,
    notes:     signal.notes,
    outcome,
    entry:     entry   ? +entry.toFixed(4)   : null,
    exit:      exitP   ? +exitP.toFixed(4)   : null,
    slPrice:   slPrice ? +slPrice.toFixed(4) : null,
    fib50:     fib50   ? +fib50.toFixed(4)   : null,
    fib618:    fib618  ? +fib618.toFixed(4)  : null,
    shares,
    pnl:       +pnl.toFixed(2),
    rr:        +rr.toFixed(3),
    barsHeld,
    entryDate: entryBar?.date || signal.date,
    exitDate:  exitBar?.date  || signal.date,
  };
}

// ─── Compute summary stats ────────────────────────────────────────────────────
function computeSummary(trades) {
  const exec    = trades.filter(t => t.outcome !== 'NO_ENTRY');
  const wins    = exec.filter(t => t.pnl > 0);
  const losses  = exec.filter(t => t.outcome === 'LOSS_SL');
  const be      = exec.filter(t => t.outcome === 'BE');
  const noEntry = trades.filter(t => t.outcome === 'NO_ENTRY');
  const totalPnl = exec.reduce((s, t) => s + t.pnl, 0);
  const winRate  = exec.length ? (wins.length / exec.length) * 100 : 0;
  const avgRR    = exec.length ? exec.reduce((s, t) => s + t.rr, 0) / exec.length : 0;
  const avgDur   = exec.length ? exec.reduce((s, t) => s + t.barsHeld, 0) / exec.length : 0;

  return {
    total:      trades.length,
    executed:   exec.length,
    wins:       wins.length,
    losses:     losses.length,
    be:         be.length,
    noEntry:    noEntry.length,
    totalPnl:   +totalPnl.toFixed(2),
    winRate:    +winRate.toFixed(1),
    avgRR:      +avgRR.toFixed(3),
    avgDuration:+avgDur.toFixed(1),
    bestTrade:  exec.length ? +Math.max(...exec.map(t => t.pnl)).toFixed(2) : 0,
    worstTrade: exec.length ? +Math.min(...exec.map(t => t.pnl)).toFixed(2) : 0,
  };
}

// ─── Run backtest ─────────────────────────────────────────────────────────────
async function runBacktest(params = {}, onProgress = () => {}) {
  const { structureFilter = null, yearFilter = 'ALL' } = params;
  const signals = loadSignals(structureFilter, yearFilter);

  if (!signals.length) {
    const results = { trades: [], summary: computeSummary([]), params, generatedAt: new Date().toISOString() };
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
    return results;
  }

  onProgress({ msg: `Processing ${signals.length} signals…`, total: signals.length, done: 0 });

  const trades = [];
  const seen   = {};  // cache-skip dedup per ticker

  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    onProgress({ msg: `${sig.ticker} — ${sig.structure} (${i + 1}/${signals.length})`, total: signals.length, done: i });

    try {
      const bars = await getPriceBars(sig.ticker, msg => onProgress({ msg, total: signals.length, done: i }));
      if (!bars.length) {
        trades.push(trade(sig, null, null, 'NO_ENTRY', 0, 0, 0, 0, 0, 0, 0));
        continue;
      }
      trades.push(simulateShortTrade(sig, bars));
    } catch (err) {
      trades.push(trade(sig, null, null, 'NO_ENTRY', 0, 0, 0, 0, 0, 0, 0));
    }
  }

  const summary = computeSummary(trades);
  const results = { trades, summary, params, generatedAt: new Date().toISOString() };
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  return results;
}

// ─── Load results ─────────────────────────────────────────────────────────────
function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8')); } catch (_) { return null; }
}

module.exports = { runBacktest, loadResults, getSignalsSummary, loadSignals };
