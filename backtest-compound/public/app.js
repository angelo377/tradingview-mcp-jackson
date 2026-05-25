// UOA Compounding Backtest Dashboard — Frontend JS

let currentResults    = null;
let currentYearTab    = 'all';
let currentTableYear  = 'all';
let currentOutcomeTab = 'all';
let charts            = {};

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

// ─── Controls ────────────────────────────────────────────────────────────────
function setupControls() {
  document.querySelectorAll('#year-group .btn-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#year-group .btn-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
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

function getSelectedYear() { return document.querySelector('#year-group .btn-opt.active')?.dataset.val || 'ALL'; }
function getHPOnly()       { return document.getElementById('hp-toggle').classList.contains('active'); }

// ─── Signal Summary ───────────────────────────────────────────────────────────
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

// ─── Load cached results ──────────────────────────────────────────────────────
async function loadCachedResults() {
  try {
    const r = await fetch('/api/results');
    const d = await r.json();
    if (!d.ok) return;
    currentResults = d.results;
    renderResults(d.results);
  } catch(e) {}
}

// ─── Run Backtest ─────────────────────────────────────────────────────────────
function startBacktest() {
  const year   = getSelectedYear();
  const hpOnly = getHPOnly();

  const btn = document.getElementById('run-btn');
  btn.disabled    = true;
  btn.textContent = '⏳ Running...';

  const progressBar  = document.getElementById('progress-bar');
  const progressFill = document.getElementById('progress-fill');
  const logPanel     = document.getElementById('log-panel');
  const logContent   = document.getElementById('log-content');

  progressBar.style.display = 'block';
  logPanel.style.display    = 'block';
  logContent.innerHTML      = '';
  progressFill.style.width  = '0%';

  const url = `/api/run-backtest?year=${year}&hpOnly=${hpOnly}`;
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
      btn.disabled    = false;
      btn.textContent = '▶ Run Backtest';
      evtSource.close();
    }

    if (data.type === 'error') {
      const div = document.createElement('div');
      div.style.color = '#f85149';
      div.textContent = '❌ Error: ' + data.msg;
      logContent.appendChild(div);
      btn.disabled    = false;
      btn.textContent = '▶ Run Backtest';
      evtSource.close();
    }
  };

  evtSource.onerror = () => {
    btn.disabled    = false;
    btn.textContent = '▶ Run Backtest';
    evtSource.close();
  };
}

// ─── Render Results ───────────────────────────────────────────────────────────
let allResultsRef = null;

function renderResults(results) {
  if (!results) return;
  allResultsRef = results;
  document.getElementById('results-section').style.display = 'block';

  const stats = results.overall.stats;
  renderCompoundCards(stats, results);
  renderCapitalCurve(results.capitalCurve);
  renderYearStatsGrid(results);
  renderCharts(results);
  renderTradeTable(results.overall.trades);
  document.getElementById('table-meta').textContent = `(${results.overall.trades.filter(t => t.entryDate).length} trades)`;

  monthlyChartYear = 'all';
  document.querySelectorAll('.myt-btn').forEach(b => b.classList.remove('active'));
  const allMyt = document.querySelector('.myt-btn[data-year="all"]');
  if (allMyt) allMyt.classList.add('active');

  currentTableYear = 'all';
  document.querySelectorAll('.yflt-btn').forEach(b => b.classList.remove('active'));
  const allYflt = document.querySelector('.yflt-btn[data-fyear="all"]');
  if (allYflt) allYflt.classList.add('active');
  const lbl = document.getElementById('year-filter-label');
  if (lbl) lbl.textContent = 'All';
  const bar = document.getElementById('year-filter-bar');
  const tog = document.getElementById('year-collapse-toggle');
  if (bar) bar.style.display = 'none';
  if (tog) tog.classList.remove('open');
}

