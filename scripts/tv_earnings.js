#!/usr/bin/env node
/**
 * tv_earnings.js  (v2 — watchlist-complete rewrite)
 * ─────────────────────────────────────────────────────────────────────────────
 * Triggered by: tv_earnings
 *
 * Shows upcoming earnings for ALL watchlist symbols.
 * Uses earnings_cache.json for dates.
 * Optionally merges market structure from scan_cache.json if available.
 * Renders floating panel + current-symbol badge on TradingView chart.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { healthCheck }  from '../src/core/health.js';
import { getState }     from '../src/core/chart.js';
import { evaluate }     from '../src/connection.js';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const EARNINGS_FILE  = join(__dirname, 'earnings_cache.json');
const SCAN_CACHE     = join(__dirname, 'scan_cache.json');
const WL_CACHE       = join(__dirname, 'watchlist_cache.json');

process.on('unhandledRejection', () => {});

function daysUntil(dateStr) {
  if (!dateStr || dateStr === 'N/A') return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const eDate = new Date(dateStr); eDate.setHours(0,0,0,0);
  return Math.round((eDate - today) / 86400000);
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (_) { return '—'; }
}

function daysStr(days) {
  if (days === null) return '—';
  if (days < 0)  return 'passed';
  if (days === 0) return 'TODAY';
  return `${days}d`;
}

try {
  const health = await healthCheck();
  if (!health.cdp_connected) {
    console.log('❌ TradingView not reachable.');
    process.exit(1);
  }

  // ── Load earnings and signals maps ─────────────────────────────────────────
  let earningsMap = {};
  let signalsMap  = {};
  try {
    const ec = JSON.parse(readFileSync(EARNINGS_FILE, 'utf-8'));
    earningsMap = ec.earnings  || {};
    signalsMap  = ec.signals   || {};
  } catch (_) {}

  // ── Load full watchlist (to include ALL tickers, not just those with earnings) ─
  let allTickers = [];
  try {
    const wl = JSON.parse(readFileSync(WL_CACHE, 'utf-8'));
    allTickers = (wl.symbols || []).map(s => s.includes(':') ? s.split(':')[1] : s);
  } catch (_) {}

  // Fallback: use whatever's in earningsMap
  if (!allTickers.length) {
    allTickers = Object.keys(earningsMap);
  }

  // ── Load structure/POI from last health scan (if available) ────────────────
  const structureMap = {};
  const poiMap       = {};
  try {
    const sc = JSON.parse(readFileSync(SCAN_CACHE, 'utf-8'));
    (sc.results || []).forEach(r => {
      structureMap[r.ticker] = { bull: r.bull, structure: r.structure };
      poiMap[r.ticker]       = r.poiHit;
    });
  } catch (_) {}

  // ── Get current chart symbol ───────────────────────────────────────────────
  let currentSymbol = '';
  try {
    const state = await getState();
    currentSymbol = (state?.symbol || '').replace(/^.*?:/, '');
  } catch (_) {}

  // ── Build all rows from full watchlist ────────────────────────────────────
  const allRows = allTickers.map(ticker => {
    const earnDateStr  = earningsMap[ticker];
    const sigDateStr   = signalsMap[ticker];
    const days         = daysUntil(earnDateStr);
    const st           = structureMap[ticker] || { bull: null, structure: '—' };
    const sigFmt       = sigDateStr
      ? new Date(sigDateStr).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
      : '—';

    return {
      ticker,
      earnDate:   earnDateStr  ? fmtDate(earnDateStr)  : '—',
      earnDays:   days,
      earnStr:    daysStr(days),
      signalDate: sigFmt,
      bull:       st.bull,
      structure:  st.structure,
      poiHit:     poiMap[ticker] || false,
    };
  });

  // ── Upcoming = next 90 days, sorted by urgency ─────────────────────────────
  const upcoming = allRows
    .filter(r => r.earnDays !== null && r.earnDays >= 0 && r.earnDays <= 90)
    .sort((a,b) => a.earnDays - b.earnDays);

  // ── Unknown = no earnings date in cache ───────────────────────────────────
  const noDate = allRows.filter(r => r.earnDays === null);

  // ── Current symbol lookup ─────────────────────────────────────────────────
  const currentEarnDateStr = earningsMap[currentSymbol];
  const currentDays = daysUntil(currentEarnDateStr);
  const currentFmt  = fmtDate(currentEarnDateStr);

  const payload = JSON.stringify({ currentSymbol, currentFmt, currentDays, upcoming, noDate });

  // ── Inject panel into TradingView ─────────────────────────────────────────
  await evaluate(`
    (function() {
      ['__angelo_earn_badge','__angelo_earn_panel'].forEach(function(id){
        var old = document.getElementById(id); if(old) old.remove();
      });

      var d        = ${payload};
      var sym      = d.currentSymbol;
      var cDate    = d.currentFmt;
      var cDays    = d.currentDays;
      var upcoming = d.upcoming;
      var noDate   = d.noDate;

      function el(tag, styles, text) {
        var e = document.createElement(tag);
        if (styles) Object.assign(e.style, styles);
        if (text !== undefined) e.textContent = text;
        return e;
      }

      // ── CURRENT SYMBOL BADGE ─────────────────────────────────────────────
      if (sym) {
        var badgeColor = cDays === null ? '#787b86'
                       : cDays === 0   ? '#ef5350'
                       : cDays <= 3   ? '#ef5350'
                       : cDays <= 7   ? '#f59e0b'
                       : cDays <= 14  ? '#facc15'
                       : '#26a69a';
        var badgeText  = cDays === null ? ('📊 ' + sym + ' — earnings date unknown')
                       : cDays === 0   ? ('🚨 ' + sym + ' EARNINGS TODAY')
                       : cDays < 0    ? ('📊 ' + sym + ' — earnings already passed')
                       : ('📅 ' + sym + ' earnings: ' + cDate + ' (' + cDays + ' days)');
        var badge = el('div', {
          position:'fixed', bottom:'60px', left:'50%', transform:'translateX(-50%)',
          zIndex:'99999', background:'#131722', border:'2px solid ' + badgeColor,
          borderRadius:'8px', padding:'8px 18px',
          fontFamily:'"Trebuchet MS",sans-serif',
          fontSize:'13px', fontWeight:'700', color: badgeColor,
          boxShadow:'0 4px 20px rgba(0,0,0,0.7)', cursor:'pointer',
          whiteSpace:'nowrap',
        }, badgeText);
        badge.id = '__angelo_earn_badge';
        badge.onclick = function() { badge.remove(); };
        document.body.appendChild(badge);
        setTimeout(function(){ if(badge.parentNode) badge.remove(); }, 10000);
      }

      // ── EARNINGS PANEL ───────────────────────────────────────────────────
      var panel = el('div', {
        position:'fixed', top:'55px', left:'55px', zIndex:'99998',
        background:'#131722', border:'1px solid #2a2e39', borderRadius:'8px',
        fontFamily:'"Trebuchet MS",sans-serif', fontSize:'11px', color:'#d1d4dc',
        boxShadow:'0 4px 28px rgba(0,0,0,0.7)', width:'560px',
        userSelect:'none', overflow:'hidden',
      });
      panel.id = '__angelo_earn_panel';

      // Header
      var hdr = el('div', {
        background:'#1e2230', padding:'8px 12px',
        display:'flex', justifyContent:'space-between', alignItems:'center',
        borderBottom:'1px solid #2a2e39', cursor:'move',
      });
      hdr.innerHTML =
        '<span style="color:#fff;font-weight:700;font-size:12px">📅 Upcoming Earnings — Angelo Watchlist</span>' +
        '<span style="color:#787b86;font-size:10px">next 90 days · ' + upcoming.length + ' events</span>';
      var closeBtn = el('span',{marginLeft:'10px',cursor:'pointer',color:'#787b86',fontSize:'14px',fontWeight:'700'},'✕');
      closeBtn.onclick = function(){ panel.remove(); };
      hdr.appendChild(closeBtn);
      panel.appendChild(hdr);

      // Stat bar
      var urgent = upcoming.filter(function(r){ return r.earnDays <= 7; }).length;
      var soon   = upcoming.filter(function(r){ return r.earnDays > 7 && r.earnDays <= 14; }).length;
      var statsBar = el('div',{
        display:'grid', gridTemplateColumns:'repeat(4,1fr)',
        gap:'1px', background:'#2a2e39', borderBottom:'1px solid #2a2e39',
      });
      [
        { label:'🚨 URGENT ≤7d',  val: urgent,            color:'#ef5350' },
        { label:'⚠️ SOON ≤14d',   val: soon,              color:'#f59e0b' },
        { label:'📅 NEXT 90 DAYS', val: upcoming.length,   color:'#26a69a' },
        { label:'❓ DATE UNKNOWN', val: noDate.length,     color:'#787b86' },
      ].forEach(function(s) {
        var card = el('div',{ background:'#131722', padding:'7px 4px', textAlign:'center' });
        card.appendChild(el('div',{fontSize:'16px',fontWeight:'700',color:s.color}, String(s.val)));
        card.appendChild(el('div',{fontSize:'9px',color:'#787b86',letterSpacing:'0.5px'}, s.label));
        statsBar.appendChild(card);
      });
      panel.appendChild(statsBar);

      // Table
      var body = el('div',{ maxHeight:'500px', overflowY:'auto' });

      var colHdr = el('div',{
        display:'grid', gridTemplateColumns:'60px 70px 55px 90px 60px 50px',
        padding:'5px 12px', color:'#4a4e5a', fontSize:'9px',
        fontWeight:'700', letterSpacing:'0.5px', textTransform:'uppercase',
        borderBottom:'1px solid #2a2e39',
        position:'sticky', top:'0', background:'#1a1d2a', zIndex:'1',
      });
      ['SIGNAL','TICKER','STRUCT','EARNINGS','DAYS','HI-PRI'].forEach(function(h){
        colHdr.appendChild(el('div',{},h));
      });
      body.appendChild(colHdr);

      upcoming.forEach(function(r, i) {
        var earnColor = r.earnDays === 0  ? '#ef5350'
                      : r.earnDays <= 3  ? '#ef5350'
                      : r.earnDays <= 7  ? '#f59e0b'
                      : r.earnDays <= 14 ? '#facc15'
                      : '#787b86';
        var msColor   = r.bull === true  ? '#26a69a'
                      : r.bull === false ? '#ef5350'
                      : '#787b86';
        var msLabel   = r.bull === true  ? '🟢 Bull'
                      : r.bull === false ? '🔴 Bear'
                      : r.structure === '—' ? '—' : '⚪ Mix';
        var urgency   = r.earnDays === 0 ? '🚨' : r.earnDays <= 3 ? '🚨' : r.earnDays <= 7 ? '⚠️' : '📅';
        var highlight = r.ticker === sym;

        var row = el('div',{
          display:'grid', gridTemplateColumns:'60px 70px 55px 90px 60px 50px',
          padding:'4px 12px', alignItems:'center',
          background: highlight ? 'rgba(41,98,255,0.15)' : i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)',
          borderLeft: highlight ? '3px solid #2962ff' : '3px solid transparent',
        });
        row.onmouseover = function(){ row.style.background='rgba(41,98,255,0.08)'; };
        row.onmouseout  = function(){ row.style.background = highlight ? 'rgba(41,98,255,0.15)' : i%2===0?'transparent':'rgba(255,255,255,0.02)'; };

        row.appendChild(el('div',{color:'#a78bfa',fontSize:'9px'}, r.signalDate || '—'));
        row.appendChild(el('div',{fontWeight:'700',color: highlight ? '#fff' : '#d1d4dc',fontSize:'11px'}, r.ticker + (highlight ? ' ◀' : '')));
        row.appendChild(el('div',{color:msColor,fontSize:'9px',fontWeight:'600'}, msLabel));
        row.appendChild(el('div',{color:'#d1d4dc',fontSize:'10px'}, r.earnDate));
        row.appendChild(el('div',{
          color:earnColor,fontWeight:'700',fontSize:'10px',
        }, urgency + ' ' + r.earnStr));
        row.appendChild(el('div',{color:r.poiHit?'#fb923c':'#4a4e5a',fontSize:'10px'}, r.poiHit ? '🔥 Yes' : '—'));
        body.appendChild(row);
      });

      if (!upcoming.length) {
        body.appendChild(el('div',{padding:'16px',color:'#4a4e5a',textAlign:'center',fontSize:'12px'},
          'No earnings in next 90 days'));
      }

      // Unknown dates section
      if (noDate.length) {
        var unkHdr = el('div',{
          padding:'5px 12px', color:'#4a4e5a', fontSize:'9px',
          fontWeight:'700', letterSpacing:'0.5px', textTransform:'uppercase',
          borderTop:'1px solid #2a2e39', background:'#131722',
        }, '❓ Earnings date unknown (' + noDate.length + ')');
        body.appendChild(unkHdr);

        var unkWrap = el('div',{ display:'flex', flexWrap:'wrap', gap:'4px', padding:'6px 12px 10px' });
        noDate.forEach(function(r) {
          var chip = el('span',{
            background:'#2a2e3922', border:'1px solid #3a3e4a',
            color:'#787b86', borderRadius:'4px', padding:'2px 6px',
            fontSize:'10px', fontWeight:'600',
          }, r.ticker);
          unkWrap.appendChild(chip);
        });
        body.appendChild(unkWrap);
      }

      panel.appendChild(body);

      var footer = el('div',{
        borderTop:'1px solid #2a2e39', padding:'5px 12px',
        color:'#4a4e5a', fontSize:'9px', textAlign:'center',
      }, 'Badge auto-hides · drag panel · scroll · ✕ to close · run Health Check for structure data');
      panel.appendChild(footer);

      // Drag
      var drag=false,ox=0,oy=0;
      hdr.addEventListener('mousedown',function(e){ drag=true; ox=e.clientX-panel.offsetLeft; oy=e.clientY-panel.offsetTop; });
      document.addEventListener('mousemove',function(e){ if(!drag)return; panel.style.left=(e.clientX-ox)+'px'; panel.style.top=(e.clientY-oy)+'px'; });
      document.addEventListener('mouseup',function(){ drag=false; });

      document.body.appendChild(panel);
    })();
  `);

  // ── Console summary ────────────────────────────────────────────────────────
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`\n## 📅 Earnings Report — ${ts}\n`);

  if (currentSymbol) {
    const urg = currentDays === null ? '' : currentDays <= 3 ? ' 🚨' : currentDays <= 7 ? ' ⚠️' : '';
    console.log(`**On chart now: ${currentSymbol}** — Earnings: ${currentFmt} (${
      currentDays !== null ? currentDays+'d away' : 'date not in cache'
    })${urg}\n`);
  }

  console.log(`**Upcoming (next 90 days): ${upcoming.length} events**\n`);
  console.log('| Signal Date | Ticker | Structure | Earnings Date | Days Away | Hi-Pri |');
  console.log('|------------|--------|-----------|--------------|:---------:|:------:|');
  upcoming.forEach(r => {
    const ms  = r.bull === true ? '🟢 Bullish' : r.bull === false ? '🔴 Bearish' : `⚪ —`;
    const urg = r.earnDays === 0 ? '🚨' : r.earnDays <= 3 ? '🚨' : r.earnDays <= 7 ? '⚠️' : '📅';
    const hi  = r.poiHit ? '🔥 Yes' : '—';
    const cur = r.ticker === currentSymbol ? ' ◀ **CURRENT**' : '';
    console.log(`| ${r.signalDate || '—'} | **${r.ticker}**${cur} | ${ms} | ${r.earnDate} | ${urg} ${r.earnStr} | ${hi} |`);
  });

  if (!upcoming.length) {
    console.log('| — | No earnings in next 90 days | | | | |');
  }

  if (noDate.length) {
    console.log(`\n**❓ No earnings date cached (${noDate.length}):** ${noDate.map(r => r.ticker).join(', ')}`);
    console.log('_Update earnings_cache.json to add dates for these tickers_');
  }

  console.log('\n_Earnings panel + badge rendered on chart ✅_\n');
  process.exit(0);

} catch(e) {
  console.error('❌ tv_earnings failed:', e.message);
  process.exit(1);
}
