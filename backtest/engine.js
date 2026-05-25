// UOA Backtest Engine
// Simulates trades from UOA signals using Fib 0.50-0.618 retracement entries

const fs = require('fs');
const path = require('path');
const https = require('https');

const CSV_PATHS = {
  2022: 'C:/Users/admin/Downloads/filtered_signals_2022.csv',
  2023: 'C:/Users/admin/Downloads/filtered_signals_2023.csv',
  2024: 'C:/Users/admin/Downloads/filtered_signals_2024.csv',
  2025: 'C:/Users/admin/Downloads/filtered_signals_2025.csv',
};
const CACHE_DIR = path.join(__dirname, 'cache', 'prices');
const RESULTS_FILE = path.join(__dirname, 'results.json');

// ─── Backtest Parameters ───────────────────────────────────────────────────
const CAPITAL          = 400000;
const RISK_PER_TRADE   = 8000;      // 2% of capital
const TP1_RR           = 1.4;       // TP1 reward:risk (tuned for ~53% WR)
const BE_RR            = 1.0;       // SL moves to BE at this RR (adjusted for 2R TP1)
const TRAILING_BUFFER  = 1.5;       // trailing stop = highest - 1.5R
const MAX_HOLD_DAYS    = 180;       // 6 months max hold
const LOOKBACK_DAYS    = 20;        // trading days to look back for swing high/low
const CONSOL_BARS      = 5;         // trading days to observe for consolidation range
const ENTRY_WINDOW     = 45;        // calendar days after signal to wait for breakout
const SL_BUFFER_PCT    = 0.005;     // 0.5% buffer below consolidation low for SL
const RSI_PERIOD       = 14;        // standard 14-period RSI (kept for reference)

// High Priority criteria (from CSV columns) — balanced for more trades + quality
const HP_VOL_ZSCORE    = 5.0;   // original threshold: 5σ
const HP_ANOMALY_SCORE = 0.85;  // original threshold: 0.85
const HP_LIT_SCORE     = 85;    // original threshold: 85
const HP_CALL_PCT      = 70;    // original threshold: 70%
const HP_CORE_SIGNALS  = 1;

// ─── CSV Parsing ──────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
}

function parseCSVs() {
  const signals = [];
  for (const [year, csvPath] of Object.entries(CSV_PATHS)) {
    if (!fs.existsSync(csvPath)) continue;
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const v = parseCSVLine(lines[i]);
      if (v.length < 20) continue;
      signals.push({
        date:           v[0],
        ticker:         v[1],
        stockPrice:     parseFloat(v[2]),
        chainVol:       parseInt(v[3]),
        avgVol20d:      parseInt(v[4]),
        volVsBase:      parseFloat(v[5]),
        volZScore:      parseFloat(v[6]),
        chainNotional:  parseInt(v[7]),
        notionalVsBase: parseFloat(v[8]),
        callSharePct:   parseFloat(v[9]),
        callVsBase:     parseFloat(v[10]),
        otmSharePct:    parseFloat(v[11]),
        otmVsBase:      parseFloat(v[12]),
        sweepPct:       parseFloat(v[13]),
        shortDtePct:    parseFloat(v[14]),
        numSignals:     parseInt(v[15]),
        coreSignals:    parseInt(v[16]),
        smallSignals:   parseInt(v[17]),
        topAnomalyScore:parseFloat(v[18]),
        maxLITScore:    parseInt(v[19]),
        year:           parseInt(year),
      });
    }
  }
  return signals;
}

// ─── Signal Classifiers ───────────────────────────────────────────────────
function isHighPriority(s) {
  return (
    s.volZScore      >= HP_VOL_ZSCORE    &&
    s.topAnomalyScore>= HP_ANOMALY_SCORE &&
    s.maxLITScore    >= HP_LIT_SCORE     &&
    s.callSharePct   >= HP_CALL_PCT      &&
    s.coreSignals    >= HP_CORE_SIGNALS
  );
}
function isBullish(s) { return s.callSharePct >= 70; }
function isBearish(s) { return s.callSharePct < 50;  }

