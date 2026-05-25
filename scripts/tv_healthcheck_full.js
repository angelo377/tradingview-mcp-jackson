#!/usr/bin/env node
/**
 * tv_healthcheck_full.js  (v4 — reads from indicator)
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggered by: tv_health_check
 *
 * Per watchlist symbol reports:
 *   1. Market Structure  — reads BOS ↑ / BOS ↓ labels + swing labels (HH/LH/HL/LL)
 *                          from "Market Structure + BOS + POI" indicator (swing_len=30)
 *   2. POI Zone          — price inside orange box (0.618–0.65 Fib) drawn on BOS ↑
 *                          Reports setup stage: AT POI / RETRACING / MISSED / NO POI
 *   3. Fib 0.50          — price within ±0.5% of yellow 0.50 line
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join }               from 'path';
import { fileURLToPath }               from 'url';
import { healthCheck }                 from '../src/core/health.js';
import { get as getWatchlist }         from '../src/core/watchlist.js';
import { getState }                    from '../src/core/chart.js';
import { evaluate }                    from '../src/connection.js';
import { getOhlcv }                    from '../src/core/data.js';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE     = join(__dirname, 'watchlist_cache.json');
const SCAN_CACHE     = join(__dirname, 'scan_cache.json');
const EARNINGS_FILE  = join(__dirname, 'earnings_cache.json');

// Swallow late-resolving CDP rejections
process.on('unhandledRejection', () => {});

// ── CONFIG ────────────────────────────────────────────────────────────────────
const SWITCH_MS  = 5000;   // ms to wait after each symbol switch
const FIB50_TOL  = 0.005;  // 0.5% tolerance for fib 0.50 match

// ── EARNINGS HELPER ───────────────────────────────────────────────────────────
let earningsMap = {};
try {
  const ec = JSON.parse(readFileSync(EARNINGS_FILE, 'utf-8'));
  earningsMap = ec.earnings || {};
} catch (_) {}

function getEarnings(ticker) {
  const dateStr = earningsMap[ticker];
  if (!dateStr || dateStr === 'N/A') return { date: '—', days: null, daysStr: '—' };
  const today = new Date(); today.setHours(0,0,0,0);
  const eDate = new Date(dateStr); eDate.setHours(0,0,0,0);
  const days  = Math.round((eDate - today) / 86400000);
  const label = eDate.toLocaleDateString('en-US', { month:'short', day:'numeric' });
  return {
    date:    label,
    days:    days,
    daysStr: days < 0 ? 'passed' : days === 0 ? 'TODAY' : `${days}d`,
  };
}

// ── TIMEOUT HELPER ────────────────────────────────────────────────────────────
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ── FORMAT HELPERS ────────────────────────────────────────────────────────────
function fmt(n) { return n != null && !isNaN(n) ? Number(n).toFixed(2) : '—'; }

// ── READ MARKET STRUCTURE FROM INDICATOR (BOS ↑ / BOS ↓ labels) ─────────────
// Reads the most recent "BOS ↑" or "BOS ↓" label from the
// "Market Structure + BOS + POI" indicator (swing_len=30, no CHoCH).
// Also reads swing labels (HH, LH, HL, LL) to determine structure phase.
// Returns: { label, bull, bosText, swingPhase, lastSwingLabel }
async function readMarketStructureFromIndicator() {
  return await withTimeout(evaluate(`
    (function() {
      try {
        var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();

        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src.metaInfo) continue;
          try {
            var meta = src.metaInfo();
            var name = (meta.description || meta.shortDescription || '').toLowerCase();
            if (!name.includes('market structure')) continue;

            var g = src._graphics;
            if (!g || !g._primitivesCollection) break;
            var pc = g._primitivesCollection;

            var bosX    = -1;
            var bosText = '';
            var swingX  = -1;
            var swingLbl = '';

            // Swing label sets — highs vs lows
            var SWING_HIGHS = ['HH', 'LH', 'H'];
            var SWING_LOWS  = ['HL', 'LL', 'L'];
            var SWING_ALL   = SWING_HIGHS.concat(SWING_LOWS);

            try {
              var coll = pc.dwglabels.get('labels').get(false);
              if (coll && coll._primitivesDataById) {
                coll._primitivesDataById.forEach(function(v) {
                  var t = (v.t || '').trim();

                  // BOS ↑ / BOS ↓ — most recent by bar position
                  if (t.includes('BOS') && v.x > bosX) {
                    bosX    = v.x;
                    bosText = t;
                  }

                  // Swing structure labels — most recent HH/LH/HL/LL
                  if (SWING_ALL.indexOf(t) !== -1 && v.x > swingX) {
                    swingX   = v.x;
                    swingLbl = t;
                  }
                });
              }
            } catch(e) {}

            // Determine BOS direction
            var bull = bosText.includes('↑') ? true
                     : bosText.includes('↓') ? false
                     : null;

            // Determine swing phase from most recent swing label
            // HH or HL = bullish structure building; LH or LL = bearish
            var swingPhase = 'UNKNOWN';
            if      (swingLbl === 'HH')                             swingPhase = 'HH — Higher High';
            else if (swingLbl === 'HL')                             swingPhase = 'HL — Higher Low';
            else if (swingLbl === 'LH')                             swingPhase = 'LH — Lower High';
            else if (swingLbl === 'LL')                             swingPhase = 'LL — Lower Low';
            else if (swingLbl === 'H' || swingLbl === 'L')         swingPhase = swingLbl + ' — First Pivot';

            return {
              label:          bull === true ? 'BULLISH' : bull === false ? 'BEARISH' : 'NO DATA',
              bull:           bull,
              bosText:        bosText,
              swingPhase:     swingPhase,
              lastSwingLabel: swingLbl,
            };

          } catch(e) {}
        }
      } catch(e) {}

      return { label: 'NO DATA', bull: null, bosText: '', swingPhase: 'UNKNOWN', lastSwingLabel: '' };
    })()
  `), 6000, { label: 'NO DATA', bull: null, bosText: '', swingPhase: 'UNKNOWN', lastSwingLabel: '' });
}

// ── POI: read orange boxes (0.618–0.65) drawn on BOS ↑ ───────────────────────
// The new indicator draws POI boxes ONLY on bullish BOS.
// Reports setup stage:
//   AT POI      — price is inside the orange box
//   RETRACING   — BOS ↑ fired, price is above the box (has not yet retraced)
//   MISSED      — price is below the box bottom (retracement went too deep)
//   NO POI      — no box drawn (bearish structure or BOS not yet fired)
// Returns: { hit, stage, text, poiTop, poiBottom, fib50 }
async function readPOIFromIndicator(price) {
  return await withTimeout(evaluate(`
    (function() {
      var price = ${price};
      if (!price || isNaN(price)) return { hit: false, stage: 'NO POI', text: '—', poiTop: null, poiBottom: null, fib50: null };
      try {
        var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();
        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src.metaInfo) continue;
          var name = (src.metaInfo().description || '').toLowerCase();
          if (!name.includes('market structure')) continue;

          var pc    = src._graphics._primitivesCollection;
          var boxes = pc.dwgboxes.get('boxes').get(false);

          // Collect all POI boxes — pick the most recent (highest bar_index x1)
          var bestBox = null;
          var bestX   = -1;
          boxes._primitivesDataById.forEach(function(v) {
            if (v.x1 > bestX) { bestX = v.x1; bestBox = v; }
          });

          if (!bestBox) return { hit: false, stage: 'NO POI', text: 'No box drawn', poiTop: null, poiBottom: null, fib50: null };

          var lo  = Math.min(bestBox.y1, bestBox.y2);
          var hi  = Math.max(bestBox.y1, bestBox.y2);
          var mid = lo + (hi - lo) / 2;

          // Also read the 0.50 line level from labels for context
          var fib50Level = null;
          try {
            var lblColl = pc.dwglabels.get('labels').get(false);
            var bestLX  = -1;
            lblColl._primitivesDataById.forEach(function(v) {
              if ((v.t || '').trim() === '0.50' && v.x > bestLX) {
                bestLX = v.x; fib50Level = v.y;
              }
            });
          } catch(e2) {}

          var zoneText = lo.toFixed(2) + ' – ' + hi.toFixed(2) + ' (0.618–0.65)';
          var stage, hit;

          if (price >= lo && price <= hi) {
            stage = 'AT POI';
            hit   = true;
          } else if (price > hi) {
            stage = 'RETRACING';
            hit   = false;
          } else {
            stage = 'MISSED';
            hit   = false;
          }

          return { hit: hit, stage: stage, text: zoneText, poiTop: hi, poiBottom: lo, fib50: fib50Level };
        }
      } catch(e) {}
      return { hit: false, stage: 'NO POI', text: '—', poiTop: null, poiBottom: null, fib50: null };
    })()
  `), 5000, { hit: false, stage: 'NO POI', text: '—', poiTop: null, poiBottom: null, fib50: null });
}

// ── CYCLE: read CF Cycle Trading Indicator ────────────────────────────────────
// Reads:
//   1. Last DCL label (e.g. "48D") — day-count label at the most recent confirmed DCL
//   2. W marker  — weekly cycle low confirmed at that same point
//   3. Green boxes — upcoming Daily Cycle Low (DCL) window
//   4. Blue  boxes — upcoming Weekly Cycle Low (WCL) window
// Returns: { found, lastDclDays, hasWeekly, boxes[] }
//   boxes[] → { x1, x2, color (raw JSON), dateStart, dateEnd }
async function readCycleFromIndicator() {
  return await withTimeout(evaluate(`
    (function() {
      try {
        var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();

        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src.metaInfo) continue;
          try {
            var meta = src.metaInfo();
            var name = (meta.description || meta.shortDescription || '').toLowerCase();
            if (!name.includes('cf cycle') && !name.includes('cycle trading')) continue;

            var g = src._graphics;
            if (!g || !g._primitivesCollection) continue;
            var pc = g._primitivesCollection;

            // ── Labels: last "XD" count + W marker ───────────────────────────
            var lastDclDays = null;
            var lastDclX    = -1;
            var hasWeekly   = false;

            try {
              var lblColl = pc.dwglabels.get('labels').get(false);
              if (lblColl && lblColl._primitivesDataById) {
                lblColl._primitivesDataById.forEach(function(v) {
                  var t = (v.t || '').trim();
                  if (/^\\d+D$/.test(t) && v.x > lastDclX) {
                    lastDclX    = v.x;
                    lastDclDays = parseInt(t);
                  }
                  if (t === 'W') hasWeekly = true;
                });
              }
            } catch(e) {}

            // ── Boxes: collect all with raw color + bar→date ─────────────────
            var boxList = [];
            function barToDate(barIdx) {
              try {
                var ts = chart.model().timeScale();
                if (ts && ts.indexToTime) {
                  var t = ts.indexToTime(barIdx);
                  if (t && t > 1000000000) {
                    return new Date(t * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric' });
                  }
                }
              } catch(e) {}
              return null;
            }

            try {
              var boxColl = pc.dwgboxes.get('boxes').get(false);
              if (boxColl && boxColl._primitivesDataById) {
                boxColl._primitivesDataById.forEach(function(v) {
                  var rawCol = v.backgroundColor || v.fillColor || v.bgColor || null;
                  var colStr = '';
                  try { colStr = JSON.stringify(rawCol); } catch(e) {}
                  boxList.push({
                    x1:        v.x1,
                    x2:        v.x2,
                    color:     colStr.slice(0, 140),
                    dateStart: barToDate(v.x1),
                    dateEnd:   barToDate(v.x2),
                  });
                });
              }
            } catch(e) {}

            return { found: true, lastDclDays: lastDclDays, hasWeekly: hasWeekly, boxes: boxList };
          } catch(e) {}
        }
      } catch(e) {}
      return { found: false, lastDclDays: null, hasWeekly: false, boxes: [] };
    })()
  `), 8000, { found: false, lastDclDays: null, hasWeekly: false, boxes: [] });
}

// Classify cycle boxes returned by readCycleFromIndicator into DCL (green) / WCL (blue) windows.
// TradingView stores box colors as normalised RGB objects: { r:0-1, g:0-1, b:0-1, a:0-1 }
// Green window → g channel dominant   Blue window → b channel dominant
function parseCycleWindows(cycle) {
  if (!cycle || !cycle.found) return { dclWindow: null, wclWindow: null };

  let dclWindow = null;
  let wclWindow = null;

  for (const box of (cycle.boxes || [])) {
    if (!box.dateStart) continue;          // skip boxes with no resolvable date (past/offscreen)

    let isGreen = false;
    let isBlue  = false;

    try {
      const c = JSON.parse(box.color);
      if (c && typeof c.r === 'number') {
        isGreen = c.g > c.r && c.g > c.b;
        isBlue  = c.b > c.r && c.b > c.g;
      }
    } catch (_) {}

    // Fallback: hex/keyword heuristic
    if (!isGreen && !isBlue) {
      const s = (box.color || '').toLowerCase();
      isGreen = s.includes('089981') || s.includes('4caf50') || s.includes('00897b') || s.includes('"g":1');
      isBlue  = s.includes('2962ff') || s.includes('1565c0') || s.includes('1976d2') || s.includes('"b":1');
    }

    if (isGreen && !dclWindow) dclWindow = box;  // first future green box = next DCL window
    if (isBlue  && !wclWindow) wclWindow = box;  // first future blue  box = next WCL window
  }

  return { dclWindow, wclWindow };
}

// ── SOS / SOW: read most-recent signal from "Auto SOS/SOW V2" indicator ───────
// Data layout per bar: [timestamp, sos, sow, alert_sos, alert_sow]
// sos = 1  → green dot (Sign of Strength, bullish)
// sow = 1  → red dot   (Sign of Weakness, bearish)
// Scans backwards from the most recent bar to find the last fired signal.
async function readSOSSOWFromIndicator() {
  return await withTimeout(evaluate(`
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
          if (!items || !items.length) return { found: false, signal: null, reason: 'no-data' };

          // Scan last 300 bars backwards for most recent signal
          var limit = Math.max(0, items.length - 300);
          for (var i = items.length - 1; i >= limit; i--) {
            var item = items[i];
            if (!item) continue;
            var val = item.value;
            var p = Array.isArray(val) ? val : null;
            if (!p) { try { p = JSON.parse(val); } catch(e) {} }
            if (!p || p.length < 3) continue;
            var sos = p[1];  // plot_0 = SOS green dot
            var sow = p[2];  // plot_1 = SOW red dot
            if (sos === 1) return { found: true, signal: 'SOS', barIndex: i };
            if (sow === 1) return { found: true, signal: 'SOW', barIndex: i };
          }
          return { found: false, signal: null, reason: 'no-signal-in-300-bars' };
        }
      } catch(e) {}
      return { found: false, signal: null, reason: 'indicator-not-found' };
    })()
  `), 7000, { found: false, signal: null });
}

// ── Auto Metrics signals V4: read most-recent BUY / SELL signal ───────────────
// Data layout: [timestamp, ema1, colorer1, ema2, colorer2, SELL, BUY, ...]
// values[5] === 1 → SELL (red label)
// values[6] === 1 → BUY  (green label)
// Returns: { found, signal: 'BUY'|'SELL'|null, ts, dateLabel, barsAgo }
async function readAutoMetricsSignal(totalBars) {
  return await withTimeout(evaluate(`
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
          if (!items || !items.length) return { found: false, signal: null, reason: 'no-data' };

          var totalItems = items.length;

          // Scan last 500 bars backwards for most recent SELL or BUY
          var limit = Math.max(0, totalItems - 500);
          for (var i = totalItems - 1; i >= limit; i--) {
            var item = items[i];
            if (!item) continue;
            var val = item.value;
            var p = Array.isArray(val) ? val : null;
            if (!p) { try { p = JSON.parse(val); } catch(e) {} }
            if (!p || p.length < 7) continue;

            var sell = p[5];  // plot_4 = SELL
            var buy  = p[6];  // plot_5 = BUY
            if (sell === 1 || buy === 1) {
              var signal   = sell === 1 ? 'SELL' : 'BUY';
              var ts       = p[0];
              var d        = new Date(ts * 1000);
              var months   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              var dateLabel = months[d.getMonth()] + ' ' + d.getDate() + ' ' +
                              String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
              var barsAgo  = totalItems - 1 - i;
              return { found: true, signal: signal, ts: ts, dateLabel: dateLabel, barsAgo: barsAgo };
            }
          }
          return { found: false, signal: null, reason: 'no-signal-in-500-bars' };
        }
      } catch(e) {}
      return { found: false, signal: null, reason: 'indicator-not-found' };
    })()
  `), 7000, { found: false, signal: null });
}

// ── FIB 0.50: read "0.50" label y-coordinates from indicator ─────────────────
// The indicator draws labels with text "0.50" at the fib mid-level of each
// POI zone. Checks if price is within ±0.5% of any such level.
async function readFib50FromIndicator(price) {
  return await withTimeout(evaluate(`
    (function() {
      var price = ${price};
      var TOL   = ${FIB50_TOL};
      if (!price || isNaN(price)) return { hit: false, text: '—' };
      try {
        var chart   = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var sources = chart.model().model().dataSources();
        for (var si = 0; si < sources.length; si++) {
          var src = sources[si];
          if (!src.metaInfo) continue;
          var name = (src.metaInfo().description || '').toLowerCase();
          if (!name.includes('market structure')) continue;
          var pc = src._graphics._primitivesCollection;
          var coll = pc.dwglabels.get('labels').get(false);
          var hit = false, lvlText = '—';
          coll._primitivesDataById.forEach(function(v) {
            if (hit) return;
            if ((v.t || '') === '0.50' && v.y != null) {
              if (Math.abs(price - v.y) / v.y <= TOL) {
                hit = true;
                lvlText = '~' + v.y.toFixed(2);
              }
            }
          });
          return { hit: hit, text: lvlText };
        }
      } catch(e) {}
      return { hit: false, text: '—' };
    })()
  `), 5000, { hit: false, text: '—' });
}

// ── CHART OVERLAY RENDERER ────────────────────────────────────────────────────
async function renderChartPanel(rows, ts, fromCache) {
  const payload = JSON.stringify({ rows, ts, fromCache });

  await evaluate(`
    (function() {
      var old = document.getElementById('__angelo_hc_panel');
      if (old) old.remove();

      var data      = ${payload};
      var rows      = data.rows;
      var ts        = data.ts;
      var fromCache = data.fromCache;

      var bullList   = rows.filter(function(r){ return r.bull === true; });
      var bearList   = rows.filter(function(r){ return r.bull === false; });
      var poiList    = rows.filter(function(r){ return r.poiStage === 'AT POI'; });
      var retList    = rows.filter(function(r){ return r.poiStage === 'RETRACING'; });
      var fibList    = rows.filter(function(r){ return r.fibHit; });
      var hiLong     = rows.filter(function(r){ return r.poiStage === 'AT POI' && r.bull === true; });
      var hiShort    = rows.filter(function(r){ return r.poiStage === 'AT POI' && r.bull === false; });

      function el(tag, styles, text) {
        var e = document.createElement(tag);
        if (styles) Object.assign(e.style, styles);
        if (text !== undefined) e.textContent = text;
        return e;
      }
      function sectionTitle(label) {
        return el('div', {
          padding:'6px 12px 4px', fontSize:'10px', fontWeight:'700',
          color:'#787b86', letterSpacing:'0.8px', textTransform:'uppercase',
          borderTop:'1px solid #2a2e39', marginTop:'2px'
        }, label);
      }
      function chipGrid(list, chipColor) {
        var wrap = el('div', { display:'flex', flexWrap:'wrap', gap:'4px', padding:'4px 12px 8px' });
        list.forEach(function(r) {
          var chip = el('span', {
            background: chipColor + '22', border: '1px solid ' + chipColor + '55',
            color: chipColor, borderRadius: '4px', padding: '2px 6px',
            fontSize: '10px', fontWeight: '700', cursor: 'default',
          }, r.ticker);
          wrap.appendChild(chip);
        });
        if (!list.length) wrap.appendChild(el('span',{color:'#4a4e5a',fontSize:'10px'},'—'));
        return wrap;
      }

      var panel = el('div', {
        position:'fixed', top:'55px', right:'55px', zIndex:'99999',
        background:'#131722', border:'1px solid #2a2e39', borderRadius:'8px',
        fontFamily:'"Trebuchet MS",sans-serif', fontSize:'11px', color:'#d1d4dc',
        boxShadow:'0 4px 28px rgba(0,0,0,0.7)', width:'600px',
        userSelect:'none', overflow:'hidden',
      });
      panel.id = '__angelo_hc_panel';

      var hdr = el('div', {
        background:'#1e2230', padding:'8px 12px',
        display:'flex', justifyContent:'space-between', alignItems:'center',
        borderBottom:'1px solid #2a2e39', cursor:'move',
      });
      hdr.innerHTML =
        '<span style="color:#fff;font-weight:700;font-size:12px">📊 Angelo · Health Check 2026</span>' +
        '<span style="color:#787b86;font-size:10px">' + ts +
        (fromCache ? ' &nbsp;·&nbsp; ⚠ cached' : ' &nbsp;·&nbsp; live') + '</span>';
      var closeBtn = el('span',{marginLeft:'10px',cursor:'pointer',color:'#787b86',fontSize:'14px',fontWeight:'700'},'✕');
      closeBtn.onclick = function(){ panel.remove(); };
      hdr.appendChild(closeBtn);
      panel.appendChild(hdr);

      var statsRow = el('div',{
        display:'grid', gridTemplateColumns:'repeat(5,1fr)',
        gap:'1px', background:'#2a2e39', borderBottom:'1px solid #2a2e39',
      });
      [
        { label:'BULLISH',   val: bullList.length,              color:'#26a69a' },
        { label:'BEARISH',   val: bearList.length,              color:'#ef5350' },
        { label:'AT POI',    val: poiList.length,               color:'#f59e0b' },
        { label:'RETRACING', val: retList.length,               color:'#60a5fa' },
        { label:'HI-PRI',    val: hiLong.length + hiShort.length, color:'#fb923c' },
      ].forEach(function(s) {
        var card = el('div',{ background:'#131722', padding:'8px 4px', textAlign:'center' });
        card.appendChild(el('div',{fontSize:'18px',fontWeight:'700',color:s.color}, String(s.val)));
        card.appendChild(el('div',{fontSize:'9px',color:'#787b86',letterSpacing:'0.5px'}, s.label));
        statsRow.appendChild(card);
      });
      panel.appendChild(statsRow);

      var body = el('div',{ maxHeight:'520px', overflowY:'auto' });

      body.appendChild(sectionTitle('🟢 Bullish (' + bullList.length + ')'));
      body.appendChild(chipGrid(bullList, '#26a69a'));
      body.appendChild(sectionTitle('🔴 Bearish (' + bearList.length + ')'));
      body.appendChild(chipGrid(bearList, '#ef5350'));
      body.appendChild(sectionTitle('🎯 AT POI — Price Inside Zone (' + poiList.length + ')'));
      body.appendChild(chipGrid(poiList, '#f59e0b'));
      body.appendChild(sectionTitle('⏳ Retracing — Approaching POI (' + retList.length + ')'));
      body.appendChild(chipGrid(retList, '#60a5fa'));
      body.appendChild(sectionTitle('⚡ At Fib 0.50 (' + fibList.length + ')'));
      body.appendChild(chipGrid(fibList, '#a78bfa'));

      // ── Cycle DCL window section ──────────────────────────────────────────
      var dclNear = rows.filter(function(r){ return r.cycleDclWindowDate; });
      body.appendChild(sectionTitle('🔄 Cycle — Upcoming DCL Windows (' + dclNear.length + ')'));
      if (dclNear.length) {
        var cycleWrap = el('div',{ padding:'4px 12px 8px', display:'flex', flexDirection:'column', gap:'3px' });
        dclNear.forEach(function(r) {
          var wLabel = r.cycleHasWeekly ? ' <span style="color:#60a5fa;font-size:9px;font-weight:700">+W</span>' : '';
          var dclWin = r.cycleDclWindowDate
            ? ('<span style="color:#4ade80;font-weight:700">' + r.cycleDclWindowDate
               + (r.cycleDclWindowEnd ? ' – ' + r.cycleDclWindowEnd : '') + '</span>')
            : '—';
          var wclWin = r.cycleWclWindowDate
            ? (' &nbsp;·&nbsp; WCL <span style="color:#60a5fa;font-weight:700">' + r.cycleWclWindowDate
               + (r.cycleWclWindowEnd ? ' – ' + r.cycleWclWindowEnd : '') + '</span>')
            : '';
          var line = el('div',{ fontSize:'10px', color:'#d1d4dc' });
          line.innerHTML =
            '<span style="font-weight:700;color:#f59e0b">' + r.ticker + '</span>' +
            ' &nbsp;' +
            (r.cycleLastDcl ? '<span style="color:#94a3b8">' + r.cycleLastDcl + 'D' + '</span>' : '') +
            wLabel +
            ' &nbsp;→&nbsp; DCL ' + dclWin + wclWin;
          cycleWrap.appendChild(line);
        });
        body.appendChild(cycleWrap);
      } else {
        body.appendChild(el('div',{ padding:'4px 12px 8px', fontSize:'10px', color:'#4a4e5a' },'No DCL windows detected'));
      }

      var hiTotal = hiLong.length + hiShort.length;
      body.appendChild(sectionTitle('🔥 High Priority Setups (' + hiTotal + ')'));
      if (hiLong.length) {
        body.appendChild(el('div',{padding:'2px 12px 0',fontSize:'9px',color:'#787b86',fontWeight:'700'},'➡ LONG — Bullish BOS ↑ + AT POI'));
        body.appendChild(chipGrid(hiLong, '#26a69a'));
      }
      if (hiShort.length) {
        body.appendChild(el('div',{padding:'2px 12px 0',fontSize:'9px',color:'#787b86',fontWeight:'700'},'➡ SHORT — Bearish BOS ↓ + AT POI'));
        body.appendChild(chipGrid(hiShort, '#ef5350'));
      }
      if (!hiTotal) body.appendChild(el('div',{padding:'4px 12px 8px',fontSize:'10px',color:'#4a4e5a'},'No setups AT POI right now'));

      body.appendChild(sectionTitle('All Symbols'));
      var COL_TMPL = '55px 52px 62px 35px 82px 48px 100px 68px';
      var colHdr = el('div',{
        display:'grid', gridTemplateColumns: COL_TMPL,
        padding:'4px 12px', color:'#4a4e5a', fontSize:'9px',
        fontWeight:'700', letterSpacing:'0.5px', textTransform:'uppercase',
      });
      ['SYMBOL','PRICE','STRUCTURE','SWING','POI STAGE','FIB','CYCLE','EARNINGS'].forEach(function(h){
        colHdr.appendChild(el('div',{},h));
      });
      body.appendChild(colHdr);

      rows.forEach(function(r, i) {
        var row = el('div',{
          display:'grid', gridTemplateColumns: COL_TMPL,
          padding:'3px 10px', alignItems:'center',
          background: i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)',
        });
        row.onmouseover = function(){ row.style.background='rgba(41,98,255,0.08)'; };
        row.onmouseout  = function(){ row.style.background=i%2===0?'transparent':'rgba(255,255,255,0.02)'; };

        // SYMBOL
        row.appendChild(el('div',{fontWeight:'600',color:'#d1d4dc'},r.ticker));
        // PRICE
        row.appendChild(el('div',{color:'#d1d4dc'},r.price));

        // STRUCTURE — coloured dot + BOS label
        var ms = el('div',{display:'flex',alignItems:'center',gap:'4px'});
        var dot = el('span',{
          width:'7px',height:'7px',borderRadius:'50%',display:'inline-block',flexShrink:'0',
          background: r.bull===true?'#26a69a':r.bull===false?'#ef5350':'#787b86'
        });
        var lbl = el('span',{
          color:r.bull===true?'#26a69a':r.bull===false?'#ef5350':'#787b86',
          fontSize:'10px',fontWeight:'600'
        }, r.bosText || r.structure);
        ms.appendChild(dot); ms.appendChild(lbl);
        row.appendChild(ms);

        // SWING — HH / HL / LH / LL chip
        var swingColor = (r.lastSwingLabel === 'HH' || r.lastSwingLabel === 'HL') ? '#26a69a'
                       : (r.lastSwingLabel === 'LH' || r.lastSwingLabel === 'LL') ? '#ef5350'
                       : '#787b86';
        row.appendChild(el('div',{
          color: swingColor, fontSize:'10px', fontWeight: r.lastSwingLabel ? '700' : '400'
        }, r.lastSwingLabel || '—'));

        // POI STAGE — AT POI / RETRACING / MISSED / NO POI
        var poiColor = r.poiStage === 'AT POI'    ? '#f59e0b'
                     : r.poiStage === 'RETRACING' ? '#60a5fa'
                     : r.poiStage === 'MISSED'    ? '#ef5350'
                     : '#4a4e5a';
        row.appendChild(el('div',{color:poiColor,fontSize:'10px',fontWeight:r.poiStage==='AT POI'?'700':'400'},
          r.poiStage || 'NO POI'));

        // FIB 0.50
        row.appendChild(el('div',{color:r.fibHit?'#a78bfa':'#4a4e5a',fontSize:'10px',fontWeight:r.fibHit?'600':'400'},r.fib));

        // CYCLE — "48D+W → Jun 23" or "48D → Jun 23" or "—"
        var cycleCell = el('div',{ fontSize:'9px', lineHeight:'1.35' });
        if (r.cycleLastDcl) {
          var dclLine = document.createElement('div');
          dclLine.innerHTML =
            '<span style="color:#94a3b8">' + r.cycleLastDcl + 'D' + (r.cycleHasWeekly ? '</span><span style="color:#60a5fa">+W</span>' : '</span>') +
            (r.cycleDclWindowDate ? '<span style="color:#4ade80"> → ' + r.cycleDclWindowDate + '</span>' : '');
          cycleCell.appendChild(dclLine);
          if (r.cycleWclWindowDate) {
            var wclLine = document.createElement('div');
            wclLine.innerHTML = '<span style="color:#60a5fa">WCL ' + r.cycleWclWindowDate + '</span>';
            cycleCell.appendChild(wclLine);
          }
        } else {
          cycleCell.textContent = '—';
          cycleCell.style.color = '#4a4e5a';
        }
        row.appendChild(cycleCell);

        // EARNINGS
        var earnColor = r.earnDays===null ? '#4a4e5a'
                      : r.earnDays <= 3  ? '#ef5350'
                      : r.earnDays <= 7  ? '#f59e0b'
                      : r.earnDays <= 14 ? '#facc15'
                      : '#787b86';
        row.appendChild(el('div',{color:earnColor,fontSize:'9px',fontWeight:r.earnDays!==null&&r.earnDays<=14?'700':'400'},
          r.earnDate === '—' ? '—' : (r.earnDate + ' · ' + r.earnStr)
        ));
        body.appendChild(row);
      });

      panel.appendChild(body);

      var footer = el('div',{
        borderTop:'1px solid #2a2e39', padding:'5px 12px',
        color:'#4a4e5a', fontSize:'9px',
        display:'flex', justifyContent:'space-between',
      });
      footer.innerHTML =
        '<span>BOS ↑↓ · Swing HH/HL/LH/LL · POI = AT POI / RETRACING / MISSED</span>' +
        '<span>drag · scroll · ✕ to close</span>';
      panel.appendChild(footer);

      var drag=false,ox=0,oy=0;
      hdr.addEventListener('mousedown',function(e){ drag=true; ox=e.clientX-panel.offsetLeft; oy=e.clientY-panel.offsetTop; });
      document.addEventListener('mousemove',function(e){ if(!drag)return; panel.style.left=(e.clientX-ox)+'px'; panel.style.top=(e.clientY-oy)+'px'; panel.style.right='auto'; });
      document.addEventListener('mouseup',function(){ drag=false; });

      document.body.appendChild(panel);
    })();
  `);
}

// ── ENSURE MARKET STRUCTURE INDICATOR ────────────────────────────────────────
const MS_INDICATOR = 'Market Structure + BOS + POI';
const MS_MATCH     = 'market structure';

async function ensureMarketStructureIndicator() {
  // ── 1. Check if already on chart ───────────────────────────────────────────
  const studies = await withTimeout(evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        return chart.getAllStudies().map(function(s) {
          return { id: s.id, name: (s.name || s.title || '').toLowerCase() };
        });
      } catch(e) { return []; }
    })()`), 4000, []);

  const alreadyOn = (studies || []).some(s => s.name.includes(MS_MATCH));
  if (alreadyOn) {
    console.log('  ✅ Market Structure + BOS + POI already on chart');
    return;
  }

  console.log(`  📊 Opening "${MS_INDICATOR}" via Indicators search…`);

  // ── 2. Click the Indicators button ─────────────────────────────────────────
  await withTimeout(evaluate(`
    (function() {
      var btn =
        document.querySelector('[data-name="open-indicators-dialog"]') ||
        document.querySelector('[data-name="indicators"]') ||
        document.querySelector('[data-tooltip*="ndicator"]') ||
        document.querySelector('[title*="ndicator"]') ||
        Array.from(document.querySelectorAll('button,div[role="button"]')).find(function(el) {
          var lbl = (el.getAttribute('aria-label') || el.getAttribute('title') ||
                     el.getAttribute('data-tooltip') || '').toLowerCase();
          return lbl.includes('indicator');
        });
      if (btn) { btn.click(); return 'clicked'; }
      return 'not-found';
    })()`), 3000, null);

  await new Promise(r => setTimeout(r, 1500));

  // ── 3. Type "Market Structure" into the search box ─────────────────────────
  await withTimeout(evaluate(`
    (function() {
      var input =
        document.querySelector('input[data-name="search-bar-input"]') ||
        document.querySelector('[class*="searchBar"] input') ||
        document.querySelector('[class*="search-bar"] input') ||
        document.querySelector('[class*="SearchBar"] input') ||
        document.querySelector('input[placeholder*="earch"]');
      if (!input) return 'no-input';
      input.focus();
      var setter = Object.getOwnPropertyDescriptor(
                     window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Market Structure');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    })()`), 3000, null);

  await new Promise(r => setTimeout(r, 2000));

  // ── 4. Click the first result containing "market structure" ────────────────
  await withTimeout(evaluate(`
    (function() {
      var candidates = Array.from(
        document.querySelectorAll([
          '[class*="itemTitle"]',
          '[class*="item-title"]',
          '[class*="title"][class*="item"]',
          '[data-name*="item"] [class*="title"]',
          '[class*="listItem"] [class*="title"]',
          '[class*="ItemRow"] [class*="title"]',
          '[role="option"] span',
          '[class*="inner"] [class*="name"]',
        ].join(','))
      );
      var target = candidates.find(function(el) {
        return el.textContent.toLowerCase().includes('market structure');
      });
      if (!target) {
        target =
          document.querySelector('[class*="itemRow"]:first-child') ||
          document.querySelector('[role="option"]:first-child') ||
          document.querySelector('[class*="listItem"]:first-child');
      }
      if (target) {
        var row = target.closest('[role="option"]') ||
                  target.closest('[class*="itemRow"]') ||
                  target.closest('[class*="listItem"]') ||
                  target;
        row.click();
        return 'clicked';
      }
      return 'no-result';
    })()`), 3000, null);

  await new Promise(r => setTimeout(r, 1200));

  // ── 5. Close the dialog ─────────────────────────────────────────────────────
  await withTimeout(evaluate(`
    (function() {
      var close =
        document.querySelector('[data-name="close-button"]') ||
        document.querySelector('[aria-label="Close"]') ||
        Array.from(document.querySelectorAll('button')).find(function(b) {
          return (b.getAttribute('aria-label') || b.textContent || '').toLowerCase() === 'close';
        });
      if (close) { close.click(); return 'close-btn'; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return 'esc';
    })()`), 2000, null);

  await new Promise(r => setTimeout(r, 2000));

  // ── 6. Verify ───────────────────────────────────────────────────────────────
  const after = await withTimeout(evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        return chart.getAllStudies().map(function(s) {
          return (s.name || s.title || '').toLowerCase();
        });
      } catch(e) { return []; }
    })()`), 4000, []);

  if ((after || []).some(n => n.includes(MS_MATCH))) {
    console.log('  ✅ Market Structure + BOS + POI opened successfully');
  } else {
    console.log('  ⚠ Market Structure may not have loaded — verify on chart');
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
try {
  const health = await healthCheck();
  const ts     = new Date().toLocaleTimeString('en-US', { hour12: false });

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║  TV HEALTH CHECK  ·  ${ts}                         ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  CDP  : ${health.cdp_connected ? '✅ Connected' : '❌ Disconnected'}`);
  console.log(`  Chart: ${health.chart_symbol} @ ${health.chart_resolution}`);
  console.log(`  API  : ${health.api_available ? '✅ Available' : '❌ Unavailable'}`);

  if (!health.cdp_connected || !health.api_available) {
    console.log('\n  ❌ Cannot scan — TradingView not reachable.\n');
    process.exit(1);
  }

  // Save current symbol so we can restore it
  let origSymbol;
  try { origSymbol = (await getState()).symbol; } catch (_) {}

  // ── Load watchlist FIRST (before any UI changes that could hide the panel) ─
  console.log('\n  Loading watchlist…');
  let wl = await withTimeout(getWatchlist(), 30000, { count: 0, symbols: [] });
  let fromCache = false;

  if (!wl.count) {
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      wl = {
        count: cache.symbols.length,
        source: 'cache',
        symbols: cache.symbols.map(s => ({ symbol: s, last: null, change_percent: null }))
      };
      fromCache = true;
      console.log(`  ⚠ Live scrape returned 0 — using cache: ${wl.count} symbols`);
    } catch (_) {}
  } else {
    // Update watchlist cache with fresh symbols
    try {
      const cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      cache.symbols = wl.symbols.map(s => s.symbol);
      cache.updated = new Date().toISOString().slice(0, 10);
      writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (_) {}
    console.log(`  ✅ Live watchlist: ${wl.count} symbols`);
  }

  if (!wl.count) {
    console.log('\n  ❌ No symbols found in watchlist or cache\n');
    process.exit(1);
  }

  // ── Step 1: Switch to 1 Hour timeframe ────────────────────────────────────
  console.log('\n  Step 1: Switch to 1 Hour (1H) timeframe');
  try {
    await evaluate(`
      (function() {
        window.TradingViewApi._activeChartWidgetWV.value().setResolution('60', {});
      })()
    `);
    await new Promise(r => setTimeout(r, 2000));
    console.log('  ✅ Timeframe set to 1H');
  } catch (_) {
    console.log('  ⚠ Could not set timeframe — continuing with current TF');
  }

  // ── Step 2: Check Market Structure + BOS + POI indicator ──────────────────
  console.log('\n  Step 2: Check Market Structure + BOS + POI indicator');
  try {
    await ensureMarketStructureIndicator();
  } catch (_) {
    console.log('  ⚠ Could not verify indicator — continuing anyway');
  }

  // ── Step 3: Scan ──────────────────────────────────────────────────────────
  console.log('\n  Step 3: Scan watchlist symbols');
  console.log(`\n  Scanning ${wl.count} symbols${fromCache ? ' (cached watchlist)' : ' (live watchlist)'}…`);
  console.log('  Structure = BOS ↑ / BOS ↓ + swing labels (HH/LH/HL/LL) — swing_len=30\n');

  const results = [];

  for (const item of wl.symbols) {
    const fullSymbol = item.symbol;                                       // e.g. 'NYSE:HAL'
    const ticker     = fullSymbol.includes(':')
                       ? fullSymbol.split(':')[1]
                       : fullSymbol;                                      // e.g. 'HAL'
    const rawPrice   = parseFloat(item.last);
    process.stdout.write(`  → ${ticker.padEnd(8)}`);

    try {
      // ── Switch symbol directly (bypass waitForChartReady to avoid timeout) ──
      await withTimeout(evaluate(`
        (function() {
          window.TradingViewApi._activeChartWidgetWV.value().setSymbol(
            '${fullSymbol.replace(/'/g, "\\'")}', {}
          );
        })()
      `), 3000, null);

      // Wait for chart data to load
      await new Promise(r => setTimeout(r, SWITCH_MS));

      // ── Get current price from last OHLCV bar ─────────────────────────────
      let price = rawPrice;

      try {
        const ohlcv = await withTimeout(getOhlcv({ count: 5 }), 5000, null);
        if (ohlcv?.bars?.length >= 1) {
          const lastBar = ohlcv.bars[ohlcv.bars.length - 1];
          if (lastBar?.close && !isNaN(lastBar.close)) price = lastBar.close;
        }
      } catch (_) {}

      // ── Market Structure — read directly from indicator labels ─────────────
      let ms = await readMarketStructureFromIndicator();
      // If indicator returned no data, retry once after a short wait
      if (ms.label === 'NO DATA') {
        await new Promise(r => setTimeout(r, 3000));
        ms = await readMarketStructureFromIndicator();
      }

      // ── POI — read directly from indicator boxes ──────────────────────────
      const poi = await readPOIFromIndicator(price);

      // ── Fib 0.50 — read from "0.50" label y-coordinates ──────────────────
      const f50 = await readFib50FromIndicator(price);

      // ── SOS / SOW — Auto SOS/SOW V2 indicator ────────────────────────────
      const sosSowResult = await readSOSSOWFromIndicator();
      const sosSow = sosSowResult.signal || null;  // 'SOS' | 'SOW' | null

      // ── Auto Metrics signals V4 — BUY / SELL ─────────────────────────────
      const amResult    = await readAutoMetricsSignal();
      const amSignal    = amResult.signal    || null;   // 'BUY' | 'SELL' | null
      const amDate      = amResult.dateLabel || null;   // e.g. 'Apr 28 17:00'
      const amBarsAgo   = amResult.barsAgo   ?? null;

      // ── CF Cycle Trading Indicator ────────────────────────────────────────
      const cycleRaw              = await readCycleFromIndicator();
      const { dclWindow, wclWindow } = parseCycleWindows(cycleRaw);
      const cycleLastDcl          = cycleRaw.lastDclDays;       // e.g. 48
      const cycleHasWeekly        = cycleRaw.hasWeekly;         // true if W marker found
      const cycleDclWindowDate    = dclWindow?.dateStart || null;  // e.g. 'Jun 23'
      const cycleDclWindowEnd     = dclWindow?.dateEnd   || null;
      const cycleWclWindowDate    = wclWindow?.dateStart || null;
      const cycleWclWindowEnd     = wclWindow?.dateEnd   || null;

      // ── Earnings ──────────────────────────────────────────────────────────
      const ern = getEarnings(ticker);

      results.push({
        ticker,
        price:            fmt(price),
        structure:        ms.label,
        bull:             ms.bull,
        bosText:          ms.bosText,
        swingPhase:       ms.swingPhase,
        lastSwingLabel:   ms.lastSwingLabel,
        poi:              poi.text,
        poiHit:           poi.hit,
        poiStage:         poi.stage,
        poiTop:           poi.poiTop,
        poiBottom:        poi.poiBottom,
        fib50:            poi.fib50,
        fib:              f50.text,
        fibHit:           f50.hit,
        sosSow,
        amSignal,
        amDate,
        amBarsAgo,
        // Cycle fields
        cycleLastDcl,
        cycleHasWeekly,
        cycleDclWindowDate,
        cycleDclWindowEnd,
        cycleWclWindowDate,
        cycleWclWindowEnd,
        earnDate:         ern.date,
        earnDays:         ern.days,
        earnStr:          ern.daysStr,
      });

      const msStr    = ms.bull === true ? '🟢' : ms.bull === false ? '🔴' : '⚪';
      const swStr    = ms.lastSwingLabel ? ` [${ms.lastSwingLabel}]` : '';
      const poiStr   = poi.hit       ? ' 🎯 AT POI'
                     : poi.stage === 'RETRACING' ? ' ⏳ RETRACING'
                     : poi.stage === 'MISSED'    ? ' ❌ MISSED'    : '';
      const fibStr   = f50.hit ? ' ⚡0.50' : '';
      const sosStr   = sosSow === 'SOS' ? ' 🟩 SOS' : sosSow === 'SOW' ? ' 🟥 SOW' : '';
      const amStr    = amSignal === 'BUY' ? ` 🟢 BUY(${amDate})` : amSignal === 'SELL' ? ` 🔴 SELL(${amDate})` : '';
      const cycleStr = cycleLastDcl
        ? ` 🔄 ${cycleLastDcl}D${cycleHasWeekly ? '+W' : ''}${cycleDclWindowDate ? ` → DCL ${cycleDclWindowDate}` : ''}`
        : '';
      console.log(` ${msStr} ${ms.label.padEnd(8)}${swStr.padEnd(7)} ${poiStr}${fibStr}${sosStr}${amStr}${cycleStr}`);

    } catch (err) {
      const ern = getEarnings(ticker);
      results.push({
        ticker, price: '—', structure: 'ERROR', bull: null,
        poi: '—', poiHit: false, fib: '—', fibHit: false,
        earnDate: ern.date, earnDays: ern.days, earnStr: ern.daysStr,
      });
      console.log(` ⚠ ${err.message?.slice(0, 40) || 'unknown error'}`);
    }
  }

  // ── Restore original symbol ──────────────────────────────────────────────
  if (origSymbol) {
    try {
      await evaluate(`
        window.TradingViewApi._activeChartWidgetWV.value().setSymbol(
          '${origSymbol.replace(/'/g, "\\'")}', {}
        )
      `);
    } catch (_) {}
  }

  // ── Save scan results ─────────────────────────────────────────────────────
  try {
    writeFileSync(SCAN_CACHE, JSON.stringify({ results, ts, fromCache }, null, 2));
  } catch (_) {}

  // ── Render on-chart panel ─────────────────────────────────────────────────
  await renderChartPanel(results, ts, fromCache);

  // ── Console summary ───────────────────────────────────────────────────────
  const bullList      = results.filter(r => r.bull === true);
  const bearList      = results.filter(r => r.bull === false);
  const poiList       = results.filter(r => r.poiStage === 'AT POI');
  const retracingList = results.filter(r => r.poiStage === 'RETRACING');
  const missedList    = results.filter(r => r.poiStage === 'MISSED');
  const fibList       = results.filter(r => r.fibHit);
  const hiPriBull     = results.filter(r => r.poiStage === 'AT POI' && r.bull === true);
  const hiPriBear     = results.filter(r => r.poiStage === 'AT POI' && r.bull === false);
  const hiPriList     = [...hiPriBull, ...hiPriBear];

  function tickerStr(arr) { return arr.length ? arr.map(r => r.ticker).join(', ') : '—'; }

  console.log(`\n## 📊 Angelo · UOA Health Check — ${ts}${fromCache ? ' _(cached)_' : ''}\n`);

  const earningSoon = results
    .filter(r => r.earnDays !== null && r.earnDays >= 0 && r.earnDays <= 14)
    .sort((a,b) => a.earnDays - b.earnDays);

  console.log('| Category | Count | Tickers |');
  console.log('|----------|------:|---------|');
  console.log(`| 🟢 Bullish BOS ↑     | ${bullList.length}      | ${tickerStr(bullList)} |`);
  console.log(`| 🔴 Bearish BOS ↓     | ${bearList.length}      | ${tickerStr(bearList)} |`);
  console.log(`| 🎯 AT POI            | ${poiList.length}       | ${tickerStr(poiList)} |`);
  console.log(`| ⏳ Retracing to POI  | ${retracingList.length} | ${tickerStr(retracingList)} |`);
  console.log(`| ❌ Missed POI        | ${missedList.length}    | ${tickerStr(missedList)} |`);
  console.log(`| ⚡ At Fib 0.50       | ${fibList.length}       | ${tickerStr(fibList)} |`);
  console.log(`| 🔥 High Priority     | ${hiPriList.length}     | ${tickerStr(hiPriList)} |`);
  console.log(`| 📅 Earnings ≤14 days | ${earningSoon.length}   | ${tickerStr(earningSoon)} |`);

  // ── Cycle summary ─────────────────────────────────────────────────────────
  const cycleResults = results.filter(r => r.cycleLastDcl);
  if (cycleResults.length) {
    console.log(`\n### 🔄 Cycle Analysis\n`);
    console.log('| Ticker | Last DCL | Weekly? | Next DCL Window | Next WCL Window |');
    console.log('|--------|----------|:-------:|-----------------|-----------------|');
    cycleResults.forEach(r => {
      const lastDcl = `${r.cycleLastDcl}D`;
      const weekly  = r.cycleHasWeekly ? '✅ W' : '—';
      const dcl     = r.cycleDclWindowDate
        ? `🟩 ${r.cycleDclWindowDate}${r.cycleDclWindowEnd ? ' – ' + r.cycleDclWindowEnd : ''}`
        : '—';
      const wcl     = r.cycleWclWindowDate
        ? `🟦 ${r.cycleWclWindowDate}${r.cycleWclWindowEnd ? ' – ' + r.cycleWclWindowEnd : ''}`
        : '—';
      console.log(`| **${r.ticker}** | ${lastDcl} | ${weekly} | ${dcl} | ${wcl} |`);
    });
  }

  console.log(`\n### 🔥 High Priority Setups (Bullish BOS ↑ + AT POI) — ${hiPriList.length}\n`);
  console.log('| # | Ticker | Price | BOS | Swing | POI Zone |');
  console.log('|---|--------|-------|-----|-------|----------|');
  hiPriBull.forEach((r, i) =>
    console.log(`| ${i+1} | **${r.ticker}** | ${r.price} | 🟢 BOS ↑ | ${r.lastSwingLabel || '—'} | ${r.poi} |`)
  );
  hiPriBear.forEach((r, i) =>
    console.log(`| ${hiPriBull.length + i + 1} | **${r.ticker}** | ${r.price} | 🔴 BOS ↓ | ${r.lastSwingLabel || '—'} | ${r.poi} |`)
  );
  if (!hiPriList.length) console.log('| — | No setups AT POI right now | | | | |');

  console.log(`\n### 📅 Upcoming Earnings (next 30 days)\n`);
  console.log('| Ticker | Earnings Date | Days Away | Structure | Hi-Pri? |');
  console.log('|--------|--------------|:---------:|-----------|:-------:|');
  const earn30 = results
    .filter(r => r.earnDays !== null && r.earnDays >= 0 && r.earnDays <= 30)
    .sort((a,b) => a.earnDays - b.earnDays);
  earn30.forEach(r => {
    const ms  = r.bull === true ? '🟢 Bullish' : r.bull === false ? '🔴 Bearish' : `⚪ ${r.structure}`;
    const hi  = r.poiHit ? '🔥 Yes' : '—';
    const urg = r.earnDays <= 3 ? '🚨' : r.earnDays <= 7 ? '⚠️' : '📅';
    console.log(`| **${r.ticker}** | ${r.earnDate} | ${urg} ${r.earnStr} | ${ms} | ${hi} |`);
  });
  if (!earn30.length) console.log('| — | No earnings in next 30 days | | | |');

  const sosList  = results.filter(r => r.sosSow === 'SOS');
  const sowList  = results.filter(r => r.sosSow === 'SOW');
  console.log(`| 🟩 SOS (Sign of Strength) | ${sosList.length} | ${tickerStr(sosList)} |`);
  console.log(`| 🟥 SOW (Sign of Weakness) | ${sowList.length} | ${tickerStr(sowList)} |`);

  console.log(`\n### 📋 Full Watchlist Scan\n`);
  console.log('| Ticker | Price | BOS | Swing | POI Stage | Fib | Last DCL | Next DCL Window | SOS/SOW | Earnings |');
  console.log('|--------|------:|-----|-------|-----------|:---:|----------|-----------------|:-------:|----------|');
  results.forEach(r => {
    const bos     = r.bull === true  ? '🟢 BOS ↑'
                  : r.bull === false ? '🔴 BOS ↓'
                  : `⚪ ${r.structure}`;
    const sw      = r.lastSwingLabel || '—';
    const poi     = r.poiStage === 'AT POI'    ? `🎯 AT POI`
                  : r.poiStage === 'RETRACING' ? `⏳ RETRACING`
                  : r.poiStage === 'MISSED'    ? `❌ MISSED`
                  : '—';
    const fib     = r.fibHit ? `✅` : '—';
    const sos     = r.sosSow === 'SOS' ? '🟩 SOS' : r.sosSow === 'SOW' ? '🟥 SOW' : '—';
    const urg     = r.earnDays !== null && r.earnDays <= 3 ? '🚨' : r.earnDays !== null && r.earnDays <= 7 ? '⚠️' : '';
    const lastDcl = r.cycleLastDcl ? `${r.cycleLastDcl}D${r.cycleHasWeekly ? '+W' : ''}` : '—';
    const nxtDcl  = r.cycleDclWindowDate
                  ? `🟩 ${r.cycleDclWindowDate}${r.cycleDclWindowEnd ? ' – ' + r.cycleDclWindowEnd : ''}${r.cycleWclWindowDate ? ' · WCL ' + r.cycleWclWindowDate : ''}`
                  : '—';
    console.log(`| ${r.ticker} | ${r.price} | ${bos} | ${sw} | ${poi} | ${fib} | ${lastDcl} | ${nxtDcl} | ${sos} | ${urg}${r.earnDate} |`);
  });

  console.log('\n_Panel rendered on TradingView chart ✅_\n');
  process.exit(0);

} catch (e) {
  console.error('\n  ❌ Health check failed:', e.message);
  process.exit(1);
}
