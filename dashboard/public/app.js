/* ── TradingView Dashboard · app.js ─────────────────────────────────────── */
'use strict';

const WS_URL = `ws://${location.host}`;

let ws           = null;
let cycleRows    = [];
let healthRows   = [];
let earningsData = null;
let cycleFilter  = 'all';
let healthFilter = 'all';
let tvOnline     = false;

// ── Progress bar state ─────────────────────────────────────────────────────
const SCAN_COMMANDS = new Set(['tv_health_check', 'tv_cycle']);
let prog = {
  cmd:   null,
  total: 55,
  done:  0,
  chips: [],   // { ticker, cls }
  hideTimer: null,
};

const CMD_LABEL = {
  tv_health_check: '🏥 Health Check scanning',
  tv_cycle:        '🔄 Cycle Scan scanning',
  tv_earnings:     '📅 Loading Earnings…',
  tv_panel:        '📊 Refreshing Panel…',
};

// ── WebSocket ──────────────────────────────────────────────────────────────
function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('green', 'Connected');
    ws.send(JSON.stringify({ type: 'get_cache', key: 'cycle'    }));
    ws.send(JSON.stringify({ type: 'get_cache', key: 'scan'     }));
    ws.send(JSON.stringify({ type: 'get_cache', key: 'earnings' }));
    loadWatchlist();
  };

  ws.onclose = () => {
    setStatus('grey', 'Reconnecting…');
    setTimeout(connect, 3000);
  };

  ws.onerror = () => setStatus('grey', 'Connection Error');

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    handleMessage(msg);
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'start':
      setRunning(msg.command, true);
      appendLog(`\n▶  ${msg.command} started…\n`, 'log-start');
      progressStart(msg.command);
      break;
    case 'stdout':
      appendLog(msg.text, 'log-stdout');
      progressParseLine(msg.command, msg.text);
      break;
    case 'stderr':
      if (msg.text.trim()) appendLog(msg.text, 'log-err');
      break;
    case 'done':
      setRunning(msg.command, false);
      appendLog(`\n✅  ${msg.command} finished (exit ${msg.code})\n`, 'log-done');
      progressComplete(msg.command, msg.code);
      break;
    case 'stopped':
      setRunning(msg.command, false);
      appendLog(`\n⏹  ${msg.command} stopped\n`, 'log-err');
      progressHide();
      break;
    case 'cache':
      if (msg.cacheKey === 'cycle' && msg.data?.results)
        renderCycleTable(msg.data.results, msg.data.ts);
      if (msg.cacheKey === 'scan' && msg.data?.results)
        renderHealthTable(msg.data.results, msg.data.ts);
      if (msg.cacheKey === 'earnings' && msg.data)
        renderEarningsTable(msg.data);
      break;
    case 'tv_status':
      setTVStatus(msg.online);
      break;
    case 'error':
      appendLog(`\n❌  ${msg.text}\n`, 'log-err');
      break;
  }
}

// ── Progress bar ───────────────────────────────────────────────────────────
function progressStart(cmd) {
  if (prog.hideTimer) { clearTimeout(prog.hideTimer); prog.hideTimer = null; }

  prog = { cmd, total: 55, done: 0, chips: [], hideTimer: null };

  const bar = document.getElementById('scan-progress');
  bar.classList.remove('hidden', 'complete');

  document.getElementById('progress-label').textContent =
    CMD_LABEL[cmd] || `${cmd} running…`;
  document.getElementById('progress-ticker-now').textContent = '—';
  document.getElementById('progress-count').textContent = '0 / 55';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-chips').innerHTML = '';
}

function progressParseLine(cmd, text) {
  if (cmd !== prog.cmd) return;

  // Detect total: "Scanning 55 symbols…"
  const totMatch = text.match(/Scanning (\d+) symbols/i);
  if (totMatch) {
    prog.total = parseInt(totMatch[1]);
    _updateProgressUI();
  }

  // Detect each ticker line: "  → HAL     🟢 BULLISH …"
  const lines = text.split('\n');
  for (const line of lines) {
    const arrowMatch = line.match(/→\s+([A-Z0-9]+)/);
    if (!arrowMatch) continue;

    const ticker = arrowMatch[1];
    prog.done++;

    // Determine result colour from the emoji on that line
    let cls = 'p-chip-mix';
    let icon = '⚪';
    if (line.includes('🟢')) { cls = 'p-chip-bull'; icon = '🟢'; }
    else if (line.includes('🔴')) { cls = 'p-chip-bear'; icon = '🔴'; }
    else if (line.includes('⚠'))  { cls = 'p-chip-err';  icon = '⚠'; }

    prog.chips.push({ ticker, cls, icon });
    _updateProgressUI(ticker);
  }
}