// ─── Compounding Headline Cards ───────────────────────────────────────────────
function renderCompoundCards(stats, results) {
  const finalCap    = results.finalCapital  || (400000 + stats.totalPnl);
  const totalReturn = results.totalReturnPct || stats.totalReturnPct || 0;
  const maxDD       = stats.maxDrawdownPct  || 0;

  const fmtDollar = v => v >= 0 ? `$${Math.round(v).toLocaleString()}` : `-$${Math.abs(Math.round(v)).toLocaleString()}`;
  const fmtPnl    = v => v >= 0 ? `+$${Math.round(v).toLocaleString()}` : `-$${Math.abs(Math.round(v)).toLocaleString()}`;

  setVal('r-final-capital', fmtDollar(finalCap), finalCap >= 400000 ? 'pos' : 'neg');
  setVal('r-total-return',  (totalReturn >= 0 ? '+' : '') + totalReturn + '%', totalReturn >= 0 ? 'pos' : 'neg');
  setVal('r-total-pnl',     fmtPnl(stats.totalPnl), stats.totalPnl >= 0 ? 'pos' : 'neg');
  setVal('r-maxdd',         maxDD.toFixed(1) + '%', 'neg');
  setVal('r-winrate',       stats.winRate + '%', stats.winRate >= 50 ? 'pos' : 'neg');
  setVal('r-trades',        stats.tradesExecuted, 'neu');
  setVal('r-wins',          stats.winCount, 'pos');
  setVal('r-losses',        stats.lossCount, stats.lossCount > 0 ? 'neg' : 'neu');
  setVal('r-be',            stats.beCount, 'neu');
  setVal('r-avgrr',         (stats.avgRR >= 0 ? '+' : '') + stats.avgRR + 'R', stats.avgRR >= 1 ? 'pos' : 'neg');
  setVal('r-avgdur',        stats.avgDurationDays + 'd', 'neu');
  setVal('r-pf',            stats.profitFactor, stats.profitFactor >= 2 ? 'pos' : stats.profitFactor >= 1 ? 'neu' : 'neg');
}

function setVal(id, val, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.className   = `stat-val ${cls || ''}`;
}

// ─── Capital Growth Curve Chart ───────────────────────────────────────────────
function renderCapitalCurve(capitalCurve) {
  if (!capitalCurve || capitalCurve.length < 2) return;

  const labels  = capitalCurve.map(pt => pt.label);
  const data    = capitalCurve.map(pt => pt.capital);
  const start   = data[0];
  const final   = data[data.length - 1];
  const isProfit = final >= start;

  const lineColor = isProfit ? '#3fb950' : '#f85149';
  const gradStart = isProfit ? 'rgba(63,185,80,0.25)' : 'rgba(248,81,73,0.2)';

  destroyChart('capital-curve');
  charts['capital-curve'] = new Chart(document.getElementById('chart-capital-curve'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Running Capital ($)',
        data,
        borderColor: lineColor,
        backgroundColor: (ctx) => {
          const c = ctx.chart.ctx;
          const g = c.createLinearGradient(0, 0, 0, 280);
          g.addColorStop(0, gradStart);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          return g;
        },
        fill: true,
        tension: 0.35,
        pointRadius: data.length > 80 ? 0 : 3,
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
              const pt  = capitalCurve[ctx.dataIndex];
              const cap = ctx.raw;
              const pnl = pt.pnl != null ? ` (${pt.pnl >= 0 ? '+' : ''}$${Math.round(pt.pnl).toLocaleString()})` : '';
              return ` $${Math.round(cap).toLocaleString()}${pnl} — ${pt.outcome || ''}`;
            },
            title: ctx => capitalCurve[ctx[0]?.dataIndex]?.label || ''
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
            color: '#8b949e',
            font: { size: 10 },
            maxTicksLimit: 20,
            maxRotation: 0,
            callback: (val, idx) => {
              // Show every Nth label to avoid crowding
              const step = Math.ceil(data.length / 20);
              return idx % step === 0 ? labels[idx] : '';
            }
          },
          grid: { color: 'rgba(48,54,61,0.8)' }
        },
        y: {
          ticks: {
            color: '#8b949e',
            font: { size: 11 },
            callback: v => `$${(v / 1000).toFixed(0)}K`
          },
          grid: { color: 'rgba(48,54,61,0.8)' }
        }
      }
    }
  });
}

