#!/usr/bin/env node
/**
 * tv_panel.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggered by: tv_panel (Refresh Panel button on dashboard)
 *
 * Renders a floating overlay panel on the TradingView chart showing:
 *   • Health Check  — bullish/bearish, POI, Fib 0.50, high priority setups
 *   • Cycle Windows — In Daily/Weekly window now, next DCL ≤ 14 days
 *   • Earnings      — upcoming earnings within 30 days
 *
 * Reads from: scan_cache.json, cycle_cache.json, earnings_cache.json
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join }            from 'path';
import { fileURLToPath }            from 'url';
import { healthCheck }              from '../src/core/health.js';
import { evaluate }                 from '../src/connection.js';

process.on('unhandledRejection', () => {});

const __dirname       = dirname(fileURLToPath(import.meta.url));
const SCAN_CACHE      = join(__dirname, 'scan_cache.json');
const CYCLE_CACHE     = join(__dirname, 'cycle_cache.json');
const EARNINGS_CACHE  = join(__dirname, 'earnings_cache.json');

function loadCache(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null; }
  catch (_) { return null; }
}

// ── Build & inject the panel ───────────────────────────────────────────────────
async function renderChartPanel(scanCache, cycleCache, earningsCache) {
  const scanRows    = scanCache?.results   || [];
  const scanTs      = scanCache?.ts        || '—';
  const cycleRows   = cycleCache?.results  || [];
  const cycleTs     = cycleCache?.ts       || '—';
  const signals     = earningsCache?.signals  || {};
  const earningsMap = earningsCache?.earnings || {};
  const today       = new Date();
  today.setHours(0,0,0,0);

  // ── Health groups ────────────────────────────────────────────────────────────
  const bullList  = scanRows.filter(r => r.bull === true);
  const bearList  = scanRows.filter(r => r.bull === false);
  const poiList   = scanRows.filter(r => r.poiHit);
  const fibList   = scanRows.filter(r => r.fibHit);
  const hiLong    = scanRows.filter(r => r.poiHit && r.bull === true);
  const hiShort   = scanRows.filter(r => r.poiHit && r.bull === false);

  // ── Cycle groups ─────────────────────────────────────────────────────────────
  const inDaily   = cycleRows.filter(r => r.currentWin === 'daily');
  const inWeekly  = cycleRows.filter(r => r.currentWin === 'weekly');
  const soonDCL   = cycleRows
    .filter(r => r.daysToNextDCL != null && r.daysToNextDCL >= 0 && r.daysToNextDCL <= 14 && r.currentWin !== 'daily')
    .sort((a, b) => a.daysToNextDCL - b.daysToNextDCL);

  // ── Earnings (next 30 days) ───────────────────────────────────────────────────
  const earnRows = Object.entries(earningsMap)
    .map(([ticker, dateStr]) => {
      const d = new Date(dateStr);
      const days = Math.round((d - today) / 86400000);
      return { ticker, dateStr, days };
    })
    .filter(r => r.days >= 0 && r.days <= 30)
    .sort((a, b) => a.days - b.days);

  const payload = JSON.stringify({
    scanRows, scanTs, cycleTs,
    bullList, bearList, poiList, fibList, hiLong, hiShort,
    inDaily, inWeekly, soonDCL, earnRows,
  });

  await evaluate(`
    (function() {
      var old = document.getElementById('__angelo_hc_panel');
      if (old) old.remove();

      var data     = ${payload};
      var scanRows = data.scanRows;
      var scanTs   = data.scanTs;
      var cycleTs  = data.cycleTs;
      var bullList = data.bullList;
      var bearList = data.bearList;
      var poiList  = data.poiList;
      var fibList  = data.fibList;
      var hiLong   = data.hiLong;
      var hiShort  = data.hiShort;
      var inDaily  = data.inDaily;
      var inWeekly = data.inWeekly;
      var soonDCL  = data.soonDCL;
      var earnRows = data.earnRows;

      // ── Inject scrollbar CSS ──────────────────────────────────────────────────
      var styleTag = document.getElementById('__angelo_panel_css');
      if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = '__angelo_panel_css';
        styleTag.textContent =
          '.angelo-scroll::-webkit-scrollbar{width:6px}' +
          '.angelo-scroll::-webkit-scrollbar-track{background:#1a1d2a;border-radius:4px}' +
          '.angelo-scroll::-webkit-scrollbar-thumb{background:#c8cfe0;border-radius:4px}' +
          '.angelo-scroll::-webkit-scrollbar-thumb:hover{background:#ffffff}';
        document.head.appendChild(styleTag);
      }

      function el(tag, styles, text) {
        var e = document.createElement(tag);
        if (styles) Object.assign(e.style, styles);
        if (text !== undefined) e.textContent = text;
        return e;
      }

      function sectionTitle(label) {
        var d = el('div', {
          padding:'6px 12px 4px', fontSize:'10px', fontWeight:'700',
          color:'#787b86', letterSpacing:'0.8px', textTransform:'uppercase',
          borderTop:'1px solid #2a2e39', marginTop:'2px',
        }, label);
        return d;
      }

      function chipGrid(list, chipColor, labelFn) {
        var wrap = el('div', { display:'flex', flexWrap:'wrap', gap:'4px', padding:'4px 12px 8px' });
        list.forEach(function(r) {
          var label = labelFn ? labelFn(r) : r.ticker;
          var chip = el('span', {
            background: chipColor + '22', border: '1px solid ' + chipColor + '55',
            color: chipColor, borderRadius: '4px', padding: '2px 7px',
            fontSize: '10px', fontWeight: '700', cursor: 'default',
          }, label);
          wrap.appendChild(chip);
        });
        if (!list.length) wrap.appendChild(el('span',{color:'#4a4e5a',fontSize:'10px'},'—'));
        return wrap;
      }

      // ── Collapsible section builder ───────────────────────────────────────────
      function makeSection(icon, label, buildFn) {
        var wrapper = el('div', { borderTop:'2px solid #363a4a', marginTop:'2px' });

        // clickable header row
        var hdr = el('div', {
          display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'8px 12px', fontSize:'11px', fontWeight:'700',
          color:'#9ba3b2', background:'#1a1d2a',
          cursor:'pointer', userSelect:'none',
        });
        var titleSpan = document.createElement('span');
        titleSpan.textContent = icon + ' ' + label;
        var arrowSpan = el('span', {
          fontSize:'9px', color:'#787b86',
          transition:'transform 0.2s ease', display:'inline-block',
        }, '▼');
        hdr.appendChild(titleSpan);
        hdr.appendChild(arrowSpan);

        // scrollable content area
        var content = el('div', {
          maxHeight:'320px', overflowY:'auto', overflowX:'hidden',
        });
        content.className = 'angelo-scroll';
        buildFn(content);

        var open = true;
        hdr.addEventListener('click', function() {
          open = !open;
          if (open) {
            content.style.maxHeight = '320px';
            content.style.overflowY = 'auto';
            arrowSpan.style.transform = 'rotate(0deg)';
          } else {
            content.style.maxHeight = '0';
            content.style.overflowY = 'hidden';
            arrowSpan.style.transform = 'rotate(-90deg)';
          }
        });

        wrapper.appendChild(hdr);
        wrapper.appendChild(content);
        return wrapper;
      }

      // ── Panel container ───────────────────────────────────────────────────────
      var panel = el('div', {
        position:'fixed', top:'55px', right:'55px', zIndex:'99999',
        background:'#131722', border:'1px solid #2a2e39', borderRadius:'10px',
        fontFamily:'"Trebuchet MS",sans-serif', fontSize:'11px', color:'#d1d4dc',
        boxShadow:'0 6px 32px rgba(0,0,0,0.75)', width:'560px',
        userSelect:'none', overflow:'hidden',
      });
      panel.id = '__angelo_hc_panel';

      // ── Header ────────────────────────────────────────────────────────────────
      var hdr = el('div', {
        background:'#1e2230', padding:'9px 12px',
        display:'flex', alignItems:'center', justifyContent:'space-between',
        borderBottom:'1px solid #2a2e39', cursor:'move',
      });
      hdr.innerHTML =
        '<span style="color:#fff;font-weight:700;font-size:12px">📊 Angelo · UOA Watchlist 2026</span>' +
        '<span style="color:#787b86;font-size:10px">Health: ' + scanTs + ' &nbsp;|&nbsp; Cycle: ' + cycleTs + '</span>';
      var closeBtn = el('span',{marginLeft:'10px',cursor:'pointer',color:'#787b86',fontSize:'14px',fontWeight:'700'},'✕');
      closeBtn.onclick = function(){ panel.remove(); };
      hdr.appendChild(closeBtn);
      panel.appendChild(hdr);

      // ── Health stats row ──────────────────────────────────────────────────────
      var statsRow = el('div',{
        display:'grid', gridTemplateColumns:'repeat(5,1fr)',
        gap:'1px', background:'#2a2e39', borderBottom:'1px solid #2a2e39',
      });
      [
        { label:'BULLISH', val: bullList.length,              color:'#26a69a' },
        { label:'BEARISH', val: bearList.length,              color:'#ef5350' },
        { label:'AT POI',  val: poiList.length,               color:'#f59e0b' },
        { label:'AT 0.50', val: fibList.length,               color:'#a78bfa' },
        { label:'HI-PRI',  val: hiLong.length+hiShort.length, color:'#fb923c' },
      ].forEach(function(s) {
        var card = el('div',{ background:'#131722', padding:'8px 4px', textAlign:'center' });
        card.appendChild(el('div',{fontSize:'18px',fontWeight:'700',color:s.color}, String(s.val)));
        card.appendChild(el('div',{fontSize:'9px',color:'#787b86',letterSpacing:'0.5px'}, s.label));
        statsRow.appendChild(card);
      });
      panel.appendChild(statsRow);

      // ── Cycle stats row ───────────────────────────────────────────────────────
      var cycleStatsRow = el('div',{
        display:'grid', gridTemplateColumns:'repeat(3,1fr)',
        gap:'1px', background:'#2a2e39', borderBottom:'1px solid #2a2e39',
      });
      [
        { label:'IN DAILY WIN',  val: inDaily.length,  color:'#22c55e' },
        { label:'IN WEEKLY WIN', val: inWeekly.length, color:'#3b82f6' },
        { label:'DCL ≤ 14 DAYS', val: soonDCL.length,  color:'#eab308' },
      ].forEach(function(s) {
        var card = el('div',{ background:'#0d1117', padding:'7px 4px', textAlign:'center' });
        card.appendChild(el('div',{fontSize:'18px',fontWeight:'700',color:s.color}, String(s.val)));
        card.appendChild(el('div',{fontSize:'9px',color:'#787b86',letterSpacing:'0.5px'}, s.label));
        cycleStatsRow.appendChild(card);
      });
      panel.appendChild(cycleStatsRow);

      // ── ① HEALTH CHECK section ────────────────────────────────────────────────
      var hiTotal = hiLong.length + hiShort.length;
      panel.appendChild(makeSection('🏥', 'HEALTH CHECK', function(c) {
        c.appendChild(sectionTitle('🟢 Bullish (' + bullList.length + ')'));
        c.appendChild(chipGrid(bullList, '#26a69a'));

        c.appendChild(sectionTitle('🔴 Bearish (' + bearList.length + ')'));
        c.appendChild(chipGrid(bearList, '#ef5350'));

        c.appendChild(sectionTitle('🎯 At POI (' + poiList.length + ')'));
        c.appendChild(chipGrid(poiList, '#f59e0b'));

        c.appendChild(sectionTitle('〰 At Fib 0.50 / Golden Zone (' + fibList.length + ')'));
        c.appendChild(chipGrid(fibList, '#a78bfa'));

        c.appendChild(sectionTitle('🔥 High Priority Setups (' + hiTotal + ')'));
        if (hiLong.length) {
          c.appendChild(el('div',{padding:'2px 12px 0',fontSize:'9px',color:'#787b86',fontWeight:'700'},'⚡ LONG — Bullish + at POI'));
          c.appendChild(chipGrid(hiLong, '#26a69a'));
        }
        if (hiShort.length) {
          c.appendChild(el('div',{padding:'2px 12px 0',fontSize:'9px',color:'#787b86',fontWeight:'700'},'⚡ SHORT — Bearish + at POI'));
          c.appendChild(chipGrid(hiShort, '#ef5350'));
        }
        if (!hiTotal) {
          c.appendChild(el('div',{padding:'4px 12px 8px',fontSize:'10px',color:'#4a4e5a'},'None at POI right now'));
        }
        c.appendChild(el('div',{height:'6px'}));
      }));

      // ── ② CYCLE WINDOWS section ───────────────────────────────────────────────
      panel.appendChild(makeSection('🔄', 'CYCLE WINDOWS', function(c) {
        c.appendChild(sectionTitle('🟢 In Daily Window Now (' + inDaily.length + ')'));
        c.appendChild(chipGrid(inDaily, '#22c55e'));

        c.appendChild(sectionTitle('🔵 In Weekly Window Now (' + inWeekly.length + ')'));
        c.appendChild(chipGrid(inWeekly, '#3b82f6'));

        c.appendChild(sectionTitle('⚡ Next DCL ≤ 14 Days (' + soonDCL.length + ')'));
        c.appendChild(chipGrid(soonDCL, '#eab308', function(r) {
          return r.ticker + ' (' + r.daysToNextDCL + 'd)';
        }));
        c.appendChild(el('div',{height:'6px'}));
      }));

      // ── ③ EARNINGS section ────────────────────────────────────────────────────
      panel.appendChild(makeSection('📅', 'UPCOMING EARNINGS (next 30 days)', function(c) {
        if (!earnRows.length) {
          c.appendChild(el('div',{padding:'8px 12px',fontSize:'10px',color:'#4a4e5a'},'No earnings in next 30 days'));
          return;
        }
        var earnHdr = el('div',{
          display:'grid', gridTemplateColumns:'80px 1fr 80px',
          padding:'4px 12px', color:'#4a4e5a', fontSize:'9px',
          fontWeight:'700', letterSpacing:'0.5px', textTransform:'uppercase',
        });
        ['TICKER','DATE','DAYS'].forEach(function(h) { earnHdr.appendChild(el('div',{},h)); });
        c.appendChild(earnHdr);

        earnRows.forEach(function(r, i) {
          var urgency = r.days <= 3 ? '#f97316' : r.days <= 7 ? '#eab308' : '#6b7280';
          var row = el('div',{
            display:'grid', gridTemplateColumns:'80px 1fr 80px',
            padding:'4px 12px', alignItems:'center',
            background: i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)',
          });
          row.onmouseover = function(){ row.style.background='rgba(41,98,255,0.08)'; };
          row.onmouseout  = function(){ row.style.background=i%2===0?'transparent':'rgba(255,255,255,0.02)'; };
          row.appendChild(el('div',{fontWeight:'700',color:'#d1d4dc'},r.ticker));
          row.appendChild(el('div',{color:'#9ba3b2',fontSize:'10px'},r.dateStr));
          row.appendChild(el('div',{fontWeight:'700',fontSize:'10px',color:urgency},
            r.days <= 3 ? '🔥 ' + r.days + 'd' : r.days <= 7 ? '⚡ ' + r.days + 'd' : r.days + 'd'));
          c.appendChild(row);
        });
        c.appendChild(el('div',{height:'6px'}));
      }));

      // ── Footer ────────────────────────────────────────────────────────────────
      var footer = el('div',{
        borderTop:'1px solid #2a2e39', padding:'5px 12px',
        color:'#4a4e5a', fontSize:'9px',
        display:'flex', justifyContent:'space-between',
      });
      footer.innerHTML =
        '<span>Market Structure + CF Cycle + Earnings</span>' +
        '<span>drag &nbsp;·&nbsp; scroll &nbsp;·&nbsp; ✕ to close</span>';
      panel.appendChild(footer);

      // ── Drag ─────────────────────────────────────────────────────────────────
      var drag=false, ox=0, oy=0;
      hdr.addEventListener('mousedown',function(e){ drag=true; ox=e.clientX-panel.offsetLeft; oy=e.clientY-panel.offsetTop; });
      document.addEventListener('mousemove',function(e){ if(!drag)return; panel.style.left=(e.clientX-ox)+'px'; panel.style.top=(e.clientY-oy)+'px'; panel.style.right='auto'; });
      document.addEventListener('mouseup',function(){ drag=false; });

      document.body.appendChild(panel);
    })();
  `);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
try {
  const health = await healthCheck();
  if (!health.cdp_connected) {
    console.log('❌ Cannot render panel — TradingView not reachable.');
    process.exit(1);
  }

  const scanCache     = loadCache(SCAN_CACHE);
  const cycleCache    = loadCache(CYCLE_CACHE);
  const earningsCache = loadCache(EARNINGS_CACHE);

  if (!scanCache) {
    console.log('⚠  No health scan cache — panel will show cycle & earnings only');
  }
  if (!cycleCache) {
    console.log('⚠  No cycle cache — run Cycle Scan to populate cycle windows');
  }
  if (!earningsCache) {
    console.log('⚠  No earnings cache — earnings section will be empty');
  }

  await renderChartPanel(scanCache, cycleCache, earningsCache);

  const scanCount  = scanCache?.results?.length  || 0;
  const cycleCount = cycleCache?.results?.length || 0;
  const earnCount  = Object.keys(earningsCache?.earnings || {}).length;

  console.log('✅ Panel rendered on TradingView chart');
  console.log(`   🏥 Health: ${scanCount} symbols  ·  ts: ${scanCache?.ts || '—'}`);
  console.log(`   🔄 Cycle:  ${cycleCount} symbols  ·  ts: ${cycleCache?.ts || '—'}`);
  console.log(`   📅 Earnings: ${earnCount} symbols in cache`);
  process.exit(0);

} catch (e) {
  console.error('❌ tv_panel failed:', e.message);
  process.exit(1);
}