// ─── Date Utilities ───────────────────────────────────────────────────────
function dateToEpoch(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function subtractDays(dateStr, days) { return addDays(dateStr, -days); }
function daysBetween(d1, d2) {
  return Math.abs((new Date(d2) - new Date(d1)) / 86400000);
}

// ─── Yahoo Finance Price Fetcher ──────────────────────────────────────────
function fetchYahooFinance(ticker, startEpoch, endEpoch) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${startEpoch}&period2=${endEpoch}&events=history`;
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

async function getPriceData(ticker, onStatus) {
  const cacheFile = path.join(CACHE_DIR, `${ticker.replace(/[^A-Z0-9]/g,'_')}.json`);

  // Return cached data if it exists
  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.bars && cached.bars.length > 0) return cached.bars;
    } catch(e) {}
  }

  if (onStatus) onStatus(`Fetching ${ticker} from Yahoo Finance...`);

  // Fetch 2021-01-01 to 2025-12-31 to cover all signals + 6-month holds
  const startEpoch = dateToEpoch('2021-01-01');
  const endEpoch   = Math.floor(Date.now() / 1000);

  try {
    const json = await fetchYahooFinance(ticker, startEpoch, endEpoch);
    const result = json?.chart?.result?.[0];
    if (!result || !result.timestamp) {
      if (onStatus) onStatus(`⚠️ No data for ${ticker}`);
      fs.writeFileSync(cacheFile, JSON.stringify({ bars: [] }));
      return [];
    }

    const ts    = result.timestamp;
    const quote = result.indicators.quote[0];
    const bars  = [];

    for (let i = 0; i < ts.length; i++) {
      if (quote.close[i] == null) continue;
      const d = new Date(ts[i] * 1000);
      bars.push({
        date:   d.toISOString().slice(0, 10),
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
    if (onStatus) onStatus(`⚠️ Error fetching ${ticker}: ${e.message}`);
    fs.writeFileSync(cacheFile, JSON.stringify({ bars: [] }));
    return [];
  }
}

// ─── SPY 200MA Regime Map ─────────────────────────────────────────────────
// Returns { date: bool } — true if SPY close > 200-day MA on that date (bull market)
function buildSpyRegimeMap(spyBars) {
  const map = {};
  for (let i = 0; i < spyBars.length; i++) {
    const window = spyBars.slice(Math.max(0, i - 199), i + 1);
    if (window.length >= 50) {
      const ma200 = window.reduce((s, b) => s + b.close, 0) / window.length;
      map[spyBars[i].date] = spyBars[i].close > ma200;
    }
  }
  return map;
}

// Get the regime for a given date — use nearest available SPY date if exact not found
function getSpyRegime(regimeMap, date) {
  if (regimeMap[date] !== undefined) return regimeMap[date];
  // Walk back up to 5 calendar days to find the most recent trading day
  for (let offset = 1; offset <= 5; offset++) {
    const d = addDays(date, -offset);
    if (regimeMap[d] !== undefined) return regimeMap[d];
  }
  return true; // default: allow trade if no SPY data
}

// ─── RSI Calculator (Wilder's smoothing) ─────────────────────────────────
// Returns RSI value (0–100) at bars[idx], or null if insufficient data
function calculateRSI(bars, idx, period = RSI_PERIOD) {
  if (idx < period) return null;
  // Seed: simple average of first `period` changes
  let avgGain = 0, avgLoss = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const change = bars[i].close - bars[i - 1].close;
    if (change > 0) avgGain += change;
    else            avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs  = avgGain / avgLoss;
  return +(100 - (100 / (1 + rs))).toFixed(2);
}

// ─── Find Swing High/Low in lookback window ───────────────────────────────
function findSwingLevels(bars, signalDate, lookbackTradingDays) {
  // Find bars in the lookback window (trading days before signal)
  const signalIdx = bars.findIndex(b => b.date >= signalDate);
  if (signalIdx < 0) return null;

  const start = Math.max(0, signalIdx - lookbackTradingDays);
  const window = bars.slice(start, signalIdx + 1);
  if (window.length < 3) return null;

  let swingHigh = -Infinity;
  let swingLow  =  Infinity;
  for (const b of window) {
    if (b.high  > swingHigh) swingHigh = b.high;
    if (b.low   < swingLow)  swingLow  = b.low;
  }

  const range = swingHigh - swingLow;
  if (range < swingHigh * 0.01) return null; // range too small (<1%), skip

  return { swingHigh, swingLow, range, signalIdx };
}

// ─── Simulate Single Trade ────────────────────────────────────────────────
function simulateTrade(signal, bars) {
  // ── Split-Adjustment Fix ──────────────────────────────────────────────────
  // Yahoo Finance retroactively adjusts ALL historical prices after a split.
  // Our CSV signal prices are the real at-the-time prices (unadjusted).
  // If Yahoo's price on the signal date differs significantly from the CSV price,
  // scale every bar so Fib levels, SL, TP1 and P&L stay in the correct price space.
  let workBars = bars;
  const signalBarRaw = bars.find(b => b.date >= signal.date);
  if (signalBarRaw && signal.stockPrice > 0 && signalBarRaw.close > 0) {
    const scaleRatio = signal.stockPrice / signalBarRaw.close;
    if (scaleRatio < 0.8 || scaleRatio > 1.25) {
      // Significant mismatch → rescale all bars to match CSV price space
      workBars = bars.map(b => ({
        date:   b.date,
        open:   +(b.open   * scaleRatio).toFixed(6),
        high:   +(b.high   * scaleRatio).toFixed(6),
        low:    +(b.low    * scaleRatio).toFixed(6),
        close:  +(b.close  * scaleRatio).toFixed(6),
        volume: b.volume,
      }));
    }
  }

  const levels = findSwingLevels(workBars, signal.date, LOOKBACK_DAYS);
  if (!levels) return { outcome: 'NO_LEVELS', pnl: 0, signal };

  const { swingHigh, swingLow, range, signalIdx } = levels;

  // Fibonacci entry zone — enter at 50% retracement, 61.8% as gap-fill floor
  const fib50  = swingHigh - 0.500 * range;
  const fib618 = swingHigh - 0.618 * range;

  // SL = swing low minus buffer
  const slPrice = swingLow * (1 - SL_BUFFER_PCT);

  if (fib50 <= slPrice) return { outcome: 'INVALID_LEVELS', pnl: 0, signal };

  // ── Dual MA Trend Filter (20MA + 50MA at signal date) ────────────────────
  {
    const signalClose = workBars[signalIdx].close;
    const ma20Window  = workBars.slice(Math.max(0, signalIdx - 19), signalIdx + 1);
    const ma50Window  = workBars.slice(Math.max(0, signalIdx - 49), signalIdx + 1);
    const ma20 = ma20Window.length >= 5  ? ma20Window.reduce((s, b) => s + b.close, 0) / ma20Window.length : null;
    const ma50 = ma50Window.length >= 10 ? ma50Window.reduce((s, b) => s + b.close, 0) / ma50Window.length : null;
    if ((ma20 !== null && signalClose < ma20) || (ma50 !== null && signalClose < ma50)) {
      return { outcome: 'NO_ENTRY', pnl: 0, signal,
        fibLevels: { fib50: +fib50.toFixed(4), fib618: +fib618.toFixed(4), slPrice: +slPrice.toFixed(4) } };
    }
  }

  // Scan forward from signal date up to ENTRY_WINDOW days for entry trigger
  const entryWindowEnd = addDays(signal.date, ENTRY_WINDOW);
  let entryTriggered = false;
  let entryDate = null;
  let actualEntry = fib50;

  for (let i = signalIdx; i < workBars.length; i++) {
    const bar = workBars[i];
    if (bar.date > entryWindowEnd) break;
    if (bar.low <= fib50) {
      entryTriggered = true;
      entryDate = bar.date;
      if (bar.open < fib618) {
        actualEntry = Math.max(bar.open, slPrice + 0.01);
      } else {
        actualEntry = fib50;
      }
      break;
    }
  }

  if (!entryTriggered) {
    return { outcome: 'NO_ENTRY', pnl: 0, signal,
      fibLevels: { fib50: +fib50.toFixed(4), fib618: +fib618.toFixed(4), slPrice: +slPrice.toFixed(4) } };
  }

  const actualRisk     = actualEntry - slPrice;
  if (actualRisk <= 0.001) return { outcome: 'INVALID_LEVELS', pnl: 0, signal };

  const positionSize    = RISK_PER_TRADE / actualRisk;
  const capitalDeployed = +(actualEntry * positionSize).toFixed(2);
  const actualTP1       = actualEntry + TP1_RR * actualRisk;
  const actualBE        = actualEntry + BE_RR  * actualRisk;

  // Now simulate the trade day by day
  let sl             = slPrice;
  let beTriggered    = false;
  let tp1Hit         = false;
  let tp1HalfPnl     = 0;
  let highestSinceTp1 = actualTP1;
  let trailingSl     = actualEntry; // after TP1 hit, trail from entry
  let outcome        = 'OPEN';
  let exitDate       = null;
  let exitPrice      = actualEntry;

  const entryIdx = workBars.findIndex(b => b.date >= entryDate);
  const maxIdx   = Math.min(workBars.length - 1, entryIdx + MAX_HOLD_DAYS);

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const bar = workBars[i];
    const daysIn = daysBetween(entryDate, bar.date);
    if (daysIn > MAX_HOLD_DAYS) break;

    if (!tp1Hit) {
      // Check SL first
      if (bar.low <= sl) {
        outcome   = beTriggered ? 'BE' : 'SL';
        exitDate  = bar.date;
        exitPrice = sl;
        break;
      }
      // Check BE trigger
      if (!beTriggered && bar.high >= actualBE) {
        beTriggered = true;
        sl = actualEntry; // move SL to breakeven
      }
      // Check TP1
      if (bar.high >= actualTP1) {
        tp1Hit      = true;
        tp1HalfPnl  = 0.5 * positionSize * (actualTP1 - actualEntry);
        highestSinceTp1 = actualTP1;
        trailingSl  = actualEntry;
      }
    } else {
      // TP1 was hit – track trailing stop on remaining 50%
      if (bar.high > highestSinceTp1) {
        highestSinceTp1 = bar.high;
        trailingSl = highestSinceTp1 - TRAILING_BUFFER * actualRisk;
      }
      if (bar.low <= trailingSl) {
        const tp2ExitPrice = Math.max(trailingSl, bar.low);
        const tp2HalfPnl   = 0.5 * positionSize * (tp2ExitPrice - actualEntry);
        outcome   = 'TP1+TP2';
        exitDate  = bar.date;
        exitPrice = tp2ExitPrice;
        const totalPnl = tp1HalfPnl + tp2HalfPnl;
        const rrAchieved = totalPnl / RISK_PER_TRADE;
        return buildTradeResult(signal, {
          outcome, entryDate, exitDate,
          entryPrice: actualEntry, exitPrice, slPrice,   // original SL (not BE-adjusted)
          tp1Price: actualTP1, fib50, fib618, swingHigh, swingLow,
          pnl: +totalPnl.toFixed(2),
          positionSize: +positionSize.toFixed(2),
          durationDays: Math.round(daysBetween(entryDate, exitDate)),
          rr: +rrAchieved.toFixed(2),
          capitalDeployed,
        });
      }
    }
  }

  // Loop ended without closure
  const lastBar  = workBars[Math.min(maxIdx, workBars.length - 1)];
  exitDate  = exitDate  || lastBar.date;
  exitPrice = exitPrice || lastBar.close;

  let pnl;
  if (outcome === 'BE' || outcome === 'SL') {
    pnl = outcome === 'SL' ? -RISK_PER_TRADE : 0;
  } else if (tp1Hit) {
    // TP1 hit, remaining still open → close at last price
    const tp2ClosePrice = lastBar.close;
    const tp2Pnl = 0.5 * positionSize * (tp2ClosePrice - actualEntry);
    pnl = tp1HalfPnl + tp2Pnl;
    outcome = 'TP1+PARTIAL';
    exitDate  = lastBar.date;
    exitPrice = tp2ClosePrice;
  } else {
    // Still open at 6 months
    pnl = positionSize * (lastBar.close - actualEntry);
    outcome = pnl >= 0 ? 'OPEN_PROFIT' : 'OPEN_LOSS';
    exitDate  = lastBar.date;
    exitPrice = lastBar.close;
  }

  const rrAchieved = pnl / RISK_PER_TRADE;

  return buildTradeResult(signal, {
    outcome, entryDate, exitDate,
    entryPrice: actualEntry, exitPrice, slPrice,          // original SL (not BE-adjusted)
    tp1Price: actualTP1, fib50, fib618, swingHigh, swingLow,
    pnl: +pnl.toFixed(2),
    positionSize: +positionSize.toFixed(2),
    durationDays: Math.round(daysBetween(entryDate, exitDate)),
    rr: +rrAchieved.toFixed(2),
    capitalDeployed: +(actualEntry * positionSize).toFixed(2),
  });
}

function buildTradeResult(signal, trade) {
  return {
    signal: {
      date:      signal.date,
      ticker:    signal.ticker,
      price:     signal.stockPrice,
      year:      signal.year,
      volZScore: signal.volZScore,
      callPct:   signal.callSharePct,
      anomaly:   signal.topAnomalyScore,
      litScore:  signal.maxLITScore,
      direction: isBullish(signal) ? 'BULLISH' : isBearish(signal) ? 'BEARISH' : 'NEUTRAL',
      isHighPriority: isHighPriority(signal),
    },
    ...trade,
  };
}

// ─── Aggregate Stats ──────────────────────────────────────────────────────
function aggregateStats(trades) {
  const counted = trades.filter(t => t.outcome !== 'NO_ENTRY' && t.outcome !== 'NO_LEVELS' && t.outcome !== 'INVALID_LEVELS' && t.outcome !== 'NO_PRICE_DATA');
  const wins    = counted.filter(t => ['TP1+TP2', 'TP1+PARTIAL', 'OPEN_PROFIT'].includes(t.outcome));
  const losses  = counted.filter(t => t.outcome === 'SL');
  const bes     = counted.filter(t => t.outcome === 'BE');
  const opens   = counted.filter(t => t.outcome === 'OPEN_PROFIT' || t.outcome === 'OPEN_LOSS');
  const noEntry = trades.filter(t => t.outcome === 'NO_ENTRY');

  const totalPnl       = counted.reduce((s, t) => s + t.pnl, 0);
  const avgRR          = counted.length ? counted.reduce((s,t) => s + t.rr, 0) / counted.length : 0;
  const avgDuration    = counted.length ? counted.reduce((s,t) => s + t.durationDays, 0) / counted.length : 0;
  const capitalDeployed= counted.reduce((s,t) => s + t.capitalDeployed, 0) / Math.max(counted.length, 1);

  // Profit Factor = Gross Profit / Gross Loss (>1 profitable, >2 excellent)
  const grossProfit = counted.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss   = Math.abs(counted.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 999 : 0;

  return {
    totalSignals:     trades.length,
    tradesExecuted:   counted.length,
    noEntryCount:     noEntry.length,
    winCount:         wins.length,
    lossCount:        losses.length,
    beCount:          bes.length,
    openCount:        opens.length,
    winRate:          counted.length ? +(100 * wins.length / counted.length).toFixed(1) : 0,
    totalPnl:         +totalPnl.toFixed(2),
    avgPnlPerTrade:   counted.length ? +(totalPnl / counted.length).toFixed(2) : 0,
    avgRR:            +avgRR.toFixed(2),
    avgDurationDays:  +avgDuration.toFixed(1),
    avgCapitalDeployed: +capitalDeployed.toFixed(2),
    bestTrade:        counted.length ? Math.max(...counted.map(t => t.pnl)) : 0,
    worstTrade:       counted.length ? Math.min(...counted.map(t => t.pnl)) : 0,
    profitFactor,
  };
}

// ─── Main Backtest Runner ─────────────────────────────────────────────────
async function runBacktest(options = {}, onProgress) {
  const {
    direction  = 'BULLISH', // Always BULLISH — Long Only strategy
    yearFilter = 'ALL',     // 2022, 2023, 2024, 2025, or 'ALL'
    hpOnly     = true,
  } = options;

  const emit = (msg, data = {}) => {
    if (onProgress) onProgress({ msg, ...data });
  };

  emit('🔍 Parsing CSV signal files...');
  let signals = parseCSVs();
  emit(`📊 Loaded ${signals.length} total signals (2022–2025)`);

  // Apply filters — always long/bullish only
  if (hpOnly) signals = signals.filter(isHighPriority);
  signals = signals.filter(isBullish); // Long Only: callSharePct >= 70
  if (yearFilter !== 'ALL') signals = signals.filter(s => s.year === parseInt(yearFilter));

  emit(`✅ ${signals.length} signals match filters (Long Only, HP:${hpOnly}, Year:${yearFilter})`);

  // Get unique tickers
  const uniqueTickers = [...new Set(signals.map(s => s.ticker))];
  emit(`🏦 ${uniqueTickers.length} unique tickers to fetch price data for`);

  // Fetch SPY data for regime filter (cached after first run)
  emit('📡 Fetching SPY data for 200MA regime filter...');
  const spyBars    = await getPriceData('SPY', (msg) => emit(msg));
  const spyRegime  = buildSpyRegimeMap(spyBars);
  const spyDates   = Object.keys(spyRegime);
  emit(`✅ SPY regime map built: ${spyDates.length} trading days`);
  await new Promise(r => setTimeout(r, 300));

  // Fetch price data for all tickers
  const priceCache = {};
  let fetched = 0;
  for (const ticker of uniqueTickers) {
    const wasCached = fs.existsSync(path.join(CACHE_DIR, `${ticker.replace(/[^A-Z0-9]/g,'_')}.json`));
    priceCache[ticker] = await getPriceData(ticker, (msg) => emit(msg));
    fetched++;
    emit(`📈 Price data: ${fetched}/${uniqueTickers.length} tickers`, { progress: Math.round(50 * fetched / uniqueTickers.length) });
    // Rate limit: only delay for live fetches (not cached data)
    if (!wasCached) await new Promise(r => setTimeout(r, 300));
  }

  emit('⚙️ Running trade simulations...');

  const allTrades = [];
  let simCount = 0;

  for (const signal of signals) {
    const bars = priceCache[signal.ticker];
    if (!bars || bars.length === 0) {
      allTrades.push({ outcome: 'NO_PRICE_DATA', pnl: 0, signal: buildTradeResult(signal, { outcome: 'NO_PRICE_DATA', pnl: 0, entryDate: null, exitDate: null, entryPrice: 0, exitPrice: 0, slPrice: 0, tp1Price: 0, fib50: 0, fib618: 0, swingHigh: 0, swingLow: 0, positionSize: 0, durationDays: 0, rr: 0, capitalDeployed: 0 }).signal });
      continue;
    }

    // ── SPY 200MA Regime Filter ───────────────────────────────────────────
    // Skip trade if SPY was in bear market (below 200MA) on the signal date
    if (!getSpyRegime(spyRegime, signal.date)) {
      allTrades.push({ outcome: 'NO_ENTRY', pnl: 0, durationDays: 0, rr: 0, capitalDeployed: 0, signal });
      simCount++;
      continue;
    }

    const trade = simulateTrade(signal, bars);
    allTrades.push(trade);
    simCount++;
    if (simCount % 10 === 0) {
      emit(`⚙️ Simulated ${simCount}/${signals.length} trades...`, { progress: 50 + Math.round(50 * simCount / signals.length) });
    }
  }

  // Group by year
  const byYear = {};
  for (const year of [2022, 2023, 2024, 2025]) {
    const yearTrades = allTrades.filter(t => t.signal && t.signal.year === year);
    byYear[year] = {
      trades: yearTrades,
      stats:  aggregateStats(yearTrades),
    };
  }

  const results = {
    generatedAt: new Date().toISOString(),
    config: { direction, yearFilter, hpOnly, capital: CAPITAL, riskPerTrade: RISK_PER_TRADE },
    byYear,
    overall: {
      trades: allTrades,
      stats:  aggregateStats(allTrades),
    },
  };

  // Save results
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  emit(`🎉 Backtest complete! ${allTrades.length} signals processed`, { progress: 100, done: true });

  return results;
}

function loadResults() {
  if (!fs.existsSync(RESULTS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); }
  catch(e) { return null; }
}

function getSignalsSummary() {
  const signals = parseCSVs();
  const hp     = signals.filter(isHighPriority);
  const bull   = signals.filter(isBullish);
  const hpBull = hp.filter(isBullish);
  const byYear = {};
  for (const y of [2022, 2023, 2024, 2025]) {
    byYear[y] = {
      total: signals.filter(s => s.year === y).length,
      hp:    hp.filter(s => s.year === y).length,
      long:  hpBull.filter(s => s.year === y).length,
    };
  }
  return { total: signals.length, hp: hp.length, long: bull.length, hpBull: hpBull.length, byYear };
}

// ─── TA-Upload CSV Paths (2023–2025 filtered/scored signals) ────────────────
const TA_CSV_PATHS = [
  'C:/Users/admin/Downloads/ta-upload/2023_filteredforwf.csv',
  'C:/Users/admin/Downloads/ta-upload/2024_filteredforwf.csv',
  'C:/Users/admin/Downloads/ta-upload/2025_filteredforwf.csv',
];
const TA_RESULTS_FILE = path.join(__dirname, 'ta_results.json');

// Find column index by partial name match (handles encoding variants of σ etc.)
function findCol(headers, partial) {
  const p = partial.toLowerCase();
  return headers.findIndex(h => h.toLowerCase().includes(p));
}

function parseTA_CSVs(scoreMin = 0) {
  const signals = [];
  for (const csvPath of TA_CSV_PATHS) {
    if (!fs.existsSync(csvPath)) continue;
    const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
    if (lines.length < 2) continue;
    const headers  = parseCSVLine(lines[0]).map(h => h.trim());

    // Column index lookups (robust to header encoding/ordering differences)
    const iT     = findCol(headers, 'ticker');
    const iD     = findCol(headers, 'signal_date');
    const iPx    = findCol(headers, 'Stock Price');
    const iCV    = findCol(headers, 'Chain Vol');
    const iAV    = findCol(headers, '20d Avg');
    const iVB    = findCol(headers, 'Vol vs Base');
    const iZ     = findCol(headers, 'Z-Score');
    const iCN    = findCol(headers, 'Chain Notional');
    const iNB    = findCol(headers, 'Notional vs Base');
    const iCP    = findCol(headers, 'Call Share');
    const iOTM   = findCol(headers, 'OTM Share');
    const iSW    = findCol(headers, 'Sweep %');
    const iSD    = findCol(headers, 'Short DTE');
    const iNS    = findCol(headers, '# Signals');
    const iCS    = findCol(headers, '# Core');
    const iSS    = findCol(headers, '# Small');
    const iAN    = findCol(headers, 'Anomaly Score');
    const iLIT   = findCol(headers, 'LIT Score');
    const iYR    = findCol(headers, 'source_year');
    // 'score' is the last column — find it exactly (not 'z_score' etc.)
    const iScore = headers.findIndex(h => h.trim().toLowerCase() === 'score');
    const scoreIdx = iScore >= 0 ? iScore : headers.length - 1;

    for (let i = 1; i < lines.length; i++) {
      const v = parseCSVLine(lines[i]);
      if (!v[iT] || !v[iD]) continue;
      const score = parseFloat(v[scoreIdx]) || 0;
      if (score < scoreMin) continue;

      const ticker = v[iT].trim();
      const date   = v[iD].trim();
      const yr     = iYR >= 0 ? (parseInt(v[iYR]) || 0) : 0;
      signals.push({
        date,
        ticker,
        stockPrice:      parseFloat(v[iPx])  || 0,
        chainVol:        parseInt(v[iCV])    || 0,
        avgVol20d:       parseInt(v[iAV])    || 0,
        volVsBase:       parseFloat(v[iVB])  || 0,
        volZScore:       parseFloat(v[iZ])   || 0,
        chainNotional:   parseInt(v[iCN])    || 0,
        notionalVsBase:  parseFloat(v[iNB])  || 0,
        callSharePct:    parseFloat(v[iCP])  || 0,
        callVsBase:      0,
        otmSharePct:     parseFloat(v[iOTM]) || 0,
        otmVsBase:       0,
        sweepPct:        parseFloat(v[iSW])  || 0,
        shortDtePct:     parseFloat(v[iSD])  || 0,
        numSignals:      parseInt(v[iNS])    || 0,
        coreSignals:     parseInt(v[iCS])    || 0,
        smallSignals:    parseInt(v[iSS])    || 0,
        topAnomalyScore: parseFloat(v[iAN])  || 0,
        maxLITScore:     parseInt(v[iLIT])   || 0,
        year:            yr || new Date(date + 'T00:00:00Z').getFullYear(),
        score,
      });
    }
  }
  return signals;
}

// ─── UOA Momentum Trade Simulator ────────────────────────────────────────
// UOA signals are momentum breakouts — enter at next day's open, same SL/TP
function simulateUOATrade(signal, bars) {
  // Split-adjustment (same as simulateTrade)
  let workBars = bars;
  const signalBarRaw = bars.find(b => b.date >= signal.date);
  if (signalBarRaw && signal.stockPrice > 0 && signalBarRaw.close > 0) {
    const scaleRatio = signal.stockPrice / signalBarRaw.close;
    if (scaleRatio < 0.8 || scaleRatio > 1.25) {
      workBars = bars.map(b => ({
        date: b.date, open: +(b.open * scaleRatio).toFixed(6),
        high: +(b.high * scaleRatio).toFixed(6), low: +(b.low * scaleRatio).toFixed(6),
        close: +(b.close * scaleRatio).toFixed(6), volume: b.volume,
      }));
    }
  }

  const levels = findSwingLevels(workBars, signal.date, LOOKBACK_DAYS);
  if (!levels) return { outcome: 'NO_LEVELS', pnl: 0, signal };

  const { swingHigh, swingLow, range, signalIdx } = levels;
  const fib50  = swingHigh - 0.500 * range;
  const fib618 = swingHigh - 0.618 * range;
  const slPrice = swingLow * (1 - SL_BUFFER_PCT);

  if (fib50 <= slPrice) return { outcome: 'INVALID_LEVELS', pnl: 0, signal };

  // UOA entry: next trading day open (or signal day bar if no next bar)
  const entryBarIdx = signalIdx + 1 < workBars.length ? signalIdx + 1 : signalIdx;
  const entryBar    = workBars[entryBarIdx];
  const entryDate   = entryBar.date;
  const actualEntry = entryBar.open > 0 ? entryBar.open : entryBar.close;

  // Skip if entry is below SL (stock already crashed)
  if (actualEntry <= slPrice) return { outcome: 'INVALID_LEVELS', pnl: 0, signal };

  const actualRisk  = actualEntry - slPrice;
  if (actualRisk <= 0.001) return { outcome: 'INVALID_LEVELS', pnl: 0, signal };

  const positionSize    = RISK_PER_TRADE / actualRisk;
  const capitalDeployed = +(actualEntry * positionSize).toFixed(2);
  const actualTP1       = actualEntry + TP1_RR * actualRisk;
  const actualBE        = actualEntry + BE_RR  * actualRisk;

  let sl               = slPrice;
  let beTriggered      = false;
  let tp1Hit           = false;
  let tp1HalfPnl       = 0;
  let highestSinceTp1  = actualTP1;
  let trailingSl       = actualEntry;
  let outcome          = 'OPEN';
  let exitDate         = null;
  let exitPrice        = actualEntry;

  const maxIdx = Math.min(workBars.length - 1, entryBarIdx + MAX_HOLD_DAYS);

  for (let i = entryBarIdx + 1; i <= maxIdx; i++) {
    const bar = workBars[i];
    const daysIn = daysBetween(entryDate, bar.date);
    if (daysIn > MAX_HOLD_DAYS) break;

    if (!tp1Hit) {
      if (bar.low <= sl) {
        outcome = beTriggered ? 'BE' : 'SL';
        exitDate = bar.date; exitPrice = sl; break;
      }
      if (!beTriggered && bar.high >= actualBE) {
        beTriggered = true; sl = actualEntry;
      }
      if (bar.high >= actualTP1) {
        tp1Hit = true; tp1HalfPnl = 0.5 * positionSize * (actualTP1 - actualEntry);
        highestSinceTp1 = actualTP1; trailingSl = actualEntry;
      }
    } else {
      if (bar.high > highestSinceTp1) {
        highestSinceTp1 = bar.high;
        trailingSl = highestSinceTp1 - TRAILING_BUFFER * actualRisk;
      }
      if (bar.low <= trailingSl) {
        const tp2ExitPrice = Math.max(trailingSl, bar.low);
        const tp2HalfPnl   = 0.5 * positionSize * (tp2ExitPrice - actualEntry);
        const totalPnl = tp1HalfPnl + tp2HalfPnl;
        return buildTradeResult(signal, {
          outcome: 'TP1+TP2', entryDate, exitDate: bar.date,
          entryPrice: actualEntry, exitPrice: tp2ExitPrice, slPrice,
          tp1Price: actualTP1, fib50, fib618, swingHigh, swingLow,
          pnl: +totalPnl.toFixed(2), positionSize: +positionSize.toFixed(2),
          durationDays: Math.round(daysBetween(entryDate, bar.date)),
          rr: +(totalPnl / RISK_PER_TRADE).toFixed(2), capitalDeployed,
          entryType: 'UOA_OPEN',
        });
      }
    }
  }

  const lastBar = workBars[Math.min(maxIdx, workBars.length - 1)];
  exitDate  = exitDate  || lastBar.date;
  exitPrice = exitPrice || lastBar.close;

  let pnl;
  if (outcome === 'BE' || outcome === 'SL') {
    pnl = outcome === 'SL' ? -RISK_PER_TRADE : 0;
  } else if (tp1Hit) {
    const tp2Pnl = 0.5 * positionSize * (lastBar.close - actualEntry);
    pnl = tp1HalfPnl + tp2Pnl;
    outcome = 'TP1+PARTIAL'; exitDate = lastBar.date; exitPrice = lastBar.close;
  } else {
    pnl = positionSize * (lastBar.close - actualEntry);
    outcome = pnl >= 0 ? 'OPEN_PROFIT' : 'OPEN_LOSS';
    exitDate = lastBar.date; exitPrice = lastBar.close;
  }

  return buildTradeResult(signal, {
    outcome, entryDate, exitDate,
    entryPrice: actualEntry, exitPrice, slPrice,
    tp1Price: actualTP1, fib50, fib618, swingHigh, swingLow,
    pnl: +pnl.toFixed(2), positionSize: +positionSize.toFixed(2),
    durationDays: Math.round(daysBetween(entryDate, exitDate)),
    rr: +(pnl / RISK_PER_TRADE).toFixed(2),
    capitalDeployed: +(actualEntry * positionSize).toFixed(2),
    entryType: 'UOA_OPEN',
  });
}

// ─── TA Backtest Runner ────────────────────────────────────────────────────
async function runTABacktest(options = {}, onProgress) {
  const {
    scoreMin  = 0,   // 0=All, 8=3210-guided, 10=HP, 12=Elite
    yearFilter = 'ALL',
  } = options;

  const emit = (msg, data = {}) => { if (onProgress) onProgress({ msg, ...data }); };

  emit('🔍 Parsing TA-Upload CSV files (2023–2025 scored signals)...');
  let signals = parseTA_CSVs(scoreMin);
  signals = signals.filter(isBullish);                         // Long Only
  if (yearFilter !== 'ALL') signals = signals.filter(s => s.year === parseInt(yearFilter));

  emit(`📊 ${signals.length} signals (scoreMin:${scoreMin}, Year:${yearFilter})`);

  const uniqueTickers = [...new Set(signals.map(s => s.ticker))];
  emit(`🏦 ${uniqueTickers.length} unique tickers`);

  // SPY regime
  emit('📡 Fetching SPY 200MA regime...');
  const spyBars   = await getPriceData('SPY', m => emit(m));
  const spyRegime = buildSpyRegimeMap(spyBars);
  emit(`✅ SPY map ready`);

  // Fetch prices
  const priceCache = {};
  let fetched = 0;
  for (const ticker of uniqueTickers) {
    const wasCached = fs.existsSync(path.join(CACHE_DIR, `${ticker.replace(/[^A-Z0-9]/g,'_')}.json`));
    priceCache[ticker] = await getPriceData(ticker, m => emit(m));
    fetched++;
    emit(`📈 ${fetched}/${uniqueTickers.length} tickers`, { progress: Math.round(50 * fetched / uniqueTickers.length) });
    if (!wasCached) await new Promise(r => setTimeout(r, 300));
  }

  emit('⚙️ Running trade simulations...');
  const allTrades = [];
  let simCount = 0;

  for (const signal of signals) {
    const bars = priceCache[signal.ticker];
    if (!bars || bars.length === 0) {
      allTrades.push({ outcome: 'NO_PRICE_DATA', pnl: 0, durationDays: 0, rr: 0, capitalDeployed: 0,
        signal: { date: signal.date, ticker: signal.ticker, price: signal.stockPrice, year: signal.year,
          volZScore: signal.volZScore, callPct: signal.callSharePct, anomaly: signal.topAnomalyScore,
          litScore: signal.maxLITScore, score: signal.score, direction: 'BULLISH', isHighPriority: isHighPriority(signal) } });
      continue;
    }
    if (!getSpyRegime(spyRegime, signal.date)) {
      allTrades.push({ outcome: 'NO_ENTRY', pnl: 0, durationDays: 0, rr: 0, capitalDeployed: 0,
        signal: { date: signal.date, ticker: signal.ticker, price: signal.stockPrice, year: signal.year,
          volZScore: signal.volZScore, callPct: signal.callSharePct, anomaly: signal.topAnomalyScore,
          litScore: signal.maxLITScore, score: signal.score, direction: 'BULLISH', isHighPriority: isHighPriority(signal) } });
      simCount++; continue;
    }
    const raw = simulateUOATrade(signal, bars);
    // Attach score to signal info
    if (raw.signal) raw.signal.score = signal.score;
    else raw.signal = { ...raw.signal, score: signal.score };
    allTrades.push(raw);
    simCount++;
    if (simCount % 10 === 0) emit(`⚙️ ${simCount}/${signals.length} trades simulated`, { progress: 50 + Math.round(50 * simCount / signals.length) });
  }

  // Group by year
  const byYear = {};
  for (const year of [2023, 2024, 2025]) {
    const yt = allTrades.filter(t => t.signal && t.signal.year === year);
    byYear[year] = { trades: yt, stats: aggregateStats(yt) };
  }

  const results = {
    generatedAt: new Date().toISOString(),
    config: { scoreMin, yearFilter, capital: CAPITAL, riskPerTrade: RISK_PER_TRADE },
    byYear,
    overall: { trades: allTrades, stats: aggregateStats(allTrades) },
  };

  fs.writeFileSync(TA_RESULTS_FILE, JSON.stringify(results, null, 2));
  emit(`🎉 TA Backtest complete! ${allTrades.length} signals processed`, { progress: 100, done: true });
  return results;
}

function loadTAResults() {
  if (!fs.existsSync(TA_RESULTS_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TA_RESULTS_FILE, 'utf8')); } catch(e) { return null; }
}

function getTASignalsSummary() {
  const all   = parseTA_CSVs(0).filter(isBullish);
  const s8    = all.filter(s => s.score >= 8);
  const s10   = all.filter(s => s.score >= 10);
  const s12   = all.filter(s => s.score >= 12);
  const byYear = {};
  for (const y of [2023, 2024, 2025]) {
    byYear[y] = {
      total: all.filter(s => s.year === y).length,
      s8:    s8.filter(s => s.year === y).length,
      s10:   s10.filter(s => s.year === y).length,
    };
  }
  return { total: all.length, s8: s8.length, s10: s10.length, s12: s12.length, byYear };
}

module.exports = { runBacktest, loadResults, getSignalsSummary, parseCSVs, isHighPriority, isBullish, isBearish,
  runTABacktest, loadTAResults, getTASignalsSummary };