// ─── Year Stats Grid ──────────────────────────────────────────────────────────
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
          <span style="color:${s.winRate >= 50 ? '#3fb950' : '#f85149'};font-weight:600">${s.winRate}%</span>
        </div>
        <div style="font-size:11px;color:var(--text3)">
          ${s.tradesExecuted} trades · ${s.winCount}W ${s.lossCount}L ${s.beCount}BE
        </div>
        <div style="font-size:11px;color:var(--text3)">
          Avg RR: ${s.avgRR}R · Avg ${s.avgDurationDays}d
        </div>
        <div style="font-size:11px;margin-top:3px">
          <span style="color:var(--text3)">Profit Factor: </span>
          <span style="color:${s.profitFactor >= 2 ? '#3fb950' : s.profitFactor >= 1 ? '#d29922' : '#f85149'};font-weight:600">${s.profitFactor}</span>
        </div>
        ${s.maxDrawdownPct != null ? `
        <div style="font-size:11px;margin-top:2px">
          <span style="color:var(--text3)">Max DD: </span>
          <span style="color:#f85149;font-weight:600">${s.maxDrawdownPct}%</span>
        </div>` : ''}
      </div>`;
  }
}

// ─── Year Tabs ────────────────────────────────────────────────────────────────
function setupYearTabs() {
  document.getElementById('year-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.year-tab');
    if (!btn) return;
    document.querySelectorAll('.year-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentYearTab = btn.dataset.year;
    currentOutcomeTab = 'all';
    currentTableYear  = 'all';
    document.querySelectorAll('.outcome-tab').forEach(b => b.classList.remove('active'));
    const allTab = document.querySelector('.outcome-tab[data-outcome="all"]');
    if (allTab) allTab.classList.add('active');
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

// ─── Charts ───────────────────────────────────────────────────────────────────
const CHART_DEFAULTS = { color: '#e6edf3', grid: 'rgba(48,54,61,0.8)' };

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function renderCharts(results) {
  const years = Object.keys(results.byYear).sort().map(Number);
  const pnls  = years.map(y => results.byYear[y].stats.totalPnl);
  const wrs   = years.map(y => results.byYear[y].stats.winRate);
  const rrs   = years.map(y => results.byYear[y].stats.avgRR);

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
        borderWidth: 1, borderRadius: 6,
      }]
    },
    options: barChartOpts('$'),
  });

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
        borderWidth: 1, borderRadius: 6,
      }]
    },
    options: barChartOpts('%'),
  });

  // Outcome doughnut
  const allTrades = results.overall.trades;
  const outcomeMap = {
    'TP1+TP2':      { label: 'TP1+TP2 Win',   color: '#3fb950' },
    'TP1+PARTIAL':  { label: 'TP1+Partial',    color: '#7ee787' },
    'OPEN_PROFIT':  { label: 'Open (Profit)',   color: '#39d0d8' },
    'BE':           { label: 'Break Even',      color: '#d29922' },
    'SL':           { label: 'Stop Loss',       color: '#f85149' },
    'OPEN_LOSS':    { label: 'Open (Loss)',     color: '#ffa198' },
    'NO_ENTRY':     { label: 'No Entry',        color: '#484f58' },
    'NO_PRICE_DATA':{ label: 'No Data',         color: '#30363d' },
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
        borderColor: '#161b22', borderWidth: 2,
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
        borderWidth: 1, borderRadius: 6,
      }]
    },
    options: barChartOpts('R'),
  });

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

// ─── Monthly Chart ────────────────────────────────────────────────────────────
let monthlyChartYear = 'all';

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
  const monthPnl = {};

  if (isSpecificYear) {
    const y = String(yearLabel);
    for (let m = 1; m <= 12; m++) {
      monthPnl[`${y}-${String(m).padStart(2,'0')}`] = 0;
    }
    const janKey = `${y}-01`, decKey = `${y}-12`;
    for (const t of trades) {
      if (t.pnl == null) continue;
      const raw = t.exitDate || t.signal?.date;
      if (!raw) continue;
      let month = raw.slice(0, 7);
      if (month < janKey) month = janKey;
      if (month > decKey) month = decKey;
      monthPnl[month] = (monthPnl[month] || 0) + t.pnl;
    }
  } else {
    for (const t of trades) {
      if (!t.exitDate || t.pnl == null) continue;
      const month = t.exitDate.slice(0, 7);
      monthPnl[month] = (monthPnl[month] || 0) + t.pnl;
    }
  }

  const months  = Object.keys(monthPnl).sort();
  let cumPnl    = 0;
  const cumData = months.map(m => { cumPnl += monthPnl[m]; return +cumPnl.toFixed(2); });

  renderMonthlyStatsBar(trades, cumData);

  const finalPnl  = cumData.length ? cumData[cumData.length - 1] : 0;
  const lineColor = finalPnl >= 0 ? '#3fb950' : '#f85149';
  const gradStart = finalPnl >= 0 ? 'rgba(63,185,80,0.3)' : 'rgba(248,81,73,0.25)';

  const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const displayLabels = isSpecificYear
    ? months.map(m => shortMonths[parseInt(m.slice(5,7)) - 1])
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
            title: ctx => isSpecificYear ? `${ctx[0]?.label} ${yearLabel}` : ctx[0]?.label || '',
          },
          backgroundColor: '#21262d', borderColor: '#30363d', borderWidth: 1,
          titleColor: '#8b949e', bodyColor: '#e6edf3',
        }
      },
      scales: {
        x: {
          ticks: { color: CHART_DEFAULTS.color, font: { size: isSpecificYear ? 11 : 10 }, maxTicksLimit: isSpecificYear ? 12 : 24 },
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
  const executed = trades.filter(t => t.entryDate);
  const totalPnl = executed.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins     = executed.filter(t => OUTCOME_WIN_KEYS.includes(t.outcome));
  const losses   = executed.filter(t => OUTCOME_SL_KEYS.includes(t.outcome));
  const winRate  = executed.length ? (100 * wins.length / executed.length).toFixed(1) : '—';
  const maxPeak  = cumData.length ? Math.max(...cumData) : 0;
  const maxDD    = cumData.length ? (() => {
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
    <div class="mstat"><span class="mstat-label">Peak P&amp;L:</span> ${fmtPnl(maxPeak)}</div>
    <div class="mstat"><span class="mstat-label">Max Drawdown:</span> <span class="mstat-val neg">-$${Math.round(maxDD).toLocaleString()}</span></div>
  `;
}