function _updateProgressUI(currentTicker) {
  const pct = prog.total > 0
    ? Math.min(100, Math.round((prog.done / prog.total) * 100))
    : 0;

  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-count').textContent =
    `${prog.done} / ${prog.total} symbols`;

  if (currentTicker) {
    document.getElementById('progress-ticker-now').textContent = currentTicker;
    document.getElementById('progress-label').textContent =
      (CMD_LABEL[prog.cmd] || prog.cmd) + '…  ' + pct + '%';
  }

  // Show the latest chips (up to 3 rows ≈ 30 chips)
  const recent = prog.chips.slice(-32);
  document.getElementById('progress-chips').innerHTML = recent.map(c =>
    `<span class="p-chip ${c.cls}">${c.icon} ${c.ticker}</span>`
  ).join('');
}

function progressComplete(cmd, code) {
  if (cmd !== prog.cmd) return;

  const bar   = document.getElementById('scan-progress');
  const ok    = code === 0 || code === null;
  const label = ok
    ? `✅ ${CMD_LABEL[cmd] || cmd} — done! (${prog.done} symbols)`
    : `❌ ${CMD_LABEL[cmd] || cmd} — error (exit ${code})`;

  document.getElementById('progress-fill').style.width = '100%';
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-ticker-now').textContent = '100%';
  bar.classList.add('complete');

  // Auto-hide after 5 s so the user can read the result
  prog.hideTimer = setTimeout(progressHide, 5000);
}

function progressHide() {
  document.getElementById('scan-progress').classList.add('hidden');
  document.getElementById('scan-progress').classList.remove('complete');
}

// ── Run / Stop ─────────────────────────────────────────────────────────────
function runCommand(cmd) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (cmd === 'tv_earnings') {
    switchTab('earnings');
  } else {
    switchTab('log');
    document.getElementById('log-output').textContent = '';
  }
  ws.send(JSON.stringify({ type: 'run', command: cmd }));
}

function setRunning(cmd, running) {
  const btn = document.querySelector(`[data-cmd="${cmd}"]`);
  if (!btn) return;
  const spinner = btn.querySelector('.cmd-spinner');
  if (running) { btn.classList.add('running'); spinner?.classList.remove('hidden'); }
  else          { btn.classList.remove('running'); spinner?.classList.add('hidden'); }
}

// ── Launch TradingView ─────────────────────────────────────────────────────
let tvLaunchAttempted = false;

async function launchTradingView() {
  const btn = document.getElementById('launch-tv-btn');
  const msg = document.getElementById('offline-msg');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Launching…'; }
  if (msg) msg.textContent = '🚀 Launching TradingView with debug port… please wait ~15 seconds';
  try {
    const res  = await fetch('/api/launch-tv', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      if (msg) msg.textContent = '⏳ TradingView is starting up… buttons will unlock automatically';
    } else {
      if (msg) msg.textContent = `⚠️ Could not launch: ${data.error} — use Launch TradingView.bat on Desktop`;
      if (btn) { btn.disabled = false; btn.textContent = '🚀 Launch TradingView'; }
    }
  } catch (_) {
    if (msg) msg.textContent = '⚠️ Server error — use Launch TradingView.bat on your Desktop';
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Launch TradingView'; }
  }
}

// ── Status badges ──────────────────────────────────────────────────────────
function setStatus(color, text) {
  const el = document.getElementById('ws-status');
  el.innerHTML = `<span class="badge-dot"></span> ${text}`;
  el.className = `badge badge-${color}`;
}

