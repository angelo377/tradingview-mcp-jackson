// UOA Backtest Engine — Compounding Capital Edition
// Risk per trade = 1% of running account balance (grows/shrinks with P&L)

const fs = require('fs');
const path = require('path');
const https = require('https');

const CSV_PATHS = {
  2022: 'C:/Users/admin/Downloads/filtered_signals_2022.csv',
  2023: 'C:/Users/admin/Downloads/filtered_signals_2023.csv',
  2024: 'C:/Users/admin/Downloads/filtered_signals_2024.csv',
  2025: 'C:/Users/admin/Downloads/filtered_signals_2025.csv',
};

// Share the same price cache as the fixed-risk backtest (no re-downloading)
const CACHE_DIR    = path.join(__dirname, '..', 'backtest', 'cache', 'prices');
const RESULTS_FILE = path.join(__dirname, 'results.json');

// ─── Backtest Parameters ───────────────────────────────────────────────────
const STARTING_CAPITAL = 400000;
const RISK_PCT         = 0.02;       // 2% of running capital per trade
const TP1_RR           = 1.4;        // same as fixed-risk version
const BE_RR            = 1.0;
const TRAILING_BUFFER  = 1.5;
const MAX_HOLD_DAYS    = 180;
const LOOKBACK_DAYS    = 20;
const CONSOL_BARS      = 5;
const ENTRY_WINDOW     = 45;
const SL_BUFFER_PCT    = 0.005;
const RSI_PERIOD       = 14;

// High Priority criteria
const HP_VOL_ZSCORE    = 5.0;
const HP_ANOMALY_SCORE = 0.85;
const HP_LIT_SCORE     = 85;
const HP_CALL_PCT      = 70;
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
        date:            v[0],
        ticker:          v[1],
        stockPrice:      parseFloat(v[2]),
        chainVol:        parseInt(v[3]),
        avgVol20d:       parseInt(v[4]),
        volVsBase:       parseFloat(v[5]),
        volZScore:       parseFloat(v[6]),
        chainNotional:   parseInt(v[7]),
        notionalVsBase:  parseFloat(v[8]),
        callSharePct:    parseFloat(v[9]),
        callVsBase:      parseFloat(v[10]),
        otmSharePct:     parseFloat(v[11]),
        otmVsBase:       parseFloat(v[12]),
        sweepPct:        parseFloat(v[13]),
        shortDtePct:     parseFloat(v[14]),
        numSignals:      parseInt(v[15]),
        coreSignals:     parseInt(v[16]),
        smallSignals:    parseInt(v[17]),
        topAnomalyScore: parseFloat(v[18]),
        maxLITScore:     parseInt(v[19]),
        year:            parseInt(year),
      });
    }
  }
  return signals;
}

// ─── Signal Classifiers ───────────────────────────────────────────────────
function isHighPriority(s) {
  return (
    s.volZScore       >= HP_VOL_ZSCORE    &&
    s.topAnomalyScore >= HP_ANOMALY_SCORE &&
    s.maxLITScore     >= HP_LIT_SCORE     &&
    s.callSharePct    >= HP_CALL_PCT      &&
    s.coreSignals     >= HP_CORE_SIGNALS
  );
}
function isBullish(s) { return s.callSharePct >= 70; }
function isBearish(s) { return s.callSharePct < 50; }

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

  if (fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached && cached.bars && cached.bars.length > 0) return cached.bars;
    } catch(e) {}
  }

  if (onStatus) onStatus(`Fetching ${ticker} from Yahoo Finance...`);

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

function getSpyRegime(regimeMap, date) {
  if (regimeMap[date] !== undefined) return regimeMap[date];
  for (let offset = 1; offset <= 5; offset++) {
    const d = addDays(date, -offset);
    if (regimeMap[d] !== undefined) return regimeMap[d];
  }
  return true;
}