// ─── Outcome Tabs ─────────────────────────────────────────────────────────────
const OUTCOME_WIN_KEYS     = ['TP1+TP2', 'TP1+PARTIAL', 'OPEN_PROFIT'];
const OUTCOME_SL_KEYS      = ['SL'];
const OUTCOME_NOENTRY_KEYS = ['NO_ENTRY', 'NO_PRICE_DATA', 'NO_LEVELS', 'INVALID_LEVELS'];

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
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
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
  if (currentTableYear !== 'all') {
    trades = trades.filter(t => t.signal?.date?.startsWith(currentTableYear));
  }
  trades = filterByOutcome(trades, currentOutcomeTab);
  if (search) trades = trades.filter(t => t.signal?.ticker?.toUpperCase().includes(search));
  renderTableRows(trades);
}

// ─── Table Year Filter ────────────────────────────────────────────────────────
function setupTableYearFilter() {
  const toggle = document.getElementById('year-collapse-toggle');
  const bar    = document.getElementById('year-filter-bar');
  const label  = document.getElementById('year-filter-label');

  if (!toggle || !bar) return;

  toggle.addEventListener('click', () => {
    const isOpen = bar.style.display !== 'none';
    bar.style.display = isOpen ? 'none' : 'flex';
    toggle.classList.toggle('open', !isOpen);
  });

  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.yflt-btn');
    if (!btn) return;
    document.querySelectorAll('.yflt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTableYear = btn.dataset.fyear;
    label.textContent = currentTableYear === 'all' ? 'All' : currentTableYear;
    applyTableFilters();
  });
}