function setTVStatus(online) {
  tvOnline = online;
  const el     = document.getElementById('tv-status');
  const banner = document.getElementById('offline-banner');
  const btn    = document.getElementById('launch-tv-btn');
  const msg    = document.getElementById('offline-msg');

  if (online) {
    el.innerHTML  = '📺 TradingView: Online';
    el.className  = 'badge badge-green';
    banner.classList.remove('show');
    // Reset launch button for next time
    tvLaunchAttempted = false;
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Launch TradingView'; }
    if (msg) msg.textContent = '⚠️ TradingView is not open — launching automatically…';
  } else {
    el.innerHTML  = '📺 TradingView: Offline';
    el.className  = 'badge badge-red';
    banner.classList.add('show');
    // Auto-launch once on first offline detection
    if (!tvLaunchAttempted) {
      tvLaunchAttempted = true;
      launchTradingView();
    }
  }

  document.querySelectorAll('.cmd-btn').forEach(btn => {
    btn.disabled      = !online;
    btn.style.cursor  = online ? 'pointer' : 'not-allowed';
    btn.title         = online ? '' : '⚠️ TradingView is launching… please wait';
  });
}

// ── Log ────────────────────────────────────────────────────────────────────
function appendLog(text, cls) {
  const box  = document.getElementById('log-output');
  const span = document.createElement('span');
  span.className   = cls || '';
  span.textContent = text;
  box.appendChild(span);
  box.scrollTop = box.scrollHeight;
}
function clearLog() {
  document.getElementById('log-output').textContent = 'Log cleared.\n';
}

// ── Tabs ───────────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab')
    .forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-content')
    .forEach(c => c.classList.toggle('active', c.id === `tab-${name}`));
}

