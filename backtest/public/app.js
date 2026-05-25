// UOA Backtest Dashboard — Frontend JS

let currentResults    = null;
let currentYearTab    = 'all';
let currentTableYear  = 'all';   // year filter on the trade table
let charts = {};

// ─── Init ────────────────────────────────────────────────────────────────
let currentOutcomeTab = 'all';

document.addEventListener('DOMContentLoaded', () => {
  loadSignalSummary();
  loadCachedResults();
  setupControls();
  setupSearch();
  setupYearTabs();
  setupOutcomeTabs();
  setupTableYearFilter();
  setupTableSort();
  setupMonthlyYearTabs();
});

// ─── Control group selection ─────────────────────────────────────────────
function setupControls() {
  document.querySelectorAll('#year-group .btn-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#year-group .btn-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // HP toggle
  document.getElementById('hp-toggle').addEventListener('click', () => {
    document.getElementById('hp-toggle').classList.add('active');
    document.getElementById('all-toggle').classList.remove('active');
  });
  document.getElementById('all-toggle').addEventListener('click', () => {
    document.getElementById('all-toggle').classList.add('active');
    document.getElementById('hp-toggle').classList.remove('active');
  });

  document.getElementById('run-btn').addEventListener('click', startBacktest);
}

function getSelectedDir()  { return 'BULLISH'; }
function getSelectedYear() { return document.querySelector('#year-group .btn-opt.active')?.dataset.val || 'ALL'; }
function getHPOnly()       { return document.getElementById('hp-toggle').classList.contains('active'); }

// ─── Load signal summary ─────────────────────────────────────────────────
async function loadSignalSummary() {
  try {
    const r = await fetch('/api/signals-summary');
    const d = await r.json();
    if (!d.ok) return;
    const s = d.summary;
    document.getElementById('sc-total').textContent = s.total.toLocaleString();
    document.getElementById('sc-hp').textContent    = s.hp.toLocaleString();
    document.getElementById('sc-bull').textContent  = s.hpBull.toLocaleString();
    for (const y of [2022, 2023, 2024, 2025]) {
      document.getElementById(`sc-${y}`).textContent = `${s.byYear[y].total} / ${s.byYear[y].hp} HP`;
    }
  } catch(e) { console.error('Summary error:', e); }
}

// ─── Load cached results ─────────────────────────────────────────────────
async function loadCachedResults() {
  try {
    const r = await fetch('/api/results');
    const d = await r.json();
    if (!d.ok) return;
    currentResults = d.results;
    renderResults(d.results);
  } catch(e) {}
}

// ─── Run Backtest ─────────────────────────────────────────────────────────
function startBacktest() {
  const direction = getSelectedDir();
  const year      = getSelectedYear();
  const hpOnly    = getHPOnly();

  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Running...';

  // Show progress
  const progressBar  = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const logPanel     = document.getElementById('log-panel');
  const logContent   = document.getElementById('log-content');

  progressBar.style.display = 'block';
  logPanel.style.display = 'block';
  logContent.innerHTML = '';
  progressFill.style.width = '0%';

  const url = `/api/run-backtest?direction=${direction}&year=${year}&hpOnly=${hpOnly}`;
  const evtSource = new EventSource(url);

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'progress' || data.type === 'start') {
      const cls = data.msg?.includes('✅') || data.msg?.includes('🎉') ? 'log-done'
                : data.msg?.includes('⚠️') ? 'log-warn' : '';
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.textContent = data.msg || '';
      logContent.appendChild(div);
      logContent.scrollTop = logContent.scrollHeight;
      if (data.progress != null) progressFill.style.width = data.progress + '%';
    }

    if (data.type === 'complete') {
      progressFill.style.width = '100%';
      currentResults = data.results;
      renderResults(data.results);
      btn.disabled = false;
      btn.textContent = '▶ Run Backtest';
      evtSource.close();
    }

    if (data.type === 'error') {
      const div = document.createElement('div');
      div.style.color = '#f85149';
      div.textContent = '❌ Error: ' + data.msg;
      logContent.appendChild(div);
      btn.disabled = false;
      btn.textContent = '▶ Run Backtest';
      evtSource.close();
    }
  };

  evtSource.onerror = () => {
    btn.disabled = false;
    btn.textContent = '▶ Run Backtest';
    evtSource.close();
  };
}

// ─── Render Results ────────────────────────────────────────────────────────
function renderResults(results) {
  if (!results) return;
  allResultsRef = results; // store for monthly chart tab switching
  document.getElementById('results-section').style.display = 'block';

  const stats = results.overall.stats;
  renderPerfCards(stats);
  renderYearStatsGrid(results);
  renderCharts(results);
  renderTradeTable(results.overall.trades);
  document.getElementById('table-meta').textContent = `(${results.overall.trades.filter(t => t.entryDate).length} trades)`;

  // Reset monthly chart tab to All
  monthlyChartYear = 'all';
  document.querySelectorAll('.myt-btn').forEach(b => b.classList.remove('active'));
  const allMyt = document.querySelector('.myt-btn[data-year="all"]');
  if (allMyt) allMyt.classList.add('active');

  // Reset table year filter
  currentTableYear = 'all';
  document.querySelectorAll('.yflt-btn').forEach(b => b.classList.remove('active'));
  const allYflt = document.querySelector('.yflt-btn[data-fyear="all"]');
  if (allYflt) allYflt.classList.add('active');
  const lbl = document.getElementById('year-filter-label');
  if (lbl) lbl.textContent = 'All';
  // Collapse the year bar on new results
  const bar = document.getElementById('year-filter-bar');
  const tog = document.getElementById('year-collapse-toggle');
  if (bar) bar.style.display = 'none';
  if (tog) tog.classList.remove('open');
}

function renderPerfCards(stats) {
  const fmt    = (v) => v >= 0 ? `+$${v.toLocaleString()}` : `-$${Math.abs(v).toLocaleString()}`;
  const fmtRaw = (v) => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);

  setStatVal('r-pnl',       fmt(stats.totalPnl),       stats.totalPnl >= 0 ? 'pos' : 'neg');
  setStatVal('r-winrate',   stats.winRate + '%',        stats.winRate >= 50 ? 'pos' : 'neg');
  setStatVal('r-trades',    stats.tradesExecuted,       'neu');
  setStatVal('r-wins',      stats.winCount,             'pos');
  setStatVal('r-losses',    stats.lossCount,            stats.lossCount > 0 ? 'neg' : 'neu');
  setStatVal('r-be',        stats.beCount,              'neu');
  setStatVal('r-open',      stats.openCount,            'neu');
  setStatVal('r-noentry',   stats.noEntryCount,         'neu');
  setStatVal('r-avgrr',     fmtRaw(stats.avgRR) + 'R', stats.avgRR >= 1 ? 'pos' : 'neg');
  setStatVal('r-avgdur',    stats.avgDurationDays + 'd','neu');
  setStatVal('r-besttrade', fmt(stats.bestTrade),       'pos');
  setStatVal('r-worsttrade',fmt(stats.worstTrade),      'neg');
}

