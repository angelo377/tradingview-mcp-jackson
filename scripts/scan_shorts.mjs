#!/usr/bin/env node
/**
 * scan_shorts.mjs  — Short Setup Scanner
 * ─────────────────────────────────────────────────────────────────────────────
 * Cycles through every unique ticker from the UOA CSV signal files,
 * switches TradingView to each one (1H), and reads:
 *
 *   1. Market Structure indicator  — BOS ↑/↓ + HH/HL prices (fib anchor points)
 *   2. Auto SOS/SOW V2             — most recent SOW red dot
 *   3. Auto Metrics signals V4     — most recent SELL signal
 *
 * SHORT SETUP CRITERIA:
 *   ✅ SOW red dot present (last 300 bars)
 *   ✅ Auto Metrics SELL signal present (last 500 bars)
 *   ✅ HH → HL sequence detectable (HL bar AFTER HH bar)
 *   ✅ Current price at or near Fib 0.50–0.628 zone (HH → HL measurement)
 *
 * Two tabs match the 3214 dashboard:
 *   Tab A — BULLISH structure + short conditions  (counter-trend)
 *   Tab B — BEARISH structure + short conditions  (with-trend)
 *
 * On completion:
 *   • Qualifying setups appended to  backtest-short/signals/short_signals.csv
 *   • Floating panel injected into TradingView chart
 *   • Markdown summary printed to console
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join }   from 'path';
import { fileURLToPath }   from 'url';
import { healthCheck }     from '../src/core/health.js';
import { getState }        from '../src/core/chart.js';
import { evaluate }        from '../src/connection.js';
import { getOhlcv }        from '../src/core/data.js';

const __dirname    = dirname(fileURLToPath(import.meta.url));
process.on('unhandledRejection', () => {});

// ── Config ────────────────────────────────────────────────────────────────────
const SWITCH_MS    = 5000;    // ms to wait after symbol switch
const FIB_ENTRY    = 0.500;   // 0.50 fib level  = short entry
const FIB_TOP      = 0.628;   // 0.628 fib level = zone top
const NEAR_TOL     = 0.035;   // 3.5% tolerance below fib50 = "APPROACHING"
const SOW_LOOKBACK = 300;     // bars to scan for SOW
const SELL_LOOKBACK= 500;     // bars to scan for Auto Metrics SELL

// Source CSV files (UOA signals)
const CSV_PATHS = [
  'C:/Users/admin/Downloads/filtered_signals_2022.csv',
  'C:/Users/admin/Downloads/filtered_signals_2023.csv',
  'C:/Users/admin/Downloads/filtered_signals_2024.csv',
  'C:/Users/admin/Downloads/filtered_signals_2025.csv',
];

const OUTPUT_DIR  = join(__dirname, '../backtest-short/signals');
const OUTPUT_CSV  = join(OUTPUT_DIR, 'short_signals.csv');
const SCAN_CACHE  = join(__dirname, 'short_scan_cache.json');

// ── Parse CSV helpers ─────────────────────────────────────────────────────────
function parseCSVLine(line) {
  const res = []; let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { res.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  res.push(cur.trim());
  return res;
}

// ── Load unique tickers from all UOA CSVs ─────────────────────────────────────
// Returns array of { ticker, lastDate } sorted most-recent-first
function loadUOATickers() {
  const map = new Map(); // ticker → most recent signal date
  for (const csvPath of CSV_PATHS) {
    if (!existsSync(csvPath)) continue;
    const lines = readFileSync(csvPath, 'utf-8').trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const v = parseCSVLine(lines[i]);
      if (v.length < 2) continue;
      const date   = v[0];
      const ticker = v[1].toUpperCase();
      if (!ticker || !date) continue;
      if (!map.has(ticker) || date > map.get(ticker)) map.set(ticker, date);
    }
  }
  return [...map.entries()]
    .sort((a, b) => b[1].localeCompare(a[1]))
    .map(([ticker, lastDate]) => ({ ticker, lastDate }));
}

// ── Timeout helper ────────────────────────────────────────────────────────────
const withTimeout = (p, ms, fallback) =>
  Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

// ── fmt helper ────────────────────────────────────────────────────────────────
const fmt = n => (n != null && !isNaN(n)) ? Number(n).toFixed(2) : '—';

// ══════════════════════════════════════════════════════════════════════════════
// INDICATOR READERS
// ══════════════════════════════════════════════════════════════════════════════

// ── Market Structure: BOS direction + HH/HL/LH/LL prices ─────────────────────
async function readMarketStructure() {
  return withTimeout(evaluate(`
    (function() {
      try {
        var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();
        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src.metaInfo) continue;
          var name = (src.metaInfo().description || '').toLowerCase();
          if (!name.includes('market structure')) continue;
          var pc   = src._graphics._primitivesCollection;
          var coll = pc.dwglabels.get('labels').get(false);
          if (!coll || !coll._primitivesDataById) break;

          var bosX = -1, bosText = '';
          var hhX = -1, hhY = null;
          var hlX = -1, hlY = null;
          var lhX = -1, lhY = null;
          var llX = -1, llY = null;
          var swingX = -1, swingLbl = '';
          var ALL = ['HH','HL','LH','LL','H','L'];

          coll._primitivesDataById.forEach(function(v) {
            var t = (v.t || '').trim();
            if (t.includes('BOS') && v.x > bosX)         { bosX = v.x; bosText = t; }
            if (t === 'HH' && v.x > hhX)                 { hhX  = v.x; hhY = v.y; }
            if (t === 'HL' && v.x > hlX)                 { hlX  = v.x; hlY = v.y; }
            if (t === 'LH' && v.x > lhX)                 { lhX  = v.x; lhY = v.y; }
            if (t === 'LL' && v.x > llX)                 { llX  = v.x; llY = v.y; }
            if (ALL.indexOf(t) !== -1 && v.x > swingX)   { swingX = v.x; swingLbl = t; }
          });

          var bull = bosText.includes('↑') ? true
                   : bosText.includes('↓') ? false
                   : null;

          return { bull, bosText, lastSwing: swingLbl,
                   hhPrice: hhY, hhBarIdx: hhX,
                   hlPrice: hlY, hlBarIdx: hlX,
                   lhPrice: lhY, lhBarIdx: lhX,
                   llPrice: llY, llBarIdx: llX };
        }
      } catch(e) {}
      return { bull: null, bosText: '', lastSwing: '',
               hhPrice: null, hhBarIdx: -1, hlPrice: null, hlBarIdx: -1,
               lhPrice: null, lhBarIdx: -1, llPrice: null, llBarIdx: -1 };
    })()
  `), 6000, { bull: null, bosText: '', lastSwing: '',
               hhPrice: null, hhBarIdx: -1, hlPrice: null, hlBarIdx: -1,
               lhPrice: null, lhBarIdx: -1, llPrice: null, llBarIdx: -1 });
}

// ── SOW/SOS: Auto SOS/SOW V2 ──────────────────────────────────────────────────
async function readSOWSOS() {
  return withTimeout(evaluate(`
    (function() {
      try {
        var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();
        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src.metaInfo) continue;
          var name = (src.metaInfo().description || '').toLowerCase();
          if (!name.includes('sos') || !name.includes('sow')) continue;
          var items = src._data && src._data._items;
          if (!items || !items.length) return { signal: null, barsAgo: null };
          var limit = Math.max(0, items.length - ${SOW_LOOKBACK});
          for (var i = items.length - 1; i >= limit; i--) {
            var item = items[i]; if (!item) continue;
            var val  = item.value;
            var p    = Array.isArray(val) ? val : null;
            if (!p) { try { p = JSON.parse(val); } catch(e) {} }
            if (!p || p.length < 3) continue;
            if (p[2] === 1) return { signal: 'SOW', barsAgo: items.length - 1 - i };
            if (p[1] === 1) return { signal: 'SOS', barsAgo: items.length - 1 - i };
          }
          return { signal: null, barsAgo: null };
        }
      } catch(e) {}
      return { signal: null, barsAgo: null, reason: 'indicator-not-found' };
    })()
  `), 7000, { signal: null, barsAgo: null });
}

// ── Auto Metrics SELL/BUY signal ──────────────────────────────────────────────
async function readAutoMetrics() {
  return withTimeout(evaluate(`
    (function() {
      try {
        var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();
        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src.metaInfo) continue;
          var name = (src.metaInfo().description || '').toLowerCase();
          if (!name.includes('auto metrics')) continue;
          var items = src._data && src._data._items;
          if (!items || !items.length) return { signal: null, dateLabel: null };
          var limit = Math.max(0, items.length - ${SELL_LOOKBACK});
          for (var i = items.length - 1; i >= limit; i--) {
            var item = items[i]; if (!item) continue;
            var val  = item.value;
            var p    = Array.isArray(val) ? val : null;
            if (!p) { try { p = JSON.parse(val); } catch(e) {} }
            if (!p || p.length < 7) continue;
            if (p[5] === 1 || p[6] === 1) {
              var signal = p[5] === 1 ? 'SELL' : 'BUY';
              var ts     = p[0];
              var d      = new Date(ts * 1000);
              var mo     = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              var lbl    = mo[d.getMonth()] + ' ' + d.getDate();
              return { signal, dateLabel: lbl, barsAgo: items.length - 1 - i };
            }
          }
          return { signal: null, dateLabel: null };
        }
      } catch(e) {}
      return { signal: null, dateLabel: null, reason: 'indicator-not-found' };
    })()
  `), 7000, { signal: null, dateLabel: null });
}

// ── On-chart results panel ─────────────────────────────────────────────────────
async function renderPanel(rows, ts) {
  const payload = JSON.stringify({ rows, ts });
  await evaluate(`
    (function() {
      var old = document.getElementById('__short_scan_panel');
      if (old) old.remove();

      var data  = ${payload};
      var rows  = data.rows;
      var ts    = data.ts;
      var typeA = rows.filter(function(r){ return r.structure === 'BULLISH'; });
      var typeB = rows.filter(function(r){ return r.structure === 'BEARISH'; });

      function el(tag, css, txt) {
        var e = document.createElement(tag);
        if (css) Object.assign(e.style, css);
        if (txt !== undefined) e.textContent = txt;
        return e;
      }

      var panel = el('div', {
        position:'fixed', top:'55px', right:'55px', zIndex:'99999',
        background:'#131722', border:'1px solid #2a2e39', borderRadius:'8px',
        fontFamily:'"Trebuchet MS",sans-serif', fontSize:'11px', color:'#d1d4dc',
        boxShadow:'0 4px 28px rgba(0,0,0,0.7)', width:'640px',
        userSelect:'none', overflow:'hidden',
      });
      panel.id = '__short_scan_panel';

      // Header
      var hdr = el('div', {
        background:'#1a0a0a', padding:'8px 12px',
        display:'flex', justifyContent:'space-between', alignItems:'center',
        borderBottom:'1px solid #ef535044', cursor:'move',
      });
      hdr.innerHTML =
        '<span style="color:#ef5350;font-weight:700;font-size:12px">📉 Short Setup Scanner · ' + ts + '</span>' +
        '<span style="color:#787b86;font-size:10px">SOW + SELL + Fib 0.50–0.628</span>';
      var X = el('span',{marginLeft:'10px',cursor:'pointer',color:'#787b86',fontSize:'14px',fontWeight:'700'},'✕');
      X.onclick = function(){ panel.remove(); };
      hdr.appendChild(X);
      panel.appendChild(hdr);

      // Stats row
      var stats = el('div', {
        display:'grid', gridTemplateColumns:'repeat(4,1fr)',
        gap:'1px', background:'#2a2e39', borderBottom:'1px solid #2a2e39'
      });
      [
        { label:'TOTAL', val: rows.length,   color:'#d1d4dc' },
        { label:'TYPE A (BULL)',  val: typeA.length, color:'#26a69a' },
        { label:'TYPE B (BEAR)',  val: typeB.length, color:'#ef5350' },
        { label:'AT ZONE',        val: rows.filter(function(r){ return r.fibZone==='AT_ZONE'; }).length, color:'#f59e0b' },
      ].forEach(function(s) {
        var c = el('div',{ background:'#131722', padding:'8px 4px', textAlign:'center' });
        c.appendChild(el('div',{fontSize:'18px',fontWeight:'700',color:s.color}, String(s.val)));
        c.appendChild(el('div',{fontSize:'9px',color:'#787b86',letterSpacing:'.5px'}, s.label));
        stats.appendChild(c);
      });
      panel.appendChild(stats);

      // Table
      var body = el('div',{ maxHeight:'480px', overflowY:'auto' });
      var COL = '55px 60px 70px 35px 65px 65px 65px 65px 75px 75px';
      var hrow = el('div',{
        display:'grid', gridTemplateColumns:COL,
        padding:'4px 10px', color:'#4a4e5a', fontSize:'9px',
        fontWeight:'700', letterSpacing:'.5px', textTransform:'uppercase',
        borderBottom:'1px solid #2a2e39', background:'#1a1f2e'
      });
      ['TICKER','PRICE','STRUCT','SWING','HH','HL','FIB50','FIB618','ZONE','SELL'].forEach(function(h){
        hrow.appendChild(el('div',{},h));
      });
      body.appendChild(hrow);

      rows.forEach(function(r, i) {
        var row = el('div',{
          display:'grid', gridTemplateColumns: COL,
          padding:'3px 10px', alignItems:'center',
          background: i%2===0 ? 'transparent' : 'rgba(255,255,255,.02)',
        });
        row.onmouseover = function(){ row.style.background='rgba(239,83,80,.07)'; };
        row.onmouseout  = function(){ row.style.background=i%2===0?'transparent':'rgba(255,255,255,.02)'; };

        var tc = r.structure === 'BULLISH' ? '#26a69a' : r.structure === 'BEARISH' ? '#ef5350' : '#787b86';
        var zc = r.fibZone === 'AT_ZONE' ? '#f59e0b' : r.fibZone === 'APPROACHING' ? '#60a5fa' : '#4a4e5a';

        row.appendChild(el('div',{fontWeight:'700',color:'#d1d4dc'}, r.ticker));
        row.appendChild(el('div',{color:'#d1d4dc'}, '$' + r.price));
        row.appendChild(el('div',{color:tc,fontWeight:'700',fontSize:'10px'}, r.bosText || r.structure));
        row.appendChild(el('div',{color:r.lastSwing?tc:'#4a4e5a',fontWeight:'700'}, r.lastSwing || '—'));
        row.appendChild(el('div',{color:'#ef5350',fontSize:'10px'}, r.hhPrice ? '$'+r.hhPrice : '—'));
        row.appendChild(el('div',{color:'#26a69a',fontSize:'10px'}, r.hlPrice ? '$'+r.hlPrice : '—'));
        row.appendChild(el('div',{color:'#f59e0b',fontSize:'10px'}, r.fib50  ? '$'+r.fib50  : '—'));
        row.appendChild(el('div',{color:'#a78bfa',fontSize:'10px'}, r.fib618 ? '$'+r.fib618 : '—'));
        row.appendChild(el('div',{color:zc,fontWeight:r.fibZone==='AT_ZONE'?'700':'400',fontSize:'10px'}, r.fibZone));

        var sd = el('div',{fontSize:'9px',lineHeight:'1.35'});
        if (r.sosSow === 'SOW') sd.innerHTML += '<span style="color:#ef5350;font-weight:700">🔴SOW</span> ';
        if (r.amSignal === 'SELL') sd.innerHTML += '<span style="color:#ef5350">SELL</span>';
        row.appendChild(sd);

        body.appendChild(row);
      });
      panel.appendChild(body);

      // Footer
      var ft = el('div',{
        borderTop:'1px solid #2a2e39', padding:'5px 12px',
        color:'#4a4e5a', fontSize:'9px', display:'flex', justifyContent:'space-between'
      });
      ft.innerHTML = '<span>Type A = SHORT in Bullish · Type B = SHORT in Bearish</span><span>drag · ✕ close</span>';
      panel.appendChild(ft);

      // Drag
      var drag=false,ox=0,oy=0;
      hdr.addEventListener('mousedown',function(e){ drag=true; ox=e.clientX-panel.offsetLeft; oy=e.clientY-panel.offsetTop; });
      document.addEventListener('mousemove',function(e){ if(!drag)return; panel.style.left=(e.clientX-ox)+'px'; panel.style.top=(e.clientY-oy)+'px'; panel.style.right='auto'; });
      document.addEventListener('mouseup',function(){ drag=false; });

      document.body.appendChild(panel);
    })();
  `);
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
const health = await healthCheck();
const ts     = new Date().toLocaleTimeString('en-US', { hour12: false });
const today  = new Date().toISOString().slice(0, 10);

console.log('');
console.log('╔══════════════════════════════════════════════════════════╗');
console.log(`║  SHORT SETUP SCANNER  ·  ${ts}                   ║`);
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`  CDP  : ${health.cdp_connected ? '✅ Connected' : '❌ Disconnected'}`);
console.log(`  Chart: ${health.chart_symbol} @ ${health.chart_resolution}`);

if (!health.cdp_connected || !health.api_available) {
  console.log('\n  ❌ Cannot scan — TradingView not reachable.\n');
  process.exit(1);
}

// Save original symbol
let origSymbol;
try { origSymbol = (await getState()).symbol; } catch (_) {}

// Load tickers
const tickers = loadUOATickers();
console.log(`\n  📋 ${tickers.length} unique tickers from UOA CSV files (sorted most-recent-first)`);
console.log(`  🔍 Criteria: SOW red dot + Auto Metrics SELL + Fib 0.50–0.628 (HH→HL)\n`);

// Switch to 1H timeframe
try {
  await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().setResolution('60', {})`);
  await new Promise(r => setTimeout(r, 2000));
  console.log('  ✅ Timeframe set to 1H\n');
} catch (_) {
  console.log('  ⚠ Could not set timeframe — continuing with current TF\n');
}

const results = [];

for (let i = 0; i < tickers.length; i++) {
  const { ticker, lastDate } = tickers[i];
  process.stdout.write(`  [${String(i + 1).padStart(3)}/${tickers.length}] ${ticker.padEnd(8)}`);

  try {
    // Switch symbol
    await withTimeout(evaluate(`
      window.TradingViewApi._activeChartWidgetWV.value().setSymbol('${ticker.replace(/'/g,"\\'")}', {})
    `), 3000, null);
    await new Promise(r => setTimeout(r, SWITCH_MS));

    // Get price
    let price = null;
    try {
      const ohlcv = await withTimeout(getOhlcv({ count: 3 }), 5000, null);
      if (ohlcv?.bars?.length >= 1) price = ohlcv.bars[ohlcv.bars.length - 1].close;
    } catch (_) {}

    // Read indicators
    let ms  = await readMarketStructure();
    if (ms.bull === null && !ms.hhPrice) {
      // Retry once
      await new Promise(r => setTimeout(r, 3000));
      ms = await readMarketStructure();
    }
    const sowResult = await readSOWSOS();
    const amResult  = await readAutoMetrics();

    // ── Fib calculation ────────────────────────────────────────────────────
    // Require: HL came AFTER HH (price pulled back from HH)
    // and HH > HL (valid upswing to measure from)
    let fib50 = null, fib618 = null, fibZone = 'NO_FIB';
    const validFib = ms.hhPrice && ms.hlPrice &&
                     ms.hhPrice > ms.hlPrice  &&
                     ms.hlBarIdx > ms.hhBarIdx;  // HL must come AFTER HH

    if (validFib) {
      const range = ms.hhPrice - ms.hlPrice;
      fib50  = ms.hlPrice + FIB_ENTRY * range;
      fib618 = ms.hlPrice + FIB_TOP   * range;

      if (price !== null) {
        if   (price >= fib50 && price <= fib618)              fibZone = 'AT_ZONE';
        else if (price >= fib50 * (1 - NEAR_TOL) && price < fib50) fibZone = 'APPROACHING';
        else if (price > fib618)                              fibZone = 'ABOVE_ZONE';
        else                                                  fibZone = 'BELOW_ZONE';
      }
    }

    // ── Short setup check ──────────────────────────────────────────────────
    const hasSow    = sowResult.signal === 'SOW';
    const hasSell   = amResult.signal  === 'SELL';
    const hasBos    = ms.bull !== null;
    const structure = ms.bull === true ? 'BULLISH' : ms.bull === false ? 'BEARISH' : 'UNKNOWN';
    const isSetup   = hasSow && hasSell && hasBos && validFib &&
                      (fibZone === 'AT_ZONE' || fibZone === 'APPROACHING');

    const row = {
      ticker,
      lastDate,
      price:     price ? fmt(price) : '—',
      structure,
      bull:      ms.bull,
      bosText:   ms.bosText,
      lastSwing: ms.lastSwing,
      hhPrice:   ms.hhPrice ? fmt(ms.hhPrice) : null,
      hlPrice:   ms.hlPrice ? fmt(ms.hlPrice) : null,
      fib50:     fib50  ? fmt(fib50)  : null,
      fib618:    fib618 ? fmt(fib618) : null,
      fibZone,
      sosSow:    sowResult.signal  || null,
      sowBars:   sowResult.barsAgo ?? null,
      amSignal:  amResult.signal   || null,
      amDate:    amResult.dateLabel || null,
      isSetup,
    };
    results.push(row);

    // Console output
    const icon  = ms.bull === true ? '🟢' : ms.bull === false ? '🔴' : '⚪';
    const sowS  = hasSow  ? ' 🔴SOW'  : '';
    const selS  = hasSell ? ' 🔴SELL' : '';
    const fibS  = fibZone === 'AT_ZONE'     ? ' 🎯 AT ZONE'
                : fibZone === 'APPROACHING' ? ' ⚡ NEAR ZONE' : '';
    const star  = isSetup ? ' ⭐ SHORT SETUP!' : '';
    console.log(` ${icon} ${structure.padEnd(8)} ${(ms.bosText || '').padEnd(8)}${sowS}${selS}${fibS}${star}`);

  } catch (err) {
    results.push({ ticker, lastDate, structure: 'ERROR', isSetup: false });
    console.log(` ⚠ ${(err.message || 'error').slice(0, 50)}`);
  }
}

// ── Restore original symbol ───────────────────────────────────────────────────
if (origSymbol) {
  try {
    await evaluate(`window.TradingViewApi._activeChartWidgetWV.value().setSymbol('${origSymbol.replace(/'/g,"\\'")}', {})`);
  } catch (_) {}
}

// ── Filter setups ─────────────────────────────────────────────────────────────
const setups      = results.filter(r => r.isSetup);
const typeA       = setups.filter(r => r.structure === 'BULLISH');  // counter-trend
const typeB       = setups.filter(r => r.structure === 'BEARISH');  // with-trend

// ── Write to short_signals.csv ────────────────────────────────────────────────
if (setups.length) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  // Load existing entries to avoid duplicate date+ticker
  let existingKeys = new Set();
  if (existsSync(OUTPUT_CSV)) {
    const lines = readFileSync(OUTPUT_CSV, 'utf-8').trim().split('\n').slice(1).filter(Boolean);
    lines.forEach(l => { const v = l.split(','); if (v[0] && v[1]) existingKeys.add(v[0] + '_' + v[1]); });
  }

  const newSetups = setups.filter(s =>
    s.hhPrice && s.hlPrice &&
    !existingKeys.has(today + '_' + s.ticker)
  );

  if (newSetups.length) {
    const headerNeeded = !existsSync(OUTPUT_CSV) ||
                         readFileSync(OUTPUT_CSV, 'utf-8').trim().length === 0;
    const header = 'date,ticker,year,structure,sosSow,amSignal,hhPrice,hlPrice,notes\n';
    const rows   = newSetups.map(s =>
      `${today},${s.ticker},${today.slice(0, 4)},${s.structure},SOW,SELL,${s.hhPrice},${s.hlPrice},auto-scan`
    ).join('\n');

    const existing_content = existsSync(OUTPUT_CSV) ? readFileSync(OUTPUT_CSV, 'utf-8').trimEnd() : '';
    const final_content = (headerNeeded ? header : existing_content + '\n') + rows + '\n';
    writeFileSync(OUTPUT_CSV, headerNeeded ? header + rows + '\n' : final_content);
    console.log(`\n  ✅ Wrote ${newSetups.length} new short setups → ${OUTPUT_CSV}`);
  } else {
    console.log('\n  ℹ All detected setups already exist in short_signals.csv');
  }
}

// ── Save scan cache for dashboard use ─────────────────────────────────────────
try {
  writeFileSync(SCAN_CACHE, JSON.stringify({ results, ts, setups: setups.length, date: today }, null, 2));
} catch (_) {}

// ── Render TradingView panel ──────────────────────────────────────────────────
if (setups.length) {
  await renderPanel(setups, ts);
} else {
  console.log('\n  ℹ No short setups found this scan.');
}

// ── Console Markdown summary ──────────────────────────────────────────────────
const scanned = results.filter(r => r.structure !== 'ERROR').length;
console.log(`\n## 📉 Short Setup Scanner — ${ts}\n`);
console.log(`Scanned **${scanned}** of **${tickers.length}** UOA tickers on 1H timeframe.\n`);
console.log('| Category | Count | Tickers |');
console.log('|----------|------:|---------|');
console.log(`| ⭐ Total Short Setups       | ${setups.length} | ${setups.map(s => s.ticker).join(', ') || '—'} |`);
console.log(`| 🟢 Type A — Bullish (counter-trend) | ${typeA.length} | ${typeA.map(s => s.ticker).join(', ') || '—'} |`);
console.log(`| 🔴 Type B — Bearish (with-trend)    | ${typeB.length} | ${typeB.map(s => s.ticker).join(', ') || '—'} |`);
console.log(`| 🔴 SOW signal found   | ${results.filter(r=>r.sosSow==='SOW').length}  | — |`);
console.log(`| 🔴 SELL signal found  | ${results.filter(r=>r.amSignal==='SELL').length} | — |`);
console.log(`| 🎯 Price AT fib zone  | ${results.filter(r=>r.fibZone==='AT_ZONE').length}  | ${results.filter(r=>r.fibZone==='AT_ZONE').map(r=>r.ticker).join(', ') || '—'} |`);
console.log(`| ⚡ Price APPROACHING  | ${results.filter(r=>r.fibZone==='APPROACHING').length}  | ${results.filter(r=>r.fibZone==='APPROACHING').map(r=>r.ticker).join(', ') || '—'} |`);

if (setups.length) {
  console.log(`\n### ⭐ Short Setups Found\n`);
  console.log('| # | Ticker | Price | Structure | BOS | Swing | HH | HL | Fib50 | Fib618 | Zone | Last UOA |');
  console.log('|---|--------|------:|-----------|-----|-------|----|----|-------|--------|------|----------|');
  setups.forEach((s, idx) => {
    const bosIcon = s.bull === true ? '🟢 BOS ↑' : s.bull === false ? '🔴 BOS ↓' : '—';
    console.log(`| ${idx+1} | **${s.ticker}** | $${s.price} | ${s.structure} | ${bosIcon} | ${s.lastSwing||'—'} | $${s.hhPrice||'—'} | $${s.hlPrice||'—'} | $${s.fib50||'—'} | $${s.fib618||'—'} | ${s.fibZone} | ${s.lastDate} |`);
  });
}

console.log(`\n### 📋 Full Scan Results\n`);
console.log('| Ticker | Price | Structure | BOS | SOW | SELL | Fib Zone | HH | HL | Last UOA |');
console.log('|--------|------:|-----------|-----|:---:|:----:|----------|----|----|----------|');
results.forEach(r => {
  if (r.structure === 'ERROR') return;
  const bos  = r.bull === true ? '🟢 BOS ↑' : r.bull === false ? '🔴 BOS ↓' : `⚪ ${r.structure}`;
  const sow  = r.sosSow   === 'SOW'  ? '🔴' : '—';
  const sell = r.amSignal === 'SELL' ? '🔴' : '—';
  const zone = r.fibZone === 'AT_ZONE' ? '🎯 AT ZONE'
             : r.fibZone === 'APPROACHING' ? '⚡ NEAR'
             : r.fibZone === 'NO_FIB' ? '—' : r.fibZone;
  console.log(`| ${r.isSetup ? '⭐' : ''}${r.ticker} | $${r.price} | ${bos} | ${r.lastSwing||'—'} | ${sow} | ${sell} | ${zone} | $${r.hhPrice||'—'} | $${r.hlPrice||'—'} | ${r.lastDate} |`);
});

console.log('\n_Short setups written to backtest-short/signals/short_signals.csv ✅_\n');
process.exit(0);