// ── Clock ──────────────────────────────────────────────────────────────────
function tickClock() {
  document.getElementById('clock').textContent =
    new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── Day chip helper ────────────────────────────────────────────────────────
function dayChip(days) {
  if (days == null) return '<span class="c-grey">—</span>';
  if (days <= 3)  return `<span class="day-chip chip-hot">🔥 ${days}d</span>`;
  if (days <= 7)  return `<span class="day-chip chip-warm">⚡ ${days}d</span>`;
  if (days <= 14) return `<span class="day-chip chip-normal">${days}d</span>`;
  return `<span class="day-chip chip-far">${days}d</span>`;
}

// ── Cycle Table ────────────────────────────────────────────────────────────
function renderCycleTable(rows, ts) {
  cycleRows = rows;
  document.getElementById('cycle-ts').textContent =
    ts ? `Last scan: ${ts}  ·  ${rows.length} symbols` : 'Cached data';
  document.getElementById('cycle-filter-bar').style.display = 'flex';

  const inDaily  = rows.filter(r => r.currentWin === 'daily');
  const inWeekly = rows.filter(r => r.currentWin === 'weekly');
  const soon     = rows.filter(r => r.daysToNextDCL != null && r.daysToNextDCL <= 14 && r.currentWin !== 'daily');
  const noData   = rows.filter(r => !r.found || (r.currentWin === null && r.daysToNextDCL === null && r.daysToNextWCL === null));

  // Stat cards
  document.getElementById('cycle-stats').innerHTML = [
    { icon: '🟢', label: 'In Daily Window',  val: inDaily.length,  color: 'var(--green)'  },
    { icon: '🔵', label: 'In Weekly Window', val: inWeekly.length, color: 'var(--blue)'   },
    { icon: '⚡', label: 'Next DCL ≤ 14d',  val: soon.length,     color: 'var(--yellow)' },
    { icon: '❌', label: 'No Data',          val: noData.length,   color: 'var(--red)'    },
    { icon: '📊', label: 'Total Symbols',    val: rows.length,     color: 'var(--text-dim)'},
  ].map(s => `
    <div class="stat-card">
      <div class="stat-icon">${s.icon}</div>
      <div class="stat-val" style="color:${s.color}">${s.val}</div>
      <div class="stat-lbl">${s.label}</div>
    </div>`).join('');

  // Sidebar — cycle sections
  setSidebarCol('sidebar-daily-win',  inDaily,  '#22c55e', r => ({ label: r.ticker, detail: r.nextDCLwin || '—' }));
  setSidebarCount('sidebar-daily-count', inDaily.length);
  setSidebarCol('sidebar-weekly-win', inWeekly, '#3b82f6', r => ({ label: r.ticker, detail: r.nextWCLwin || '—' }));
  setSidebarCount('sidebar-weekly-count', inWeekly.length);

  applyCycleFilter();
}

function applyCycleFilter() {
  const search = (document.getElementById('cycle-search')?.value || '').toUpperCase().trim();
  let rows = cycleRows;

  if (cycleFilter === 'inDailyWin')  rows = rows.filter(r => r.currentWin === 'daily');
  if (cycleFilter === 'inWeeklyWin') rows = rows.filter(r => r.currentWin === 'weekly');
  if (cycleFilter === 'soon')        rows = rows.filter(r => r.daysToNextDCL != null && r.daysToNextDCL <= 14);
  if (cycleFilter === 'nodata')      rows = rows.filter(r => !r.found || (r.currentWin === null && r.daysToNextDCL === null && r.daysToNextWCL === null));
  if (search) rows = rows.filter(r => r.ticker.includes(search));

  const tbody = document.getElementById('cycle-tbody');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:#4a5068;font-size:15px">No results found</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const isNoData = !r.found || (r.currentWin === null && r.daysToNextDCL === null && r.daysToNextWCL === null);
    const rowCls = r.currentWin === 'daily'  ? 'row-daily-win'  :
                   r.currentWin === 'weekly' ? 'row-weekly-win' :
                   isNoData                  ? 'row-nodata'     :
                   i % 2                     ? 'row-alt'        : '';

    const dot = r.currentWin === 'daily'
      ? '<span class="win-dot win-dot-green"></span>'
      : r.currentWin === 'weekly'
      ? '<span class="win-dot win-dot-blue"></span>'
      : '';

    const tickerColor = r.currentWin === 'daily'  ? 'var(--green)' :
                        r.currentWin === 'weekly' ? 'var(--blue)'  :
                        isNoData                  ? 'var(--text-faint)' : 'var(--text)';

    const noDataTag = isNoData
      ? `<span style="margin-left:5px;background:#4a506820;border:1px solid #4a506840;color:#4a5068;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700">No Window</span>`
      : '';

    return `<tr class="${rowCls}">
      <td>
        <span class="ticker-badge" style="color:${tickerColor}">
          ${dot}${r.ticker}
        </span>${noDataTag}
      </td>
      <td class="fw800">${r.price}</td>
      <td style="color:var(--yellow)">${r.lastDCL || '—'}</td>
      <td style="color:var(--purple)">${r.lastWCL || '—'}</td>
      <td style="color:var(--green)">${r.nextDCLwin || '<span class="c-grey">—</span>'}</td>
      <td>${dayChip(r.daysToNextDCL)}</td>
      <td style="color:var(--blue)">${r.nextWCLwin || '<span class="c-grey">—</span>'}</td>
      <td>${r.daysToNextWCL != null ? dayChip(r.daysToNextWCL) : '<span class="c-grey">—</span>'}</td>
    </tr>`;
  }).join('');
}