// ─── Find Swing High/Low ─────────────────────────────────────────────────
function findSwingLevels(bars, signalDate, lookbackTradingDays) {
  const signalIdx = bars.findIndex(b => b.date >= signalDate);
  if (signalIdx < 0) return null;

  const start  = Math.max(0, signalIdx - lookbackTradingDays);
  const window = bars.slice(start, signalIdx + 1);
  if (window.length < 3) return null;

  let swingHigh = -Infinity;
  let swingLow  =  Infinity;
  for (const b of window) {
    if (b.high > swingHigh) swingHigh = b.high;
    if (b.low  < swingLow)  swingLow  = b.low;
  }

  const range = swingHigh - swingLow;
  if (range < swingHigh * 0.01) return null;

  return { swingHigh, swingLow, range, signalIdx };
}

// ─── Simulate Single Trade (riskAmount is dynamic per compounding) ────────
function simulateTrade(signal, bars, riskAmount) {
  // Split-Adjustment Fix
  let workBars = bars;
  const signalBarRaw = bars.find(b => b.date >= signal.date);
  if (signalBarRaw && signal.stockPrice > 0 && signalBarRaw.close > 0) {
    const scaleRatio = signal.stockPrice / signalBarRaw.close;
    if (scaleRatio < 0.8 || scaleRatio > 1.25) {
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
  if (!levels) return { outcome: 'NO_LEVELS', pnl: 0, signal, riskUsed: riskAmount };

  const { swingHigh, swingLow, range, signalIdx } = levels;

  const fib50  = swingHigh - 0.500 * range;
  const fib618 = swingHigh - 0.618 * range;
  const slPrice = swingLow * (1 - SL_BUFFER_PCT);

  if (fib50 <= slPrice) return { outcome: 'INVALID_LEVELS', pnl: 0, signal, riskUsed: riskAmount };

  // Dual MA Trend Filter
  {
    const signalClose = workBars[signalIdx].close;
    const ma20Window  = workBars.slice(Math.max(0, signalIdx - 19), signalIdx + 1);
    const ma50Window  = workBars.slice(Math.max(0, signalIdx - 49), signalIdx + 1);
    const ma20 = ma20Window.length >= 5  ? ma20Window.reduce((s, b) => s + b.close, 0) / ma20Window.length : null;
    const ma50 = ma50Window.length >= 10 ? ma50Window.reduce((s, b) => s + b.close, 0) / ma50Window.length : null;
    if ((ma20 !== null && signalClose < ma20) || (ma50 !== null && signalClose < ma50)) {
      return { outcome: 'NO_ENTRY', pnl: 0, signal, riskUsed: riskAmount,
        fibLevels: { fib50: +fib50.toFixed(4), fib618: +fib618.toFixed(4), slPrice: +slPrice.toFixed(4) } };
    }
  }

  // Entry window scan
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
    return { outcome: 'NO_ENTRY', pnl: 0, signal, riskUsed: riskAmount,
      fibLevels: { fib50: +fib50.toFixed(4), fib618: +fib618.toFixed(4), slPrice: +slPrice.toFixed(4) } };
  }

  const actualRisk = actualEntry - slPrice;
  if (actualRisk <= 0.001) return { outcome: 'INVALID_LEVELS', pnl: 0, signal, riskUsed: riskAmount };

  // ── COMPOUNDING: position size based on dynamic riskAmount ──────────────
  const positionSize    = riskAmount / actualRisk;
  const capitalDeployed = +(actualEntry * positionSize).toFixed(2);
  const actualTP1       = actualEntry + TP1_RR * actualRisk;
  const actualBE        = actualEntry + BE_RR  * actualRisk;

  let sl              = slPrice;
  let beTriggered     = false;
  let tp1Hit          = false;
  let tp1HalfPnl      = 0;
  let highestSinceTp1 = actualTP1;
  let trailingSl      = actualEntry;
  let outcome         = 'OPEN';
  let exitDate        = null;
  let exitPrice       = actualEntry;

  const entryIdx = workBars.findIndex(b => b.date >= entryDate);
  const maxIdx   = Math.min(workBars.length - 1, entryIdx + MAX_HOLD_DAYS);

  for (let i = entryIdx + 1; i <= maxIdx; i++) {
    const bar = workBars[i];
    const daysIn = daysBetween(entryDate, bar.date);
    if (daysIn > MAX_HOLD_DAYS) break;

    if (!tp1Hit) {
      if (bar.low <= sl) {
        outcome   = beTriggered ? 'BE' : 'SL';
        exitDate  = bar.date;
        exitPrice = sl;
        break;
      }
      if (!beTriggered && bar.high >= actualBE) {
        beTriggered = true;
        sl = actualEntry;
      }
      if (bar.high >= actualTP1) {
        tp1Hit      = true;
        tp1HalfPnl  = 0.5 * positionSize * (actualTP1 - actualEntry);
        highestSinceTp1 = actualTP1;
        trailingSl  = actualEntry;
      }
    } else {
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
        const totalPnl   = tp1HalfPnl + tp2HalfPnl;
        const rrAchieved = totalPnl / riskAmount;
        return buildTradeResult(signal, {
          outcome, entryDate, exitDate,
          entryPrice: actualEntry, exitPrice, slPrice,
          tp1Price: actualTP1, fib50, fib618, swingHigh, swingLow,
          pnl: +totalPnl.toFixed(2),
          positionSize: +positionSize.toFixed(2),
          durationDays: Math.round(daysBetween(entryDate, exitDate)),
          rr: +rrAchieved.toFixed(2),
          capitalDeployed,
          riskUsed: +riskAmount.toFixed(2),
        });
      }
    }
  }

  const lastBar  = workBars[Math.min(maxIdx, workBars.length - 1)];
  exitDate  = exitDate  || lastBar.date;
  exitPrice = exitPrice || lastBar.close;

  let pnl;
  if (outcome === 'BE' || outcome === 'SL') {
    pnl = outcome === 'SL' ? -riskAmount : 0;
  } else if (tp1Hit) {
    const tp2ClosePrice = lastBar.close;
    const tp2Pnl = 0.5 * positionSize * (tp2ClosePrice - actualEntry);
    pnl = tp1HalfPnl + tp2Pnl;
    outcome = 'TP1+PARTIAL';
    exitDate  = lastBar.date;
    exitPrice = tp2ClosePrice;
  } else {
    pnl = positionSize * (lastBar.close - actualEntry);
    outcome = pnl >= 0 ? 'OPEN_PROFIT' : 'OPEN_LOSS';
    exitDate  = lastBar.date;
    exitPrice = lastBar.close;
  }

  const rrAchieved = pnl / riskAmount;

  return buildTradeResult(signal, {
    outcome, entryDate, exitDate,
    entryPrice: actualEntry, exitPrice, slPrice,
    tp1Price: actualTP1, fib50, fib618, swingHigh, swingLow,
    pnl: +pnl.toFixed(2),
    positionSize: +positionSize.toFixed(2),
    durationDays: Math.round(daysBetween(entryDate, exitDate)),
    rr: +rrAchieved.toFixed(2),
    capitalDeployed: +(actualEntry * positionSize).toFixed(2),
    riskUsed: +riskAmount.toFixed(2),
  });
}