function setStatVal(id, val, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.className = `stat-val ${cls || ''}`;
}

// ─── Year Stats Grid ──────────────────────────────────────────────────────
function renderYearStatsGrid(results) {
  const container = document.getElementById('year-stats-grid');
  container.innerHTML = '';
  const years = Object.keys(results.byYear).sort();
  for (const year of years) {
    const s = results.byYear[year].stats;
    const pnlColor = s.totalPnl >= 0 ? '#3fb950' : '#f85149';
    container.innerHTML += `
      <div class="stat-card" style="text-align:left">
        <div style="font-size:15px;font-weight:700;color:var(--accent);margin-bottom:6px">📅 ${year}</div>
        <div style="font-size:12px;margin-bottom:4px">
          <span style="color:var(--text3)">P&amp;L: </span>
          <span style="color:${pnlColor};font-weight:700">${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toLocaleString()}</span>
        </div>
        <div style="font-size:12px;margin-bottom:2px">
          <span style="color:var(--text3)">Win Rate: </span>
          <span style="color:${s.winRate>=50?'#3fb950':'#f85149'};font-weight:600">${s.winRate}%</span>
        </div>
        <div style="font-size:11px;color:var(--text3)">
          ${s.tradesExecuted} trades · ${s.winCount}W ${s.lossCount}L ${s.beCount}BE
        </div>
        <div style="font-size:11px;color:var(--text3)">
          Avg RR: ${s.avgRR}R · Avg ${s.avgDurationDays}d
        </div>
        <div style="font-size:11px;margin-top:3px">
          <span style="color:var(--text3)">Profit Factor: </span>
          <span style="color:${s.profitFactor>=2?'#3fb950':s.profitFactor>=1?'#d29922':'#f85149'};font-weight:600">${s.profitFactor}</span>
        </div>
      </div>`;
  }
}

// ─── Year Tabs ────────────────────────────────────────────────────────────
function setupYearTabs() {
  document.getElementById('year-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.year-tab');
    if (!btn) return;
    document.querySelectorAll('.year-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentYearTab = btn.dataset.year;
    // Reset outcome tab and table year filter when breakdown year changes
    currentOutcomeTab = 'all';
    currentTableYear  = 'all';
    document.querySelectorAll('.outcome-tab').forEach(b => b.classList.remove('active'));
    const allTab = document.querySelector('.outcome-tab[data-outcome="all"]');
    if (allTab) allTab.classList.add('active');
    // Reset table year filter UI
    document.querySelectorAll('.yflt-btn').forEach(b => b.classList.remove('active'));
    const allYflt = document.querySelector('.yflt-btn[data-fyear="all"]');
    if (allYflt) allYflt.classList.add('active');
    const lbl = document.getElementById('year-filter-label');
    if (lbl) lbl.textContent = 'All';
    if (currentResults) renderTradeTable(getTradesForYear(currentResults, currentYearTab));
  });
}

function getTradesForYear(results, year) {
  if (year === 'all') return results.overall.trades;
  return results.byYear[year]?.trades || [];
}