// ── Health Table ───────────────────────────────────────────────────────────
function renderHealthTable(rows, ts) {
  healthRows = rows;
  document.getElementById('health-ts').textContent =
    ts ? `Last scan: ${ts}  ·  ${rows.length} symbols` : 'Cached data';
  document.getElementById('health-filter-bar').style.display = 'flex';

  const bull  = rows.filter(r => r.structure === 'BULLISH');
  const bear  = rows.filter(r => r.structure === 'BEARISH');
  const poi   = rows.filter(r => r.poiHit);
  const fib   = rows.filter(r => r.fibHit);
  const hipri = rows.filter(r => r.poiHit && (r.bull === true || r.bull === false));
  const sos    = rows.filter(r => r.sosSow === 'SOS');
  const sow    = rows.filter(r => r.sosSow === 'SOW');
  const ambuy  = rows.filter(r => r.amSignal === 'BUY');
  const amsell = rows.filter(r => r.amSignal === 'SELL');

  document.getElementById('health-stats').innerHTML = [
    { icon: '📈', label: 'Bullish',      val: bull.length,   color: 'var(--green)'   },
    { icon: '📉', label: 'Bearish',      val: bear.length,   color: 'var(--red)'     },
    { icon: '🟩', label: 'SOS',          val: sos.length,    color: '#22c55e'        },
    { icon: '🟥', label: 'SOW',          val: sow.length,    color: '#ef4444'        },
    { icon: '🟢', label: 'AM Buy',       val: ambuy.length,  color: '#22c55e'        },
    { icon: '🔴', label: 'AM Sell',      val: amsell.length, color: '#ef4444'        },
    { icon: '🎯', label: 'POI Touch',    val: poi.length,    color: 'var(--orange)'  },
    { icon: '〰️', label: 'Fib 0.50',    val: fib.length,    color: 'var(--cyan)'    },
    { icon: '⚡', label: 'High Priority', val: hipri.length,  color: '#f59e0b'        },
    { icon: '📊', label: 'Total',         val: rows.length,   color: 'var(--text-dim)'},
  ].map(s => `
    <div class="stat-card">
      <div class="stat-icon">${s.icon}</div>
      <div class="stat-val" style="color:${s.color}">${s.val}</div>
      <div class="stat-lbl">${s.label}</div>
    </div>`).join('');

  // Sidebar — high priority
  setSidebarCol('sidebar-hipri', hipri.slice(0, 20), null, r => ({
    label: r.ticker,
    detail: r.bull === true ? '⚡ LONG' : '⚡ SHORT',
    detailColor: r.bull === true ? '#22c55e' : '#ef4444',
  }));
  setSidebarCount('sidebar-hipri-count', hipri.length);

  // Sidebar — golden zone (fib 0.50 hits)
  setSidebarCol('sidebar-fib', fib.slice(0, 20), null, r => ({
    label: r.ticker,
    detail: `〰️ ${r.fib}`,
    detailColor: '#06b6d4',
  }));
  setSidebarCount('sidebar-fib-count', fib.length);

  // Sidebar — bullish structure
  setSidebarCol('sidebar-bullish', bull.slice(0, 20), null, r => ({
    label: r.ticker,
    detail: '📈 Bull',
    detailColor: '#22c55e',
  }));
  setSidebarCount('sidebar-bullish-count', bull.length);

  applyHealthFilter();
}

function applyHealthFilter() {
  const search = (document.getElementById('health-search')?.value || '').toUpperCase().trim();
  let rows = healthRows;

  if (healthFilter === 'bull')  rows = rows.filter(r => r.structure === 'BULLISH');
  if (healthFilter === 'bear')  rows = rows.filter(r => r.structure === 'BEARISH');
  if (healthFilter === 'poi')   rows = rows.filter(r => r.poiHit);
  if (healthFilter === 'sos')    rows = rows.filter(r => r.sosSow === 'SOS');
  if (healthFilter === 'sow')    rows = rows.filter(r => r.sosSow === 'SOW');
  if (healthFilter === 'ambuy')  rows = rows.filter(r => r.amSignal === 'BUY');
  if (healthFilter === 'amsell') rows = rows.filter(r => r.amSignal === 'SELL');
  if (healthFilter === 'hipri') rows = rows.filter(r => r.poiHit && (r.bull === true || r.bull === false))
    .sort((a, b) => {
      // LONG (bullish+POI) first, then SHORT (bearish+POI)
      const aScore = a.bull === true ? 0 : 1;
      const bScore = b.bull === true ? 0 : 1;
      return aScore - bScore;
    });
  if (search) rows = rows.filter(r => r.ticker.includes(search));

  const tbody = document.getElementById('health-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:#4a5068;font-size:15px">No results found</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const structIcon  = r.structure === 'BULLISH' ? '📈' : r.structure === 'BEARISH' ? '📉' : '➖';
    const structColor = r.structure === 'BULLISH' ? 'var(--green)' : r.structure === 'BEARISH' ? 'var(--red)' : 'var(--text-dim)';
    const rowCls      = i % 2 ? 'row-alt' : '';

    const earningsDays = r.earnDays;
    const earningsStr  = r.earnDate && r.earnDate !== '—'
      ? `${r.earnDate} ${earningsDays != null ? dayChip(earningsDays) : ''}`
      : '<span class="c-grey">—</span>';

    const isHiPri  = r.poiHit && (r.bull === true || r.bull === false);
    const hiPriTag = isHiPri
      ? `<span style="margin-left:5px;background:#f59e0b22;border:1px solid #f59e0b55;color:#f59e0b;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700">
          ${r.bull === true ? '⚡ LONG' : '⚡ SHORT'}
        </span>`
      : '';

    const sosCell = r.sosSow === 'SOS'
      ? '<span style="color:#22c55e;font-weight:700;background:#22c55e18;border:1px solid #22c55e40;border-radius:4px;padding:1px 6px">🟩 SOS</span>'
      : r.sosSow === 'SOW'
      ? '<span style="color:#ef4444;font-weight:700;background:#ef444418;border:1px solid #ef444440;border-radius:4px;padding:1px 6px">🟥 SOW</span>'
      : '<span class="c-grey">—</span>';

    const amCell = r.amSignal === 'BUY'
      ? `<span style="color:#22c55e;font-weight:700;background:#22c55e18;border:1px solid #22c55e40;border-radius:4px;padding:1px 6px">🟢 BUY</span><br><span style="color:#4a5068;font-size:10px">${r.amDate || ''}</span>`
      : r.amSignal === 'SELL'
      ? `<span style="color:#ef4444;font-weight:700;background:#ef444418;border:1px solid #ef444440;border-radius:4px;padding:1px 6px">🔴 SELL</span><br><span style="color:#4a5068;font-size:10px">${r.amDate || ''}</span>`
      : '<span class="c-grey">—</span>';

    return `<tr class="${rowCls}${isHiPri ? ' hipri-row' : ''}">
      <td><span class="ticker-badge">${r.ticker}</span>${hiPriTag}</td>
      <td class="fw800">${r.price}</td>
      <td style="color:${structColor};font-weight:700">${structIcon} ${r.structure || '—'}</td>
      <td>${sosCell}</td>
      <td>${amCell}</td>
      <td>${r.poiHit ? '<span style="color:var(--orange);font-weight:700">🎯 Yes</span>' : '<span class="c-grey">—</span>'}</td>
      <td>${r.fibHit ? '<span style="color:var(--cyan);font-weight:700">✅ Yes</span>' : '<span class="c-grey">—</span>'}</td>
      <td>${earningsStr}</td>
    </tr>`;
  }).join('');
}