function buildTradeResult(signal, trade) {
  return {
    signal: {
      date:           signal.date,
      ticker:         signal.ticker,
      price:          signal.stockPrice,
      year:           signal.year,
      volZScore:      signal.volZScore,
      callPct:        signal.callSharePct,
      anomaly:        signal.topAnomalyScore,
      litScore:       signal.maxLITScore,
      direction:      isBullish(signal) ? 'BULLISH' : isBearish(signal) ? 'BEARISH' : 'NEUTRAL',
      isHighPriority: isHighPriority(signal),
    },
    ...trade,
  };
}

// ─── Aggregate Stats (with compounding metrics) ───────────────────────────
function aggregateStats(trades, capitalCurve) {
  const counted = trades.filter(t => t.outcome !== 'NO_ENTRY' && t.outcome !== 'NO_LEVELS' && t.outcome !== 'INVALID_LEVELS' && t.outcome !== 'NO_PRICE_DATA');
  const wins    = counted.filter(t => ['TP1+TP2', 'TP1+PARTIAL', 'OPEN_PROFIT'].includes(t.outcome));
  const losses  = counted.filter(t => t.outcome === 'SL');
  const bes     = counted.filter(t => t.outcome === 'BE');
  const opens   = counted.filter(t => t.outcome === 'OPEN_PROFIT' || t.outcome === 'OPEN_LOSS');
  const noEntry = trades.filter(t => t.outcome === 'NO_ENTRY');

  const totalPnl    = counted.reduce((s, t) => s + t.pnl, 0);
  const avgRR       = counted.length ? counted.reduce((s, t) => s + t.rr, 0) / counted.length : 0;
  const avgDuration = counted.length ? counted.reduce((s, t) => s + t.durationDays, 0) / counted.length : 0;

  const grossProfit  = counted.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss    = Math.abs(counted.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : grossProfit > 0 ? 999 : 0;

  // Max drawdown from capital curve
  let maxDrawdownPct = 0;
  if (capitalCurve && capitalCurve.length > 1) {
    let peak = capitalCurve[0].capital;
    for (const pt of capitalCurve) {
      if (pt.capital > peak) peak = pt.capital;
      const dd = (peak - pt.capital) / peak * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  return {
    totalSignals:    trades.length,
    tradesExecuted:  counted.length,
    noEntryCount:    noEntry.length,
    winCount:        wins.length,
    lossCount:       losses.length,
    beCount:         bes.length,
    openCount:       opens.length,
    winRate:         counted.length ? +(100 * wins.length / counted.length).toFixed(1) : 0,
    totalPnl:        +totalPnl.toFixed(2),
    avgPnlPerTrade:  counted.length ? +(totalPnl / counted.length).toFixed(2) : 0,
    avgRR:           +avgRR.toFixed(2),
    avgDurationDays: +avgDuration.toFixed(1),
    bestTrade:       counted.length ? Math.max(...counted.map(t => t.pnl)) : 0,
    worstTrade:      counted.length ? Math.min(...counted.map(t => t.pnl)) : 0,
    profitFactor,
    maxDrawdownPct:  +maxDrawdownPct.toFixed(2),
  };
}

// ─── Main Backtest Runner ─────────────────────────────────────────────────
async function runBacktest(options = {}, onProgress) {
  const {
    yearFilter = 'ALL',
    hpOnly     = true,
  } = options;

  const emit = (msg, data = {}) => {
    if (onProgress) onProgress({ msg, ...data });
  };

  emit('🔍 Parsing CSV signal files...');
  let signals = parseCSVs();
  emit(`📊 Loaded ${signals.length} total signals (2022–2025)`);

  if (hpOnly) signals = signals.filter(isHighPriority);
  signals = signals.filter(isBullish);
  if (yearFilter !== 'ALL') signals = signals.filter(s => s.year === parseInt(yearFilter));

  // Sort signals by date so compounding runs chronologically
  signals.sort((a, b) => a.date.localeCompare(b.date));

  emit(`✅ ${signals.length} signals match filters (Long Only, HP:${hpOnly}, Year:${yearFilter})`);

  const uniqueTickers = [...new Set(signals.map(s => s.ticker))];
  emit(`🏦 ${uniqueTickers.length} unique tickers to fetch price data for`);

  emit('📡 Fetching SPY data for 200MA regime filter...');
  const spyBars   = await getPriceData('SPY', (msg) => emit(msg));
  const spyRegime = buildSpyRegimeMap(spyBars);
  emit(`✅ SPY regime map built: ${Object.keys(spyRegime).length} trading days`);
  await new Promise(r => setTimeout(r, 300));

  const priceCache = {};
  let fetched = 0;
  for (const ticker of uniqueTickers) {
    const wasCached = fs.existsSync(path.join(CACHE_DIR, `${ticker.replace(/[^A-Z0-9]/g,'_')}.json`));
    priceCache[ticker] = await getPriceData(ticker, (msg) => emit(msg));
    fetched++;
    emit(`📈 Price data: ${fetched}/${uniqueTickers.length} tickers`, { progress: Math.round(50 * fetched / uniqueTickers.length) });
    if (!wasCached) await new Promise(r => setTimeout(r, 300));
  }

  emit('⚙️ Running compounding trade simulations...');

  // ── COMPOUNDING: running capital state ──────────────────────────────────
  let runningCapital = STARTING_CAPITAL;
  const capitalCurve = [{ label: 'Start', capital: STARTING_CAPITAL, tradeNum: 0 }];

  const allTrades = [];
  let simCount    = 0;
  let tradeNum    = 0;

  for (const signal of signals) {
    const bars = priceCache[signal.ticker];
    if (!bars || bars.length === 0) {
      allTrades.push({ outcome: 'NO_PRICE_DATA', pnl: 0, signal: buildTradeResult(signal, { outcome: 'NO_PRICE_DATA', pnl: 0, entryDate: null, exitDate: null, entryPrice: 0, exitPrice: 0, slPrice: 0, tp1Price: 0, fib50: 0, fib618: 0, swingHigh: 0, swingLow: 0, positionSize: 0, durationDays: 0, rr: 0, capitalDeployed: 0, riskUsed: 0 }).signal, riskUsed: 0 });
      continue;
    }

    // SPY Regime Filter
    if (!getSpyRegime(spyRegime, signal.date)) {
      allTrades.push({ outcome: 'NO_ENTRY', pnl: 0, durationDays: 0, rr: 0, capitalDeployed: 0, signal, riskUsed: 0 });
      simCount++;
      continue;
    }

    // ── Dynamic risk = 1% of current running capital ─────────────────────
    const riskAmount = runningCapital * RISK_PCT;

    const trade = simulateTrade(signal, bars, riskAmount);
    allTrades.push(trade);

    // Update compounding capital after each completed trade
    const executedOutcomes = ['TP1+TP2', 'TP1+PARTIAL', 'OPEN_PROFIT', 'OPEN_LOSS', 'SL', 'BE'];
    if (executedOutcomes.includes(trade.outcome)) {
      runningCapital += trade.pnl;
      tradeNum++;
      trade.capitalAfter = +runningCapital.toFixed(2);
      capitalCurve.push({
        label:    `T${tradeNum} ${signal.ticker} (${signal.date.slice(0,7)})`,
        capital:  +runningCapital.toFixed(2),
        tradeNum,
        pnl:      trade.pnl,
        outcome:  trade.outcome,
        ticker:   signal.ticker,
        date:     trade.entryDate || signal.date,
      });
    }

    simCount++;
    if (simCount % 10 === 0) {
      emit(`⚙️ Simulated ${simCount}/${signals.length} trades... Capital: $${Math.round(runningCapital).toLocaleString()}`, { progress: 50 + Math.round(50 * simCount / signals.length) });
    }
  }

  const finalCapital  = runningCapital;
  const totalReturn   = +((finalCapital - STARTING_CAPITAL) / STARTING_CAPITAL * 100).toFixed(2);

  // Group by year (with per-year capital curves)
  const byYear = {};
  for (const year of [2022, 2023, 2024, 2025]) {
    const yearTrades = allTrades.filter(t => t.signal && t.signal.year === year);
    const yearCurve  = capitalCurve.filter(pt => pt.date && pt.date.startsWith(String(year)));
    byYear[year] = {
      trades: yearTrades,
      stats:  aggregateStats(yearTrades, yearCurve),
    };
  }

  const overallStats = aggregateStats(allTrades, capitalCurve);

  const results = {
    generatedAt:    new Date().toISOString(),
    config: {
      yearFilter, hpOnly,
      startingCapital: STARTING_CAPITAL,
      riskPct: RISK_PCT * 100,
    },
    capitalCurve,
    finalCapital:   +finalCapital.toFixed(2),
    totalReturnPct: totalReturn,
    byYear,
    overall: {
      trades: allTrades,
      stats:  { ...overallStats, finalCapital: +finalCapital.toFixed(2), totalReturnPct: totalReturn },
    },
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  emit(`🎉 Backtest complete! Final Capital: $${Math.round(finalCapital).toLocaleString()} (${totalReturn > 0 ? '+' : ''}${totalReturn}%)`, { progress: 100, done: true });

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

module.exports = { runBacktest, loadResults, getSignalsSummary, parseCSVs, isHighPriority, isBullish, isBearish };
