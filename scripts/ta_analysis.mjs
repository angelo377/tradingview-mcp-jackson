/**
 * ta_analysis.mjs
 * Technical analysis for UOA tickers from the uploaded CSVs.
 * Switches each ticker on TradingView, takes a screenshot, reads
 * CF Cycle + price data, then compiles a full markdown report.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluate, getClient } from '../src/connection.js';
import { healthCheck } from '../src/core/health.js';
import { getOhlcv } from '../src/core/data.js';
import { setSymbol as chartSetSymbol, setTimeframe as chartSetTimeframe } from '../src/core/chart.js';

process.on('unhandledRejection', () => {});

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUT_DIR    = join(__dirname, '..', 'ta_output');
const CHART_DIR  = join(OUT_DIR, 'charts');
mkdirSync(CHART_DIR, { recursive: true });

const SWITCH_MS  = 7000;   // wait after symbol switch

// ── Load CSV data ─────────────────────────────────────────────────────────────
function parseCSV(path) {
  const lines = readFileSync(path, 'utf-8').trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
}

const rows2023 = parseCSV('C:/Users/admin/Downloads/ta-upload/2023_filteredforwf.csv');
const rows2024 = parseCSV('C:/Users/admin/Downloads/ta-upload/2024_filteredforwf.csv');
const rows2025 = parseCSV('C:/Users/admin/Downloads/ta-upload/2025_filteredforwf.csv');
const allRows  = [...rows2025, ...rows2024, ...rows2023];

// Keep most recent signal per ticker
const tickerMap = new Map();
for (const r of allRows) {
  const existing = tickerMap.get(r.ticker);
  if (!existing || new Date(r.signal_date) > new Date(existing.signal_date)) {
    tickerMap.set(r.ticker, r);
  }
}

// Sort: 2025 score≥10 first, then by score desc, then by date desc
const tickers = [...tickerMap.values()].sort((a, b) => {
  const aYear = new Date(a.signal_date).getFullYear();
  const bYear = new Date(b.signal_date).getFullYear();
  if (aYear !== bYear) return bYear - aYear;
  return (+b.score) - (+a.score);
});

console.log(`\n📊 TA Analysis — ${tickers.length} unique tickers\n`);
console.log('Priority order: 2025 (score desc) → 2024 → 2023\n');

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n, d = 2) { return n != null && !isNaN(n) ? Number(n).toFixed(d) : '—'; }
function fmtPct(n) { return n != null && !isNaN(n) ? (Number(n) >= 0 ? '+' : '') + (Number(n)*100).toFixed(1) + '%' : '—'; }

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function setSymbol(sym) {
  await Promise.race([
    chartSetSymbol({ symbol: sym }),
    new Promise(r => setTimeout(r, 8000))
  ]);
}

async function setTimeframe(tf) {
  await Promise.race([
    chartSetTimeframe({ timeframe: tf }),
    new Promise(r => setTimeout(r, 5000))
  ]);
}

async function getCurrentPrice() {
  try {
    const ohlcv = await Promise.race([
      getOhlcv({ count: 3 }),
      new Promise(r => setTimeout(() => r(null), 5000))
    ]);
    if (ohlcv?.bars?.length) {
      const last = ohlcv.bars[ohlcv.bars.length - 1];
      if (last?.close) return last.close;
    }
  } catch (_) {}
  return null;
}

async function takeCDPScreenshot(ticker) {
  try {
    const client = await getClient();
    const result = await client.Page.captureScreenshot({ format: 'jpeg', quality: 75 });
    const path   = join(CHART_DIR, `${ticker}_W.jpg`);
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    return path;
  } catch (e) {
    return null;
  }
}

async function readCycleData() {
  return await Promise.race([
    evaluate(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
          var sources = chart.model().model().dataSources();
          for (var i = 0; i < sources.length; i++) {
            var src = sources[i];
            if (!src.metaInfo) continue;
            var name = (src.metaInfo().description || '').toLowerCase();
            if (!name.includes('cf cycle') && !name.includes('cycle trading')) continue;
            var pc = src._graphics && src._graphics._primitivesCollection;
            if (!pc) continue;

            var lastDclX = -1, lastDclLabel = '';
            var hasWeekly = false;
            var allBoxes = [];

            try {
              var lc = pc.dwglabels.get('labels').get(false);
              if (lc && lc._primitivesDataById) {
                lc._primitivesDataById.forEach(function(v) {
                  var t = (v.t || '');
                  // DCL marker: labels containing 🅓 (U+1F153)
                  if (t.indexOf('🅓') !== -1) {
                    if (v.x > lastDclX) { lastDclX = v.x; lastDclLabel = t.split('\\n').join(' ').trim(); }
                  }
                  // WCL marker: labels containing 🅦 (U+1F166)
                  if (t.indexOf('🅦') !== -1) { hasWeekly = true; }
                });
              }
            } catch(e) {}

            // Read boxes
            try {
              var bc = pc.dwgboxes.get('boxes').get(false);
              if (bc && bc._primitivesDataById) {
                bc._primitivesDataById.forEach(function(v) {
                  allBoxes.push({ x1: v.x1, x2: v.x2, bc: v.bc });
                });
              }
            } catch(e) {}

            allBoxes.sort(function(a,b){ return b.x1-a.x1; });

            // Colour decode
            function hexFromBc(bc) {
              var r = (bc >>> 16) & 0xFF;
              var g = (bc >>> 8) & 0xFF;
              var b2 = bc & 0xFF;
              return '#' + r.toString(16).padStart(2,'0') + g.toString(16).padStart(2,'0') + b2.toString(16).padStart(2,'0');
            }

            var lastBox = allBoxes[0] || null;
            var lastBoxColor = lastBox ? hexFromBc(lastBox.bc || 0) : null;
            var totalBoxes = allBoxes.length;
            // Green boxes (#50af4c = bc 424718156) = WCL windows
            var greenCount = allBoxes.filter(function(b){ return b.bc === 424718156; }).length;
            var blueCount  = allBoxes.filter(function(b){ return b.bc === 423966450; }).length;

            return {
              found: true,
              lastDclX: lastDclX,
              lastBoxColor: lastBoxColor,
              totalBoxes: totalBoxes,
              greenBoxes: greenCount,
              blueBoxes: blueCount,
              lastBoxX1: lastBox ? lastBox.x1 : null,
              lastBoxX2: lastBox ? lastBox.x2 : null,
            };
          }
        } catch(e) {}
        return { found: false };
      })()
    `),
    new Promise(r => setTimeout(() => r({ found: false }), 5000))
  ]);
}

// ── Main scan loop ────────────────────────────────────────────────────────────
await healthCheck();
await setTimeframe('D');  // Daily timeframe — CF Cycle shows daily counts
await wait(2000);

const results = [];

// Process in batches — 2025 score≥10 first (top priority), then rest
const highPri  = tickers.filter(r => new Date(r.signal_date).getFullYear() === 2025 && +r.score >= 10);
const midPri   = tickers.filter(r => new Date(r.signal_date).getFullYear() === 2025 && +r.score < 10);
const oldPri   = tickers.filter(r => new Date(r.signal_date).getFullYear() < 2025);
const ordered  = [...highPri, ...midPri, ...oldPri];

console.log(`High priority (2025, score≥10): ${highPri.length}`);
console.log(`Mid priority (2025, score<10):  ${midPri.length}`);
console.log(`Historical (2023-24):           ${oldPri.length}`);
console.log('');

for (const row of ordered) {
  const ticker    = row.ticker;
  const sigDate   = row.signal_date;
  const entryPx   = +row.entry_price;
  const score     = +row.score;
  const outcome   = row.outcome_2x;
  const outcome3x = row.outcome_3x;
  const fwd90     = +row.terminal_return_90d;

  process.stdout.write(`  → ${ticker.padEnd(6)} (score ${score}, ${sigDate.slice(0,4)})  `);

  try {
    // Try exchange prefix, fallback to plain symbol
    const sym = ticker;
    await setSymbol(sym);
    await wait(SWITCH_MS);

    const price   = await getCurrentPrice();
    const pxNow   = price || entryPx;
    const gainPct = price ? ((price - entryPx) / entryPx * 100) : null;

    const cycle   = await readCycleData();
    const screenshot = await takeCDPScreenshot(ticker);

    results.push({
      ticker, sigDate, entryPx, score, outcome, outcome3x, fwd90,
      pxNow,  gainPct,
      cycleFound:   cycle.found,
      cycleBoxes:   cycle.totalBoxes,
      cycleGreen:   cycle.greenBoxes,
      cycleBlue:    cycle.blueBoxes,
      screenshotPath: screenshot,
      year: new Date(sigDate).getFullYear(),
    });

    const gainStr = gainPct != null ? ` | now $${fmt(pxNow)} (${gainPct >= 0 ? '+' : ''}${fmt(gainPct,1)}% from entry)` : '';
    const cycStr  = cycle.found ? ` | cycle boxes=${cycle.totalBoxes}(🟢${cycle.greenBoxes} 🔵${cycle.blueBoxes})` : '';
    const imgStr  = screenshot ? ' 📸' : '';
    console.log(`${gainStr}${cycStr}${imgStr}`);

  } catch(e) {
    console.log(` ⚠ ${e.message || 'error'}`);
    results.push({ ticker, sigDate, entryPx, score, outcome, outcome3x, fwd90, pxNow: null, gainPct: null, cycleFound: false, year: new Date(sigDate).getFullYear() });
  }
}

// ── Build markdown report ─────────────────────────────────────────────────────
let md = `# UOA Signal Technical Analysis Report\n`;
md += `**Generated:** ${new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })}\n`;
md += `**Tickers analyzed:** ${results.length} | **Source:** 2023–2025 UOA filtered signals\n\n`;
md += `---\n\n`;

// Summary table — 2025
md += `## 2025 Signals (Most Recent)\n\n`;
md += `| # | Ticker | Signal Date | Entry $ | Score | UOA Outcome | Fwd 90d | Now $ | Gain from Entry |\n`;
md += `|---|--------|-------------|---------|-------|-------------|---------|-------|-----------------|\n`;
const r2025 = results.filter(r => r.year === 2025).sort((a,b) => (+b.score) - (+a.score));
r2025.forEach((r, i) => {
  const outcome = r.outcome === 'BIG_WIN' ? '🟢 BIG WIN' : r.outcome === 'HUGE_WIN' ? '🌟 HUGE WIN' : r.outcome === 'WIN' ? '✅ WIN' : r.outcome === 'LOSS' ? '❌ LOSS' : r.outcome === 'BREAKEVEN' ? '⚖️ BREAK' : r.outcome || '—';
  const fwd90str = !isNaN(r.fwd90) ? (r.fwd90 >= 0 ? '+' : '') + (r.fwd90 * 100).toFixed(1) + '%' : '—';
  const gainStr  = r.gainPct != null ? (r.gainPct >= 0 ? '+' : '') + r.gainPct.toFixed(1) + '%' : '—';
  const nowStr   = r.pxNow ? '$' + fmt(r.pxNow) : '—';
  md += `| ${i+1} | **${r.ticker}** | ${r.sigDate} | $${fmt(r.entryPx)} | ${r.score} | ${outcome} | ${fwd90str} | ${nowStr} | ${gainStr} |\n`;
});

md += `\n## 2024 Signals\n\n`;
md += `| # | Ticker | Signal Date | Entry $ | Score | UOA Outcome | Fwd 90d | Now $ | Gain from Entry |\n`;
md += `|---|--------|-------------|---------|-------|-------------|---------|-------|-----------------|\n`;
const r2024 = results.filter(r => r.year === 2024).sort((a,b) => (+b.score) - (+a.score));
r2024.forEach((r, i) => {
  const outcome = r.outcome === 'BIG_WIN' ? '🟢 BIG WIN' : r.outcome === 'HUGE_WIN' ? '🌟 HUGE WIN' : r.outcome === 'WIN' ? '✅ WIN' : r.outcome === 'LOSS' ? '❌ LOSS' : r.outcome === 'BREAKEVEN' ? '⚖️ BREAK' : r.outcome || '—';
  const fwd90str = !isNaN(r.fwd90) ? (r.fwd90 >= 0 ? '+' : '') + (r.fwd90 * 100).toFixed(1) + '%' : '—';
  const gainStr  = r.gainPct != null ? (r.gainPct >= 0 ? '+' : '') + r.gainPct.toFixed(1) + '%' : '—';
  const nowStr   = r.pxNow ? '$' + fmt(r.pxNow) : '—';
  md += `| ${i+1} | **${r.ticker}** | ${r.sigDate} | $${fmt(r.entryPx)} | ${r.score} | ${outcome} | ${fwd90str} | ${nowStr} | ${gainStr} |\n`;
});

md += `\n## 2023 Signals\n\n`;
md += `| # | Ticker | Signal Date | Entry $ | Score | UOA Outcome | Fwd 90d | Now $ | Gain from Entry |\n`;
md += `|---|--------|-------------|---------|-------|-------------|---------|-------|-----------------|\n`;
const r2023 = results.filter(r => r.year === 2023).sort((a,b) => (+b.score) - (+a.score));
r2023.forEach((r, i) => {
  const outcome = r.outcome === 'BIG_WIN' ? '🟢 BIG WIN' : r.outcome === 'HUGE_WIN' ? '🌟 HUGE WIN' : r.outcome === 'WIN' ? '✅ WIN' : r.outcome === 'LOSS' ? '❌ LOSS' : r.outcome === 'BREAKEVEN' ? '⚖️ BREAK' : r.outcome || '—';
  const fwd90str = !isNaN(r.fwd90) ? (r.fwd90 >= 0 ? '+' : '') + (r.fwd90 * 100).toFixed(1) + '%' : '—';
  const gainStr  = r.gainPct != null ? (r.gainPct >= 0 ? '+' : '') + r.gainPct.toFixed(1) + '%' : '—';
  const nowStr   = r.pxNow ? '$' + fmt(r.pxNow) : '—';
  md += `| ${i+1} | **${r.ticker}** | ${r.sigDate} | $${fmt(r.entryPx)} | ${r.score} | ${outcome} | ${fwd90str} | ${nowStr} | ${gainStr} |\n`;
});

// Screenshots section
md += `\n## Chart Screenshots\n\nAll chart images saved to: \`${CHART_DIR}\`\n\n`;
results.filter(r => r.screenshotPath).forEach(r => {
  md += `### ${r.ticker} — Score ${r.score} | ${r.sigDate.slice(0,7)} | ${r.outcome}\n`;
  md += `Entry: $${fmt(r.entryPx)} | Now: ${r.pxNow ? '$'+fmt(r.pxNow) : '—'} | Gain: ${r.gainPct != null ? (r.gainPct>=0?'+':'')+r.gainPct.toFixed(1)+'%' : '—'}\n\n`;
  md += `![${r.ticker}](${r.screenshotPath})\n\n`;
});

const reportPath = join(OUT_DIR, 'ta_report.md');
writeFileSync(reportPath, md);

// Also save raw JSON
writeFileSync(join(OUT_DIR, 'ta_results.json'), JSON.stringify(results, null, 2));

console.log(`\n✅ Report saved: ${reportPath}`);
console.log(`📁 Charts: ${CHART_DIR}`);
console.log(`📊 Tickers analyzed: ${results.length}`);
console.log(`📸 Screenshots taken: ${results.filter(r=>r.screenshotPath).length}`);

process.exit(0);