// ── Earnings Sidebar ───────────────────────────────────────────────────────
function refreshEarningsSidebar(data) {
  if (!data?.earnings) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const soon = Object.entries(data.earnings)
    .map(([ticker, dateStr]) => {
      const days = Math.round((new Date(dateStr) - today) / 86400000);
      return { ticker, dateStr, days };
    })
    .filter(r => r.days >= 0 && r.days <= 10)
    .sort((a, b) => a.days - b.days);

  setSidebarCol('sidebar-earnings', soon, null, r => ({
    label: r.ticker,
    detail: r.days <= 3 ? `🔥 ${r.days}d` : `⚡ ${r.days}d`,
    detailColor: r.days <= 3 ? '#f97316' : '#eab308',
  }));
  setSidebarCount('sidebar-earnings-count', soon.length);
}

// ── Earnings Table ─────────────────────────────────────────────────────────
function renderEarningsTable(data) {
  earningsData = data;
  refreshEarningsSidebar(data);
  const updated = data?.updated || '—';
  document.getElementById('earn-ts').textContent =
    `Updated: ${updated}  ·  Source: ${data?.source || '—'}`;

  const signals  = data?.signals  || {};
  const earnings = data?.earnings || {};
  const today    = new Date();
  today.setHours(0, 0, 0, 0);

  // Build rows from earnings object
  const rows = Object.entries(earnings).map(([ticker, earnDate]) => {
    const signalDate  = signals[ticker] || null;
    const earnDateObj = new Date(earnDate);
    const daysAway    = Math.round((earnDateObj - today) / 86400000);
    return { ticker, signalDate, earnDate, daysAway };
  }).sort((a, b) => a.daysAway - b.daysAway);

  // Stat cards
  const upcoming7  = rows.filter(r => r.daysAway >= 0 && r.daysAway <= 7);
  const upcoming14 = rows.filter(r => r.daysAway >= 0 && r.daysAway <= 14);
  const past       = rows.filter(r => r.daysAway < 0);
  document.getElementById('earn-stats').innerHTML = [
    { icon: '🔥', label: '≤ 7 Days',    val: upcoming7.length,  color: 'var(--orange)' },
    { icon: '⚡', label: '≤ 14 Days',   val: upcoming14.length, color: 'var(--yellow)' },
    { icon: '📅', label: 'Total Listed', val: rows.length,       color: 'var(--text-dim)' },
    { icon: '✅', label: 'Past / Done',  val: past.length,       color: 'var(--text-faint)' },
  ].map(s => `
    <div class="stat-card">
      <div class="stat-icon">${s.icon}</div>
      <div class="stat-val" style="color:${s.color}">${s.val}</div>
      <div class="stat-lbl">${s.label}</div>
    </div>`).join('');

  const tbody = document.getElementById('earn-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:40px;color:#4a5068">No earnings data — click 📅 Earnings to run a scan</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const isPast   = r.daysAway < 0;
    const rowCls   = isPast           ? 'earn-past'
                   : r.daysAway <= 3  ? 'earn-urgent'
                   : r.daysAway <= 7  ? 'earn-soon'
                   : i % 2            ? 'row-alt' : '';
    const earnCell = isPast
      ? `<span class="c-grey">${r.earnDate}</span>`
      : `<span style="color:var(--yellow);font-weight:700">${r.earnDate}</span>`;
    const daysCell = isPast
      ? '<span class="c-grey">past</span>'
      : dayChip(r.daysAway);

    return `<tr class="${rowCls}">
      <td><span class="ticker-badge">${r.ticker}</span></td>
      <td style="color:var(--text-dim);font-size:13px">${r.signalDate || '<span class="c-grey">—</span>'}</td>
      <td>${earnCell}</td>
      <td>${daysCell}</td>
    </tr>`;
  }).join('');
}