// ─── Charts ───────────────────────────────────────────────────────────────
const CHART_DEFAULTS = {
  color: '#e6edf3',
  grid:  'rgba(48,54,61,0.8)',
  font:  "'Segoe UI', sans-serif",
};

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function renderCharts(results) {
  const years = Object.keys(results.byYear).sort().map(Number);
  const pnls  = years.map(y => results.byYear[y].stats.totalPnl);
  const wrs   = years.map(y => results.byYear[y].stats.winRate);
  const rrs   = years.map(y => results.byYear[y].stats.avgRR);

  // ─ Bar: PnL by year
  destroyChart('pnl-year');
  charts['pnl-year'] = new Chart(document.getElementById('chart-pnl-year'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{
        label: 'P&L ($)',
        data: pnls,
        backgroundColor: pnls.map(v => v >= 0 ? 'rgba(63,185,80,0.7)' : 'rgba(248,81,73,0.7)'),
        borderColor:     pnls.map(v => v >= 0 ? '#3fb950' : '#f85149'),
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: barChartOpts('$'),
  });

  // ─ Bar: Win Rate by year
  destroyChart('winrate-year');
  charts['winrate-year'] = new Chart(document.getElementById('chart-winrate-year'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{
        label: 'Win Rate (%)',
        data: wrs,
        backgroundColor: wrs.map(v => v >= 50 ? 'rgba(88,166,255,0.7)' : 'rgba(188,140,255,0.7)'),
        borderColor:     wrs.map(v => v >= 50 ? '#58a6ff' : '#bc8cff'),
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: barChartOpts('%'),
  });

  // ─ Doughnut: Outcome distribution
  const allTrades = results.overall.trades;
  const outcomeMap = {
    'TP1+TP2':     { label: 'TP1+TP2 Win',   color: '#3fb950' },
    'TP1+PARTIAL': { label: 'TP1+Partial',    color: '#7ee787' },
    'OPEN_PROFIT': { label: 'Open (Profit)',   color: '#39d0d8' },
    'BE':          { label: 'Break Even',      color: '#d29922' },
    'SL':          { label: 'Stop Loss',       color: '#f85149' },
    'OPEN_LOSS':   { label: 'Open (Loss)',     color: '#ffa198' },
    'NO_ENTRY':    { label: 'No Entry',        color: '#484f58' },
    'NO_PRICE_DATA':{ label: 'No Data',        color: '#30363d' },
  };
  const outcomeCounts = {};
  for (const t of allTrades) {
    const key = t.outcome || 'NO_ENTRY';
    outcomeCounts[key] = (outcomeCounts[key] || 0) + 1;
  }
  const outcomeKeys = Object.keys(outcomeCounts).filter(k => outcomeCounts[k] > 0);

  destroyChart('outcomes');
  charts['outcomes'] = new Chart(document.getElementById('chart-outcomes'), {
    type: 'doughnut',
    data: {
      labels: outcomeKeys.map(k => outcomeMap[k]?.label || k),
      datasets: [{
        data: outcomeKeys.map(k => outcomeCounts[k]),
        backgroundColor: outcomeKeys.map(k => outcomeMap[k]?.color || '#484f58'),
        borderColor: '#161b22',
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: CHART_DEFAULTS.color, font: { size: 11 }, boxWidth: 12 }, position: 'right' },
        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.raw}` } }
      }
    }
  });

  // ─ Bar: Avg RR by year
  destroyChart('rr-year');
  charts['rr-year'] = new Chart(document.getElementById('chart-rr-year'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{
        label: 'Avg R:R',
        data: rrs,
        backgroundColor: rrs.map(v => v >= 1 ? 'rgba(240,136,62,0.7)' : 'rgba(188,140,255,0.7)'),
        borderColor:     rrs.map(v => v >= 1 ? '#f0883e' : '#bc8cff'),
        borderWidth: 1,
        borderRadius: 6,
      }]
    },
    options: barChartOpts('R'),
  });

  // ─ Line: Monthly cumulative PnL
  renderMonthlyCumulativeChart(results.overall.trades, 'all');
}

function barChartOpts(suffix) {
  return {
    responsive: true,
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: ctx => `${suffix === '$' ? '$' : ''}${ctx.raw}${suffix !== '$' ? suffix : ''}` } }
    },
    scales: {
      x: { ticks: { color: CHART_DEFAULTS.color, font: { size: 11 } }, grid: { color: CHART_DEFAULTS.grid } },
      y: { ticks: { color: CHART_DEFAULTS.color, font: { size: 11 } }, grid: { color: CHART_DEFAULTS.grid } }
    }
  };
}

// ─── Monthly Chart Year Tab ───────────────────────────────────────────────
let monthlyChartYear = 'all';
let allResultsRef    = null; // keep reference to full results for re-rendering

function setupMonthlyYearTabs() {
  document.getElementById('monthly-year-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.myt-btn');
    if (!btn || !allResultsRef) return;
    document.querySelectorAll('.myt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    monthlyChartYear = btn.dataset.year;
    const trades = monthlyChartYear === 'all'
      ? allResultsRef.overall.trades
      : (allResultsRef.byYear[monthlyChartYear]?.trades || []);
    renderMonthlyCumulativeChart(trades, monthlyChartYear);
  });
}

function renderMonthlyCumulativeChart(trades, yearLabel) {
  const isSpecificYear = yearLabel && yearLabel !== 'all';

  // Build monthly P&L map
  // For a specific year: only include months Jan–Dec of that year.
  // Any exit date that falls OUTSIDE that year gets clamped to Dec of that year.
  const monthPnl = {};

  if (isSpecificYear) {
    const y        = String(yearLabel);
    const janKey   = `${y}-01`;
    const decKey   = `${y}-12`;

    // Pre-fill all 12 months with 0 so the x-axis is always Jan–Dec
    for (let m = 1; m <= 12; m++) {
      monthPnl[`${y}-${String(m).padStart(2,'0')}`] = 0;
    }

    for (const t of trades) {
      if (t.pnl == null) continue;
      // Use exit date if available, else use signal date as fallback
      const raw = t.exitDate || t.signal?.date;
      if (!raw) continue;
      // Clamp: any month before Jan → Jan, after Dec → Dec
      let month = raw.slice(0, 7);
      if (month < janKey) month = janKey;
      if (month > decKey) month = decKey;
      monthPnl[month] = (monthPnl[month] || 0) + t.pnl;
    }
  } else {
    // All years: use exit date as-is, span full range
    for (const t of trades) {
      if (!t.exitDate || t.pnl == null) continue;
      const month = t.exitDate.slice(0, 7);
      monthPnl[month] = (monthPnl[month] || 0) + t.pnl;
    }
  }

  const months = Object.keys(monthPnl).sort();
  let cumPnl = 0;
  const cumData = months.map(m => { cumPnl += monthPnl[m]; return +cumPnl.toFixed(2); });

  // Render mini stats bar
  renderMonthlyStatsBar(trades, cumData);

  const finalPnl  = cumData.length ? cumData[cumData.length - 1] : 0;
  const lineColor = finalPnl >= 0 ? '#3fb950' : '#f85149';
  const gradStart = finalPnl >= 0 ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.25)';

  // For specific year, show short month labels (Jan, Feb…)
  const shortMonthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const displayLabels = isSpecificYear
    ? months.map(m => shortMonthNames[parseInt(m.slice(5,7)) - 1])
    : months;

  destroyChart('monthly-pnl');
  charts['monthly-pnl'] = new Chart(document.getElementById('chart-monthly-pnl'), {
    type: 'line',
    data: {
      labels: displayLabels,
      datasets: [{
        label: 'Cumulative P&L',
        data: cumData,
        borderColor: lineColor,
        backgroundColor: (ctx) => {
          const c = ctx.chart.ctx;
          const g = c.createLinearGradient(0, 0, 0, 220);
          g.addColorStop(0, gradStart);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          return g;
        },
        fill: true,
        tension: 0.35,
        pointRadius: isSpecificYear ? 4 : (cumData.length > 30 ? 2 : 4),
        pointHoverRadius: 6,
        pointBackgroundColor: lineColor,
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              return ` ${v >= 0 ? '+' : ''}$${v.toLocaleString()}`;
            },
            title: ctx => {
              if (isSpecificYear) return `${ctx[0]?.label} ${yearLabel}`;
              return ctx[0]?.label || '';
            },
          },
          backgroundColor: '#21262d',
          borderColor: '#30363d',
          borderWidth: 1,
          titleColor: '#8b949e',
          bodyColor: '#e6edf3',
        }
      },
      scales: {
        x: {
          ticks: {
            color: CHART_DEFAULTS.color,
            font: { size: isSpecificYear ? 11 : 10 },
            maxTicksLimit: isSpecificYear ? 12 : 24,
          },
          grid: { color: CHART_DEFAULTS.grid }
        },
        y: {
          ticks: { color: CHART_DEFAULTS.color, font: { size: 11 }, callback: v => `$${(v/1000).toFixed(0)}K` },
          grid: { color: CHART_DEFAULTS.grid }
        }
      }
    }
  });
}

function renderMonthlyStatsBar(trades, cumData) {
  const bar = document.getElementById('monthly-stats-bar');
  if (!bar) return;

  const executed  = trades.filter(t => t.entryDate);
  const totalPnl  = executed.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins      = executed.filter(t => OUTCOME_WIN_KEYS.includes(t.outcome));
  const losses    = executed.filter(t => OUTCOME_SL_KEYS.includes(t.outcome));
  const winRate   = executed.length ? (100 * wins.length / executed.length).toFixed(1) : '—';
  const maxDrawup = cumData.length ? Math.max(...cumData) : 0;
  const maxDD     = cumData.length ? (() => {
    let peak = -Infinity, maxD = 0;
    for (const v of cumData) {
      if (v > peak) peak = v;
      const dd = peak - v;
      if (dd > maxD) maxD = dd;
    }
    return maxD;
  })() : 0;

  const fmtPnl = v => v >= 0 ? `<span class="mstat-val pos">+$${Math.round(v).toLocaleString()}</span>`
                              : `<span class="mstat-val neg">-$${Math.abs(Math.round(v)).toLocaleString()}</span>`;

  bar.innerHTML = `
    <div class="mstat"><span class="mstat-label">Net P&amp;L:</span> ${fmtPnl(totalPnl)}</div>
    <div class="mstat"><span class="mstat-label">Trades:</span> <span class="mstat-val">${executed.length}</span></div>
    <div class="mstat"><span class="mstat-label">Win Rate:</span> <span class="mstat-val ${parseFloat(winRate)>=50?'pos':'neg'}">${winRate}%</span></div>
    <div class="mstat"><span class="mstat-label">Winners:</span> <span class="mstat-val pos">${wins.length}</span></div>
    <div class="mstat"><span class="mstat-label">Losers:</span> <span class="mstat-val neg">${losses.length}</span></div>
    <div class="mstat"><span class="mstat-label">Peak P&amp;L:</span> ${fmtPnl(maxDrawup)}</div>
    <div class="mstat"><span class="mstat-label">Max Drawdown:</span> <span class="mstat-val neg">-$${Math.round(maxDD).toLocaleString()}</span></div>
  `;
}

// ─── Outcome Tabs ─────────────────────────────────────────────────────────
const OUTCOME_WIN_KEYS    = ['TP1+TP2', 'TP1+PARTIAL', 'OPEN_PROFIT'];
const OUTCOME_SL_KEYS     = ['SL'];
const OUTCOME_NOENTRY_KEYS= ['NO_ENTRY', 'NO_PRICE_DATA', 'NO_LEVELS', 'INVALID_LEVELS'];
const OUTCOME_OTHER_KEYS  = ['BE', 'OPEN_LOSS', 'OPEN_PROFIT']; // BE + open

function getOutcomeGroup(outcome) {
  if (OUTCOME_WIN_KEYS.includes(outcome))     return 'wins';
  if (OUTCOME_SL_KEYS.includes(outcome))      return 'sl';
  if (OUTCOME_NOENTRY_KEYS.includes(outcome)) return 'noentry';
  return 'others';
}

function filterByOutcome(trades, tab) {
  if (tab === 'all')     return trades;
  if (tab === 'wins')    return trades.filter(t => OUTCOME_WIN_KEYS.includes(t.outcome));
  if (tab === 'sl')      return trades.filter(t => OUTCOME_SL_KEYS.includes(t.outcome));
  if (tab === 'noentry') return trades.filter(t => OUTCOME_NOENTRY_KEYS.includes(t.outcome));
  if (tab === 'others')  return trades.filter(t =>
    !OUTCOME_WIN_KEYS.includes(t.outcome) &&
    !OUTCOME_SL_KEYS.includes(t.outcome) &&
    !OUTCOME_NOENTRY_KEYS.includes(t.outcome)
  );
  return trades;
}

function updateOutcomeCounts(trades) {
  const all     = trades.length;
  const wins    = trades.filter(t => OUTCOME_WIN_KEYS.includes(t.outcome)).length;
  const sl      = trades.filter(t => OUTCOME_SL_KEYS.includes(t.outcome)).length;
  const noentry = trades.filter(t => OUTCOME_NOENTRY_KEYS.includes(t.outcome)).length;
  const others  = all - wins - sl - noentry;

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('otab-count-all',     all);
  set('otab-count-wins',    wins);
  set('otab-count-sl',      sl);
  set('otab-count-noentry', noentry);
  set('otab-count-others',  others);
}

function setupOutcomeTabs() {
  document.getElementById('outcome-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.outcome-tab');
    if (!btn) return;
    document.querySelectorAll('.outcome-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentOutcomeTab = btn.dataset.outcome;
    applyTableFilters();
  });
}

function applyTableFilters() {
  const search = (document.getElementById('table-search')?.value || '').toUpperCase();
  let trades = allDisplayTrades;

  // Year filter (table-level, from the collapse bar)
  if (currentTableYear !== 'all') {
    trades = trades.filter(t => t.signal?.date?.startsWith(currentTableYear));
  }

  // Outcome tab filter
  trades = filterByOutcome(trades, currentOutcomeTab);

  // Text search
  if (search) trades = trades.filter(t => t.signal?.ticker?.toUpperCase().includes(search));

  renderTableRows(trades);
}

// ─── Table Year Filter (collapse toggle) ──────────────────────────────────
function setupTableYearFilter() {
  const toggle  = document.getElementById('year-collapse-toggle');
  const bar     = document.getElementById('year-filter-bar');
  const label   = document.getElementById('year-filter-label');
  const arrow   = document.getElementById('year-collapse-arrow');

  if (!toggle || !bar) return;

  // Toggle collapse open/close
  toggle.addEventListener('click', () => {
    const isOpen = bar.style.display !== 'none';
    bar.style.display  = isOpen ? 'none' : 'flex';
    toggle.classList.toggle('open', !isOpen);
  });

  // Year button clicks inside the bar
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.yflt-btn');
    if (!btn) return;
    document.querySelectorAll('.yflt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTableYear = btn.dataset.fyear;

    // Update the badge label
    label.textContent = currentTableYear === 'all' ? 'All' : currentTableYear;

    applyTableFilters();
  });
}

// ─── Trade Table ──────────────────────────────────────────────────────────
let allDisplayTrades = [];
let sortCol = 'date';
let sortAsc = false;

function renderTradeTable(trades) {
  allDisplayTrades = (trades || []).filter(t => t.signal);
  updateOutcomeCounts(allDisplayTrades);
  applyTableFilters();
  document.getElementById('table-meta').textContent = `(${allDisplayTrades.length} trades)`;
}

function renderTableRows(trades) {
  const filtered = trades;

  const tbody = document.getElementById('trade-tbody');
  tbody.innerHTML = '';

  for (const t of filtered) {
    if (!t.signal) continue;
    const s = t.signal;
    const pnl = t.pnl ?? 0;
    const pnlStr = pnl >= 0 ? `+$${pnl.toLocaleString()}` : `-$${Math.abs(pnl).toLocaleString()}`;
    const pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';

    const outcomeClass = {
      'TP1+TP2':      'pill-tp1tp2',
      'TP1+PARTIAL':  'pill-tp1part',
      'OPEN_PROFIT':  'pill-open-p',
      'BE':           'pill-be',
      'SL':           'pill-sl',
      'NO_ENTRY':     'pill-noentry',
      'OPEN_LOSS':    'pill-open-l',
      'NO_PRICE_DATA':'pill-nodata',
      'NO_LEVELS':    'pill-nodata',
      'INVALID_LEVELS':'pill-nodata',
    }[t.outcome] || 'pill-noentry';

    const outcomeLabel = {
      'TP1+TP2':      '✅ TP1+TP2',
      'TP1+PARTIAL':  '📈 TP1+Open',
      'OPEN_PROFIT':  '⏳ Open+',
      'BE':           '➖ Break Even',
      'SL':           '❌ Stop Loss',
      'NO_ENTRY':     '— No Entry',
      'OPEN_LOSS':    '⏳ Open–',
      'NO_PRICE_DATA':'⚠️ No Data',
      'NO_LEVELS':    '⚠️ No Levels',
    }[t.outcome] || t.outcome;

    const tr = document.createElement('tr');
    const costBasis = t.capitalDeployed
      ? `$${Math.round(t.capitalDeployed).toLocaleString()}`
      : '—';

    tr.innerHTML = `
      <td>${s.date}</td>
      <td class="ticker-cell">${s.ticker}</td>
      <td style="color:var(--text2)">${costBasis}</td>
      <td>$${s.price?.toFixed(2) ?? '—'}</td>
      <td>${t.entryPrice ? '$' + t.entryPrice.toFixed(2) : '—'}</td>
      <td>${t.slPrice    ? '$' + t.slPrice.toFixed(2)    : '—'}</td>
      <td>${t.tp1Price   ? '$' + t.tp1Price.toFixed(2)   : '—'}</td>
      <td>${t.exitPrice  ? '$' + t.exitPrice.toFixed(2)  : '—'}</td>
      <td class="${pnlClass}" style="font-weight:600">${pnl !== 0 ? pnlStr : '—'}</td>
      <td class="${pnl>0?'pos':pnl<0?'neg':''}">${t.rr ? t.rr + 'R' : '—'}</td>
      <td>${t.durationDays || '—'}</td>
      <td><span class="outcome-pill ${outcomeClass}">${outcomeLabel}</span></td>
      <td>${s.volZScore?.toFixed(1) ?? '—'}σ</td>
      <td>${s.callPct?.toFixed(0) ?? '—'}%</td>
      <td>${s.litScore ?? '—'}</td>
    `;
    tbody.appendChild(tr);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="15" style="text-align:center;color:var(--text3);padding:20px">No trades match filter</td></tr>`;
  }

  // ── Total Cost Basis footer ───────────────────────────────────────────────
  const table = document.getElementById('trade-table');
  // Remove any existing tfoot
  const oldFoot = table.querySelector('tfoot');
  if (oldFoot) oldFoot.remove();

  // Only show footer when there are executed trades with capitalDeployed
  const executedTrades = filtered.filter(t => t.capitalDeployed > 0);
  if (executedTrades.length === 0) return;

  const totalCost  = executedTrades.reduce((sum, t) => sum + (t.capitalDeployed || 0), 0);
  const totalPnl   = executedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const tradeCount = executedTrades.length;

  const pnlClass = totalPnl >= 0 ? 'pos' : 'neg';
  const pnlStr   = totalPnl >= 0
    ? `+$${Math.round(totalPnl).toLocaleString()}`
    : `-$${Math.abs(Math.round(totalPnl)).toLocaleString()}`;

  const tfoot = document.createElement('tfoot');
  tfoot.innerHTML = `
    <tr class="cost-total-row">
      <td colspan="2" style="text-align:right;padding-right:8px;color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.4px">
        Total (${tradeCount} trades)
      </td>
      <td style="font-weight:700;color:var(--accent);font-size:13px">
        $${Math.round(totalCost).toLocaleString()}
      </td>
      <td colspan="5" style="color:var(--text3);font-size:11px">
        &nbsp;
      </td>
      <td class="${pnlClass}" style="font-weight:700;font-size:13px">
        ${pnlStr}
      </td>
      <td colspan="6"></td>
    </tr>
  `;
  table.appendChild(tfoot);
}

// ─── Table Search ─────────────────────────────────────────────────────────
function setupSearch() {
  document.getElementById('table-search').addEventListener('input', () => {
    applyTableFilters();
  });
}

// ─── Table Sort ───────────────────────────────────────────────────────────
function setupTableSort() {
  const headers = ['date', 'ticker', 'cost_basis', 'signal_price', 'entry_price', 'sl', 'tp1', 'exit', 'pnl', 'rr', 'duration', 'outcome', 'zscore', 'callpct', 'lit'];
  document.querySelectorAll('.trade-table thead th').forEach((th, i) => {
    th.addEventListener('click', () => {
      const col = headers[i];
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = false; }
      sortTrades(col, sortAsc);
    });
  });
}

const colGetters = {
  date:         t => t.signal?.date || '',
  ticker:       t => t.signal?.ticker || '',
  cost_basis:   t => t.capitalDeployed || 0,
  signal_price: t => t.signal?.price || 0,
  entry_price:  t => t.entryPrice || 0,
  sl:           t => t.slPrice || 0,
  tp1:          t => t.tp1Price || 0,
  exit:         t => t.exitPrice || 0,
  pnl:          t => t.pnl || 0,
  rr:           t => t.rr || 0,
  duration:     t => t.durationDays || 0,
  outcome:      t => t.outcome || '',
  zscore:       t => t.signal?.volZScore || 0,
  callpct:      t => t.signal?.callPct || 0,
  lit:          t => t.signal?.litScore || 0,
};

function sortTrades(col, asc) {
  const getter = colGetters[col] || (t => 0);
  allDisplayTrades = [...allDisplayTrades].sort((a, b) => {
    const va = getter(a), vb = getter(b);
    if (typeof va === 'string') return asc ? va.localeCompare(vb) : vb.localeCompare(va);
    return asc ? va - vb : vb - va;
  });
  applyTableFilters();
}

// ════════════════════════════════════════════════════════════
// TA-ENHANCED BACKTEST — 3210 Guided · 2023-2025 Scored Signals
// ════════════════════════════════════════════════════════════

let taAllTrades = [];   // full scoreMin=0 run, used for comparison table
let taCurrentResults = null;

document.addEventListener('DOMContentLoaded', () => {
  loadTASignalSummary();
  loadCachedTAResults();
  setupTAControls();
  setupTAYearTabs();
  setupTAOutcomeTabs();
});

// ─── Controls ────────────────────────────────────────────────────────────────
function setupTAControls() {
  document.querySelectorAll('#ta-score-group .btn-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ta-score-group .btn-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.querySelectorAll('#ta-year-group .btn-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ta-year-group .btn-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  document.getElementById('ta-run-btn').addEventListener('click', startTABacktest);
}

function getTAScoreMin() { return parseInt(document.querySelector('#ta-score-group .btn-opt.active')?.dataset.val || '0'); }
function getTAYear()     { return document.querySelector('#ta-year-group .btn-opt.active')?.dataset.val || 'ALL'; }

// ─── Signal Summary ───────────────────────────────────────────────────────────
async function loadTASignalSummary() {
  try {
    const r = await fetch('/api/ta-signals-summary');
    const d = await r.json();
    if (!d.ok) return;
    const s = d.summary;
    document.getElementById('ta-sc-total').textContent = s.total.toLocaleString();
    document.getElementById('ta-sc-s8').textContent    = s.s8.toLocaleString();
    document.getElementById('ta-sc-s10').textContent   = s.s10.toLocaleString();
    document.getElementById('ta-sc-s12').textContent   = s.s12.toLocaleString();
    for (const y of [2023, 2024, 2025]) {
      document.getElementById(`ta-sc-${y}`).textContent = `${s.byYear[y].total} / ${s.byYear[y].s8} ≥8`;
    }
  } catch(e) {}
}

// ─── Load cached ─────────────────────────────────────────────────────────────
async function loadCachedTAResults() {
  try {
    const r = await fetch('/api/ta-results');
    const d = await r.json();
    if (!d.ok) return;
    taCurrentResults = d.results;
    taAllTrades = d.results.overall.trades;
    renderTAResults(d.results);
  } catch(e) {}
}

// ─── Run backtest ────────────────────────────────────────────────────────────
async function startTABacktest() {
  const scoreMin = getTAScoreMin();
  const year     = getTAYear();

  const runBtn  = document.getElementById('ta-run-btn');
  const progBar = document.getElementById('ta-progress-bar');
  const fill    = document.getElementById('ta-progress-fill');
  const log     = document.getElementById('ta-log-panel');
  const logC    = document.getElementById('ta-log-content');

  runBtn.disabled = true; runBtn.textContent = '⏳ Running…';
  progBar.style.display = 'block';
  log.style.display     = 'block';
  logC.innerHTML        = '';
  fill.style.width      = '0%';

  const url = `/api/run-ta-backtest?scoreMin=${scoreMin}&year=${year}`;
  const es  = new EventSource(url);

  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.msg) {
      const line = document.createElement('div');
      line.textContent = d.msg;
      logC.appendChild(line);
      logC.scrollTop = logC.scrollHeight;
    }
    if (d.progress != null) fill.style.width = d.progress + '%';
    if (d.type === 'complete' && d.results) {
      taCurrentResults = d.results;
      taAllTrades = d.results.overall.trades;
      renderTAResults(d.results);
      runBtn.disabled = false; runBtn.textContent = '▶ Run TA Backtest';
      fill.style.width = '100%';
      es.close();
    }
    if (d.type === 'error') {
      logC.innerHTML += `<div style="color:#f44">Error: ${d.msg}</div>`;
      runBtn.disabled = false; runBtn.textContent = '▶ Run TA Backtest';
      es.close();
    }
  };
  es.onerror = () => {
    runBtn.disabled = false; runBtn.textContent = '▶ Run TA Backtest';
    es.close();
  };
}

// ─── Client-side stats aggregation ───────────────────────────────────────────
function computeStats(trades) {
  const RISK = 8000;
  const counted = trades.filter(t => !['NO_ENTRY','NO_LEVELS','INVALID_LEVELS','NO_PRICE_DATA'].includes(t.outcome));
  const wins    = counted.filter(t => ['TP1+TP2','TP1+PARTIAL','OPEN_PROFIT'].includes(t.outcome));
  const losses  = counted.filter(t => t.outcome === 'SL');
  const bes     = counted.filter(t => t.outcome === 'BE');
  const totalPnl = counted.reduce((s,t) => s + (t.pnl||0), 0);
  const grossP   = counted.filter(t => t.pnl > 0).reduce((s,t) => s + t.pnl, 0);
  const grossL   = Math.abs(counted.filter(t => t.pnl < 0).reduce((s,t) => s + t.pnl, 0));
  const pf       = grossL > 0 ? (grossP / grossL).toFixed(2) : grossP > 0 ? '∞' : '0';
  const avgRR    = counted.length ? (counted.reduce((s,t) => s + (t.rr||0), 0) / counted.length).toFixed(2) : 0;
  return {
    total: trades.length, traded: counted.length,
    wins: wins.length, losses: losses.length, bes: bes.length,
    winRate: counted.length ? (100 * wins.length / counted.length).toFixed(1) : 0,
    totalPnl: +totalPnl.toFixed(2), pf, avgRR,
    bestTrade: counted.length ? Math.max(...counted.map(t => t.pnl||0)) : 0,
    worstTrade: counted.length ? Math.min(...counted.map(t => t.pnl||0)) : 0,
    avgDur: counted.length ? (counted.reduce((s,t) => s + (t.durationDays||0), 0) / counted.length).toFixed(1) : 0,
    noEntry: trades.filter(t => t.outcome === 'NO_ENTRY').length,
  };
}

// ─── Render TA Results ────────────────────────────────────────────────────────
function renderTAResults(results) {
  document.getElementById('ta-results-section').style.display = 'block';
  const s = results.overall.stats;
  const scoreMin = results.config?.scoreMin ?? 0;
  const scoreLabels = { 0: '📋 All Signals', 8: '⭐ Score ≥ 8 (3210 Guided)', 10: '🎯 Score ≥ 10 (POI+AM Aligned)', 12: '⚡ Score ≥ 12 (Fully Aligned)' };

  document.getElementById('ta-score-label').textContent = scoreLabels[scoreMin] || '';

  // Perf cards
  const fmt = (n, sign=true) => n == null ? '—' : (sign && n>0 ? '+' : '') + (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
  document.getElementById('ta-r-pnl').textContent      = fmt(s.totalPnl);
  document.getElementById('ta-r-pnl').className        = 'stat-val ' + (s.totalPnl >= 0 ? 'pos' : 'neg');
  document.getElementById('ta-r-winrate').textContent  = s.winRate + '%';
  document.getElementById('ta-r-trades').textContent   = s.tradesExecuted;
  document.getElementById('ta-r-wins').textContent     = s.winCount;
  document.getElementById('ta-r-losses').textContent   = s.lossCount;
  document.getElementById('ta-r-be').textContent       = s.beCount;
  document.getElementById('ta-r-noentry').textContent  = s.noEntryCount;
  document.getElementById('ta-r-avgrr').textContent    = '+' + s.avgRR + 'R';
  document.getElementById('ta-r-avgdur').textContent   = s.avgDurationDays + 'd';
  document.getElementById('ta-r-besttrade').textContent  = fmt(s.bestTrade);
  document.getElementById('ta-r-worsttrade').textContent = fmt(s.worstTrade);
  document.getElementById('ta-r-pf').textContent       = s.profitFactor;

  renderTAComparisonTable();
  renderTAYearBreakdown(results);
  renderTACharts(results);
  renderTATradeTable(results.overall.trades, 'all');
  updateTAOutcomeTabCounts(results.overall.trades);
}

// ─── Comparison Table (all score thresholds) ─────────────────────────────────
function renderTAComparisonTable() {
  const tbody = document.getElementById('ta-comparison-tbody');
  tbody.innerHTML = '';

  const tiers = [
    { scoreMin: 0,  label: '📋 All Signals',          condition: '—',                            color: '' },
    { scoreMin: 8,  label: '⭐ Score ≥ 8',            condition: 'BULLISH + SOS',                color: '#4caf50' },
    { scoreMin: 10, label: '🎯 Score ≥ 10',           condition: 'BULLISH + SOS + AM Buy + POI', color: '#00d4a8' },
    { scoreMin: 12, label: '⚡ Score ≥ 12',           condition: '+ FIB 0.50 (Fully 3210)',      color: '#ff9800' },
  ];

  for (const tier of tiers) {
    const filtered = taAllTrades.filter(t => !t.signal || (t.signal.score ?? 0) >= tier.scoreMin);
    if (filtered.length === 0) continue;
    const s = computeStats(filtered);

    const pnlClass  = s.totalPnl >= 0 ? 'pos' : 'neg';
    const pnlStr    = s.totalPnl >= 0
      ? `+$${Math.round(s.totalPnl).toLocaleString()}`
      : `-$${Math.abs(Math.round(s.totalPnl)).toLocaleString()}`;
    const winCls    = parseFloat(s.winRate) >= 55 ? 'pos' : parseFloat(s.winRate) >= 45 ? '' : 'neg';
    const pfCls     = parseFloat(s.pf) >= 2 ? 'pos' : parseFloat(s.pf) >= 1.2 ? '' : 'neg';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:600;color:${tier.color||'var(--text1)'}">${tier.label}</td>
      <td style="color:var(--text3);font-size:11px">${tier.condition}</td>
      <td>${s.total}</td>
      <td>${s.traded}</td>
      <td class="${winCls}" style="font-weight:700;font-size:14px">${s.winRate}%</td>
      <td class="${pnlClass}" style="font-weight:700">${pnlStr}</td>
      <td>${s.avgRR}R</td>
      <td style="color:#4caf50">${s.wins}</td>
      <td style="color:#f44336">${s.losses}</td>
      <td style="color:#888">${s.bes}</td>
      <td class="${pfCls}" style="font-weight:600">${s.pf}x</td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Year Breakdown ───────────────────────────────────────────────────────────
let taCurrentYearTab = 'all';

function setupTAYearTabs() {
  document.querySelectorAll('#ta-year-tabs .year-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ta-year-tabs .year-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      taCurrentYearTab = btn.dataset.year;
      if (taCurrentResults) renderTAYearBreakdown(taCurrentResults);
    });
  });
}

function renderTAYearBreakdown(results) {
  const grid = document.getElementById('ta-year-stats-grid');
  grid.innerHTML = '';
  const years = taCurrentYearTab === 'all' ? [2023, 2024, 2025] : [parseInt(taCurrentYearTab)];

  for (const yr of years) {
    const yd = results.byYear[yr];
    if (!yd) continue;
    const s = yd.stats;
    const pnlClass = s.totalPnl >= 0 ? 'pos' : 'neg';
    const pnlStr   = s.totalPnl >= 0
      ? `+$${Math.round(s.totalPnl).toLocaleString()}`
      : `-$${Math.abs(Math.round(s.totalPnl)).toLocaleString()}`;
    const card = document.createElement('div');
    card.className = 'year-stat-card';
    card.innerHTML = `
      <div class="ysc-header">📅 ${yr}</div>
      <div class="ysc-pnl ${pnlClass}">${pnlStr}</div>
      <div class="ysc-wr">Win Rate: <strong>${s.winRate}%</strong></div>
      <div class="ysc-detail">${s.tradesExecuted} trades · ${s.winCount}W ${s.lossCount}L ${s.beCount}BE</div>
      <div class="ysc-detail">Avg RR: ${s.avgRR}R · Avg ${s.avgDurationDays}d</div>
      <div class="ysc-detail">Profit Factor: ${s.profitFactor}</div>
    `;
    grid.appendChild(card);
  }
}

// ─── Charts ───────────────────────────────────────────────────────────────────
let taCharts = {};

function renderTACharts(results) {
  const years = [2023, 2024, 2025];
  const pnls     = years.map(y => results.byYear[y]?.stats.totalPnl || 0);
  const winRates = years.map(y => results.byYear[y]?.stats.winRate || 0);

  destroyTAChart('ta-chart-pnl-year');
  destroyTAChart('ta-chart-winrate-year');
  destroyTAChart('ta-chart-outcomes');
  destroyTAChart('ta-chart-score');

  const barClr = (vals) => vals.map(v => v >= 0 ? 'rgba(76,175,80,0.8)' : 'rgba(244,67,54,0.8)');

  taCharts['ta-chart-pnl-year'] = new Chart(document.getElementById('ta-chart-pnl-year'), {
    type: 'bar',
    data: { labels: years.map(String), datasets: [{ data: pnls, backgroundColor: barClr(pnls), borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k', color: '#aaa' }, grid: { color: '#2a2a3e' } }, x: { ticks: { color: '#aaa' } } } },
  });

  taCharts['ta-chart-winrate-year'] = new Chart(document.getElementById('ta-chart-winrate-year'), {
    type: 'bar',
    data: { labels: years.map(String), datasets: [{ data: winRates, backgroundColor: 'rgba(0,212,168,0.7)', borderRadius: 6 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%', color: '#aaa' }, grid: { color: '#2a2a3e' } }, x: { ticks: { color: '#aaa' } } } },
  });

  // Outcome donut
  const s = results.overall.stats;
  taCharts['ta-chart-outcomes'] = new Chart(document.getElementById('ta-chart-outcomes'), {
    type: 'doughnut',
    data: {
      labels: ['Wins', 'Losses', 'BE', 'No Entry'],
      datasets: [{ data: [s.winCount, s.lossCount, s.beCount, s.noEntryCount],
        backgroundColor: ['#4caf50','#f44336','#9e9e9e','#37474f'], borderWidth: 0 }],
    },
    options: { cutout: '65%', plugins: { legend: { position: 'right', labels: { color: '#ccc', font: { size: 11 } } } } },
  });

  // Score comparison bar chart
  const tiers = [0, 8, 10, 12];
  const tierLabels = ['All', '≥8', '≥10', '≥12'];
  const tierWR = tiers.map(sc => {
    const ft = taAllTrades.filter(t => !t.signal || (t.signal.score ?? 0) >= sc);
    return ft.length ? computeStats(ft).winRate : 0;
  });
  taCharts['ta-chart-score'] = new Chart(document.getElementById('ta-chart-score'), {
    type: 'bar',
    data: {
      labels: tierLabels,
      datasets: [{
        label: 'Win Rate %',
        data: tierWR,
        backgroundColor: ['rgba(100,100,120,0.8)', 'rgba(76,175,80,0.8)', 'rgba(0,212,168,0.8)', 'rgba(255,152,0,0.8)'],
        borderRadius: 8,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: v => v + '%', color: '#aaa' }, grid: { color: '#2a2a3e' } },
        x: { ticks: { color: '#ccc', font: { size: 13, weight: 'bold' } } },
      },
    },
  });
}

function destroyTAChart(id) {
  if (taCharts[id]) { taCharts[id].destroy(); delete taCharts[id]; }
}

// ─── Outcome Tabs ─────────────────────────────────────────────────────────────
let taCurrentOutcomeTab = 'all';

function setupTAOutcomeTabs() {
  document.querySelectorAll('#ta-outcome-tabs .outcome-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#ta-outcome-tabs .outcome-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      taCurrentOutcomeTab = btn.dataset.outcome;
      if (taCurrentResults) renderTATradeTable(taCurrentResults.overall.trades, taCurrentOutcomeTab);
    });
  });
}

function updateTAOutcomeTabCounts(trades) {
  const wins  = trades.filter(t => ['TP1+TP2','TP1+PARTIAL','OPEN_PROFIT'].includes(t.outcome));
  const sl    = trades.filter(t => t.outcome === 'SL');
  const ne    = trades.filter(t => t.outcome === 'NO_ENTRY');
  document.getElementById('ta-otab-all').textContent     = trades.length;
  document.getElementById('ta-otab-wins').textContent    = wins.length;
  document.getElementById('ta-otab-sl').textContent      = sl.length;
  document.getElementById('ta-otab-noentry').textContent = ne.length;
}

// ─── Trades Table ─────────────────────────────────────────────────────────────
function renderTATradeTable(trades, filter) {
  const tbody = document.getElementById('ta-trade-tbody');
  tbody.innerHTML = '';

  let filtered;
  switch(filter) {
    case 'wins':    filtered = trades.filter(t => ['TP1+TP2','TP1+PARTIAL','OPEN_PROFIT'].includes(t.outcome)); break;
    case 'sl':      filtered = trades.filter(t => t.outcome === 'SL'); break;
    case 'noentry': filtered = trades.filter(t => t.outcome === 'NO_ENTRY'); break;
    default:        filtered = [...trades]; break;
  }

  filtered.sort((a, b) => (a.signal?.date || '').localeCompare(b.signal?.date || ''));

  const meta = document.getElementById('ta-table-meta');
  const exe  = filtered.filter(t => !['NO_ENTRY','NO_LEVELS','INVALID_LEVELS','NO_PRICE_DATA'].includes(t.outcome));
  const totPnl = exe.reduce((s,t) => s + (t.pnl||0), 0);
  meta.textContent = `(${filtered.length} trades · P&L: ${totPnl >= 0 ? '+' : ''}$${Math.round(totPnl).toLocaleString()})`;

  const WIN_OUTCOMES = ['TP1+TP2','TP1+PARTIAL','OPEN_PROFIT'];

  // Group by year
  const byYear = {};
  for (const t of filtered) {
    const yr = t.signal?.year || t.signal?.date?.slice(0,4) || 'Unknown';
    if (!byYear[yr]) byYear[yr] = [];
    byYear[yr].push(t);
  }

  const years = Object.keys(byYear).sort();

  if (years.length === 0) {
    tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;color:var(--text3);padding:20px">No trades match filter</td></tr>`;
    return;
  }

  for (const yr of years) {
    const yrTrades = byYear[yr];
    const yrExe    = yrTrades.filter(t => !['NO_ENTRY','NO_LEVELS','INVALID_LEVELS','NO_PRICE_DATA'].includes(t.outcome));
    const yrWins   = yrExe.filter(t => WIN_OUTCOMES.includes(t.outcome));
    const yrPnl    = yrExe.reduce((s,t) => s + (t.pnl||0), 0);
    const yrWR     = yrExe.length ? Math.round(100 * yrWins.length / yrExe.length) : 0;
    const yrPnlStr = (yrPnl >= 0 ? '+$' : '-$') + Math.abs(Math.round(yrPnl)).toLocaleString();
    const yrPnlCol = yrPnl >= 0 ? '#4caf50' : '#f44336';

    // Year separator row
    const sep = document.createElement('tr');
    sep.style.cssText = 'background:linear-gradient(90deg,rgba(30,40,70,0.95) 0%,rgba(20,28,55,0.95) 100%);border-top:2px solid rgba(79,140,255,0.35);border-bottom:1px solid rgba(79,140,255,0.2);';
    sep.innerHTML = `
      <td colspan="14" style="padding:8px 14px;">
        <span style="font-size:13px;font-weight:700;color:#4f8cff;letter-spacing:1px;">
          📅 ${yr}
        </span>
        <span style="margin-left:14px;font-size:12px;color:#aaa;">
          ${yrTrades.length} signals &nbsp;·&nbsp;
          <span style="color:#ccc;">${yrExe.length} traded</span> &nbsp;·&nbsp;
          Win Rate: <span style="font-weight:700;color:${yrWR>=55?'#4caf50':yrWR>=45?'#ffb300':'#f44336'}">${yrWR}%</span>
          &nbsp;(${yrWins.length}W / ${yrExe.length - yrWins.length}L)
          &nbsp;·&nbsp; P&L: <span style="font-weight:700;color:${yrPnlCol}">${yrPnlStr}</span>
        </span>
      </td>
    `;
    tbody.appendChild(sep);

    // Trade rows for this year
    for (const t of yrTrades) {
      const s       = t.signal || {};
      const pnl     = t.pnl || 0;
      const pnlClass = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';
      const pnlStr   = pnl !== 0 ? (pnl > 0 ? '+$' : '-$') + Math.abs(Math.round(pnl)).toLocaleString() : '—';

      const outcomeClass = WIN_OUTCOMES.includes(t.outcome) ? 'pill-win'
        : t.outcome === 'SL' ? 'pill-loss'
        : t.outcome === 'BE' ? 'pill-be'
        : 'pill-noentry';
      const outcomeLabel = {
        'TP1+TP2':'✅ TP1+TP2','TP1+PARTIAL':'📈 TP1+Open','OPEN_PROFIT':'⏳ Open+',
        'BE':'➖ Break Even','SL':'❌ Stop Loss','NO_ENTRY':'— No Entry',
        'OPEN_LOSS':'⏳ Open–','NO_PRICE_DATA':'⚠️ No Data','NO_LEVELS':'⚠️ No Levels',
      }[t.outcome] || t.outcome;

      const score = s.score ?? '—';
      const scoreColor = score >= 12 ? '#ff9800' : score >= 10 ? '#00d4a8' : score >= 8 ? '#4caf50' : '#888';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${s.date || '—'}</td>
        <td class="ticker-cell">${s.ticker || '—'}</td>
        <td style="font-weight:700;color:${scoreColor}">${score}</td>
        <td>${t.entryPrice ? '$' + t.entryPrice.toFixed(2) : '—'}</td>
        <td>${t.slPrice    ? '$' + t.slPrice.toFixed(2)    : '—'}</td>
        <td>${t.tp1Price   ? '$' + t.tp1Price.toFixed(2)   : '—'}</td>
        <td>${t.exitPrice  ? '$' + t.exitPrice.toFixed(2)  : '—'}</td>
        <td class="${pnlClass}" style="font-weight:600">${pnlStr}</td>
        <td class="${pnl>0?'pos':pnl<0?'neg':''}">${t.rr ? t.rr + 'R' : '—'}</td>
        <td>${t.durationDays || '—'}</td>
        <td><span class="outcome-pill ${outcomeClass}">${outcomeLabel}</span></td>
        <td>${s.volZScore?.toFixed(1) ?? '—'}σ</td>
        <td>${s.callPct?.toFixed(0) ?? '—'}%</td>
        <td>${s.litScore ?? '—'}</td>
      `;
      tbody.appendChild(tr);
    }
  }
}