// ─── Trade Table ──────────────────────────────────────────────────────────────
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
  const tbody = document.getElementById('trade-tbody');
  tbody.innerHTML = '';

  for (const t of trades) {
    if (!t.signal) continue;
    const s = t.signal;
    const pnl    = t.pnl ?? 0;
    const pnlStr = pnl >= 0 ? `+$${pnl.toLocaleString()}` : `-$${Math.abs(pnl).toLocaleString()}`;
    const pnlCls = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : '';

    // Running capital after this trade (from capitalCurve lookup if available)
    const capAfterStr = t.capitalAfter != null
      ? `$${Math.round(t.capitalAfter).toLocaleString()}`
      : '—';

    const riskStr = t.riskUsed ? `$${Math.round(t.riskUsed).toLocaleString()}` : '—';

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
    tr.innerHTML = `
      <td>${s.date}</td>
      <td class="ticker-cell">${s.ticker}</td>
      <td style="color:#f0883e;font-weight:600">${riskStr}</td>
      <td>${t.entryPrice ? '$' + t.entryPrice.toFixed(2) : '—'}</td>
      <td>${t.slPrice    ? '$' + t.slPrice.toFixed(2)    : '—'}</td>
      <td>${t.tp1Price   ? '$' + t.tp1Price.toFixed(2)   : '—'}</td>
      <td>${t.exitPrice  ? '$' + t.exitPrice.toFixed(2)  : '—'}</td>
      <td class="${pnlCls}" style="font-weight:600">${pnl !== 0 ? pnlStr : '—'}</td>
      <td class="${pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : ''}">${t.rr ? t.rr + 'R' : '—'}</td>
      <td>${t.durationDays || '—'}</td>
      <td><span class="outcome-pill ${outcomeClass}">${outcomeLabel}</span></td>
      <td style="color:var(--text2);font-size:11px">${capAfterStr}</td>
      <td>${s.volZScore?.toFixed(1) ?? '—'}σ</td>
      <td>${s.callPct?.toFixed(0) ?? '—'}%</td>
    `;
    tbody.appendChild(tr);
  }

  if (trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="14" style="text-align:center;color:var(--text3);padding:20px">No trades match filter</td></tr>`;
  }
}

// ─── Search ───────────────────────────────────────────────────────────────────
function setupSearch() {
  document.getElementById('table-search').addEventListener('input', () => {
    applyTableFilters();
  });
}

// ─── Table Sort ───────────────────────────────────────────────────────────────
const colGetters = {
  date:        t => t.signal?.date || '',
  ticker:      t => t.signal?.ticker || '',
  risk_used:   t => t.riskUsed || 0,
  entry_price: t => t.entryPrice || 0,
  sl:          t => t.slPrice || 0,
  tp1:         t => t.tp1Price || 0,
  exit:        t => t.exitPrice || 0,
  pnl:         t => t.pnl || 0,
  rr:          t => t.rr || 0,
  duration:    t => t.durationDays || 0,
  outcome:     t => t.outcome || '',
  cap_after:   t => t.capitalAfter || 0,
  zscore:      t => t.signal?.volZScore || 0,
  callpct:     t => t.signal?.callPct || 0,
};

function setupTableSort() {
  const headers = ['date', 'ticker', 'risk_used', 'entry_price', 'sl', 'tp1', 'exit', 'pnl', 'rr', 'duration', 'outcome', 'cap_after', 'zscore', 'callpct'];
  document.querySelectorAll('.trade-table thead th').forEach((th, i) => {
    th.addEventListener('click', () => {
      const col = headers[i];
      if (sortCol === col) sortAsc = !sortAsc;
      else { sortCol = col; sortAsc = false; }
      const getter = colGetters[col] || (() => 0);
      allDisplayTrades = [...allDisplayTrades].sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (typeof va === 'string') return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
        return sortAsc ? va - vb : vb - va;
      });
      applyTableFilters();
    });
  });
}