function loadEarningsCache() {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'get_cache', key: 'earnings' }));
}

// ── Watchlist ──────────────────────────────────────────────────────────────
async function loadWatchlist() {
  try {
    const [wlRes, earnRes] = await Promise.all([
      fetch('/api/watchlist'),
      fetch('/api/cache?key=earnings'),
    ]);
    const wlData   = await wlRes.json();
    const earnData = await earnRes.json();
    const syms     = wlData.symbols || [];
    const signals  = earnData?.signals  || {};
    const earnings = earnData?.earnings || {};
    refreshEarningsSidebar(earnData);

    document.getElementById('wl-ts').textContent =
      `Your Watchlist  ·  ${syms.length} symbols`;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rows = syms.map(s => {
      const ticker      = s.split(':')[1] || s;
      const signalDate  = signals[ticker]  || null;
      const earnDate    = earnings[ticker] || null;
      const sigDateObj  = signalDate ? new Date(signalDate) : null;
      const earnDateObj = earnDate   ? new Date(earnDate)   : null;
      const daysSig     = sigDateObj  ? Math.round((today - sigDateObj)  / 86400000) : null;
      const daysEarn    = earnDateObj ? Math.round((earnDateObj - today) / 86400000) : null;
      return { ticker, signalDate, sigDateObj, daysSig, earnDate, daysEarn };
    }).sort((a, b) => {
      // Sort by signal date — most recent first; no-date entries go last
      if (!a.sigDateObj && !b.sigDateObj) return a.ticker.localeCompare(b.ticker);
      if (!a.sigDateObj) return 1;
      if (!b.sigDateObj) return -1;
      return b.sigDateObj - a.sigDateObj;
    });

    // Stat cards
    const earnSoon = rows.filter(r => r.daysEarn != null && r.daysEarn >= 0 && r.daysEarn <= 7);
    document.getElementById('wl-stats').innerHTML = [
      { icon: '📋', label: 'Total Symbols', val: rows.length,       color: 'var(--text-dim)'   },
      { icon: '🔥', label: 'Earnings ≤ 7d', val: earnSoon.length,   color: 'var(--orange)'     },
    ].map(s => `
      <div class="stat-card">
        <div class="stat-icon">${s.icon}</div>
        <div class="stat-val" style="color:${s.color}">${s.val}</div>
        <div class="stat-lbl">${s.label}</div>
      </div>`).join('');

    const tbody = document.getElementById('wl-tbody');
    tbody.innerHTML = rows.map((r, i) => {
      const isPastEarn = r.daysEarn != null && r.daysEarn < 0;
      const rowCls     = !isPastEarn && r.daysEarn != null && r.daysEarn <= 7
        ? 'earn-soon' : i % 2 ? 'row-alt' : '';

      const earnCell = r.earnDate
        ? (isPastEarn
            ? `<span class="c-grey">${r.earnDate}</span>`
            : `<span style="color:var(--yellow)">${r.earnDate}</span>`)
        : '<span class="c-grey">—</span>';

      const daysEarnCell = r.daysEarn != null
        ? (isPastEarn ? '<span class="c-grey">past</span>' : dayChip(r.daysEarn))
        : '<span class="c-grey">—</span>';

      const daysSigCell = r.daysSig != null
        ? `<span style="color:var(--text-dim);font-size:13px">${r.daysSig}d ago</span>`
        : '<span class="c-grey">—</span>';

      return `<tr class="${rowCls}">
        <td style="color:var(--text-dim);font-size:13px;font-weight:600">${r.signalDate || '<span class="c-grey">—</span>'}</td>
        <td><span class="ticker-badge">${r.ticker}</span></td>
        <td>${daysSigCell}</td>
        <td>${earnCell}</td>
        <td>${daysEarnCell}</td>
      </tr>`;
    }).join('');
  } catch (_) {}
}

// ── Live watchlist re-scrape from TradingView ──────────────────────────────
async function refreshWatchlistLive() {
  const btn = document.querySelector('[onclick="refreshWatchlistLive()"]');
  if (btn) { btn.textContent = '⏳ Scanning…'; btn.disabled = true; }

  document.getElementById('wl-ts').textContent = 'Your Watchlist  ·  scanning TradingView…';

  try {
    const resp = await fetch('/api/refresh-watchlist');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let msg;
        try { msg = JSON.parse(line.slice(6)); } catch (_) { continue; }
        if (msg.type === 'log') {
          document.getElementById('wl-ts').textContent = 'Your Watchlist  ·  ' + msg.text;
        }
        if (msg.type === 'done') {
          await loadWatchlist();   // re-render with fresh cache
        }
      }
    }
  } catch (e) {
    document.getElementById('wl-ts').textContent = 'Your Watchlist  ·  ❌ scrape failed';
  } finally {
    if (btn) { btn.textContent = '↺ Refresh'; btn.disabled = false; }
  }
}

function loadCycleCache() {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'get_cache', key: 'cycle' }));
}
function loadHealthCache() {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'get_cache', key: 'scan' }));
}

// ── Sidebar helpers ────────────────────────────────────────────────────────
function setSidebarCount(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = n > 0 ? `(${n})` : '';
}

function setSidebarCol(id, items, color, rowFn) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<span style="color:#4a5068;font-size:12px">—</span>';
    return;
  }
  el.innerHTML = items.map(r => {
    const { label, detail, detailColor } = rowFn(r);
    const dc = detailColor || color || '#8892a4';
    return `
      <div class="sidebar-row">
        <span class="sidebar-row-label">${label}</span>
        <span class="sidebar-row-detail" style="color:${dc}">${detail}</span>
      </div>`;
  }).join('');
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connect();
  setInterval(tickClock, 1000);
  tickClock();

  // Command buttons
  document.querySelectorAll('.cmd-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.disabled) runCommand(btn.dataset.cmd);
    });
  });

  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Cycle filters
  document.querySelectorAll('#cycle-filter-bar .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#cycle-filter-bar .filter-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cycleFilter = btn.dataset.filter;
      applyCycleFilter();
    });
  });
  document.getElementById('cycle-search')?.addEventListener('input', applyCycleFilter);

  // Health filters
  document.querySelectorAll('#health-filter-bar .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#health-filter-bar .filter-btn')
        .forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      healthFilter = btn.dataset.filter;
      applyHealthFilter();
    });
  });
  document.getElementById('health-search')?.addEventListener('input', applyHealthFilter);

  // Sidebar collapse / expand — event delegation on the aside so it always works
  document.querySelector('.sidebar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.sidebar-toggle-btn');
    if (!btn) return;
    const card = btn.closest('.sidebar-card');
    if (!card) return;
    card.classList.toggle('collapsed');
  });
});
