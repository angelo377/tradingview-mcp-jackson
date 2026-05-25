// Score 7+ Backtest Dashboard — Frontend

let allTrades   = [];
let activeYear  = 'all';
let activeOutcome = 'all';
let activeRunYear = 'ALL';
let charts = {};

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
function fmt$(n)  { if (n == null) return '—'; return (n >= 0 ? '+' : '') + '$' + Math.abs(n).toLocaleString('en-US', {maximumFractionDigits: 0}); }
function fmtPct(n){ if (n == null) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }
function fmtRR(n) { if (n == null) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(2) + 'R'; }
function setVal(id, val, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = val;
  if (cls) { el.className = 'stat-val ' + cls; }
}
function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

// ── Load summary on page load ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // Load summary
  try {
    const r = await fetch('/api/signals-summary');
    const d = await r.json();
    if (d.ok) renderSummary(d.summary);
  } catch(e) {}

  // Auto-load cached results
  try {
    const r = await fetch('/api/results');
    const d = await r.json();
    if (d.ok) renderResults(d.results, 'ALL');
  } catch(e) {}

  // Year filter buttons
  $('year-group').addEventListener('click', e => {
    const btn = e.target.closest('.btn-opt');
    if (!btn) return;
    $('year-group').querySelectorAll('.btn-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeRunYear = btn.dataset.val;
  });

  // Run button
  $('run-btn').addEventListener('click', runBacktest);

  // Year tab buttons
  $('year-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.year-tab');
    if (!btn) return;
    $('year-tabs').querySelectorAll('.year-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeYear = btn.dataset.year;
    renderYearStats();
  });

  // Outcome tabs
  $('outcome-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.outcome-tab');
    if (!btn) return;
    $('outcome-tabs').querySelectorAll('.outcome-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeOutcome = btn.dataset.outcome;
    renderTradeTable();
  });

  // Search
  $('table-search').addEventListener('input', renderTradeTable);
});

function renderSummary(s) {
  setVal('sc-total',   s.totalRows);
  setVal('sc-tickers', s.totalTickers);
  setVal('sc-top50',   s.top50Trades);
  setVal('sc-2022',    s.byYear['2022'] || 0);
  setVal('sc-2023',    s.byYear['2023'] || 0);
  setVal('sc-2024',    s.byYear['2024'] || 0);
  setVal('sc-2025',    s.byYear['2025'] || 0);
}

// ── Run backtest ──────────────────────────────────────────────────────────────
function runBacktest() {
  const pb = $('progress-bar'), pf = $('progress-fill'), lp = $('log-panel'), lc = $('log-content');
  pb.style.display = 'block'; lp.style.display = 'block'; lc.innerHTML = '';
  pf.style.width = '0%';
  $('run-btn').disabled = true;
  $('results-section').style.display = 'none';

  const url = `/api/run-backtest?year=${activeRunYear}&topN=50`;
  const es = new EventSource(url);

  es.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'progress') {
      lc.innerHTML += `<div>${data.msg}</div>`;
      lc.scrollTop = lc.scrollHeight;
      if (data.progress) pf.style.width = data.progress + '%';
    } else if (data.type === 'complete') {
      pf.style.width = '100%';
      es.close();
      $('run-btn').disabled = false;
      renderResults(data.results, activeRunYear);
    } else if (data.type === 'error') {
      lc.innerHTML += `<div style="color:#ef4444">❌ ${data.msg}</div>`;
      es.close();
      $('run-btn').disabled = false;
    }
  };
}

// ── Render full results ───────────────────────────────────────────────────────
function renderResults(results, yearFilter) {
  $('results-section').style.display = 'block';

  const overall = results.overall;
  allTrades = overall.trades;

  const s = overall.stats;
  const label = yearFilter && yearFilter !== 'ALL' ? `(${yearFilter})` : '(All Years)';
  $('perf-year-label').textContent = label;

  // Performance cards
  setVal('r-pnl',    fmt$(s.totalPnl),     s.totalPnl >= 0 ? 'pos' : 'neg');
  setVal('r-winrate', s.winRate + '%',      s.winRate >= 50 ? 'pos' : s.winRate >= 35 ? '' : 'neg');
  setVal('r-trades',  s.count);
  setVal('r-wins',    s.winCount);
  setVal('r-sl',      s.slCount);
  setVal('r-avgrr',   fmtRR(s.avgRR),      s.avgRR >= 0 ? 'pos' : 'neg');
  setVal('r-avgdur',  s.avgDurationDays + 'd');
  setVal('r-best',    fmt$(s.bestTrade),   'pos');
  setVal('r-worst',   fmt$(s.worstTrade),  'neg');
  setVal('r-pf',      s.profitFactor,      s.profitFactor >= 1 ? 'pos' : 'neg');
  setVal('r-mfe',     fmtPct(s.avgMFEPct * 100));
  setVal('r-mae',     fmtPct(s.avgMAEPct * 100));

  // Milestone cards
  setVal('r-hit2x',   s.hit2xRate + '% (' + s.hit2xCount + ')');
  setVal('r-hit3x',   s.hit3xRate + '% (' + s.hit3xCount + ')');
  setVal('r-hit5x',   s.hit5xRate + '% (' + s.hit5xCount + ')');
  setVal('r-win3x',   s.win3xCount);
  setVal('r-win2x',   s.win2xCount);

  // Forward return bar
  renderFwdBar(s);

  // Year stats
  renderYearStats(results);

  // Charts
  renderCharts(results);

  // Trade table outcome tabs
  const wCount = allTrades.filter(t => ['WIN','2x WIN','3x WIN'].includes(t.outcome)).length;
  const slCount = allTrades.filter(t => t.outcome === 'SL').length;
  const mCount  = allTrades.filter(t => ['2x WIN','3x WIN'].includes(t.outcome)).length;
  const oCount  = allTrades.filter(t => !['WIN','2x WIN','3x WIN','SL','LOSS'].includes(t.outcome)).length;
  setVal('otab-count-all',       allTrades.length);
  setVal('otab-count-wins',      wCount);
  setVal('otab-count-sl',        slCount);
  setVal('otab-count-milestone', mCount);
  setVal('otab-count-others',    oCount);

  renderTradeTable();
}

// ── Forward return bar ─────────────────────────────────────────────────────────
function renderFwdBar(s) {
  const periods = [
    { label: '5d',  val: s.fwdAvg5d  },
    { label: '10d', val: s.fwdAvg10d },
    { label: '21d', val: s.fwdAvg21d },
    { label: '42d', val: s.fwdAvg42d },
    { label: '63d', val: s.fwdAvg63d },
    { label: '90d', val: s.fwdAvg90d },
  ];
  const bar = $('fwd-bar');
  bar.innerHTML = periods.map(p => {
    if (p.val == null) return '';
    const cls = p.val >= 0 ? 'fwd-pos' : 'fwd-neg';
    return `<div class="fwd-item ${cls}">
      <div class="fwd-label">${p.label}</div>
      <div class="fwd-val">${(p.val >= 0 ? '+' : '') + p.val.toFixed(2)}%</div>
    </div>`;
  }).join('');
}

// ── Year stats grid ───────────────────────────────────────────────────────────
let _results = null;
function renderYearStats(results) {
  if (results) _results = results;
  if (!_results) return;

  const grid = $('year-stats-grid');
  const years = [2022, 2023, 2024, 2025];
  const data  = activeYear === 'all' ? years : [parseInt(activeYear)];

  grid.innerHTML = data.map(yr => {
    const yd = _results.byYear[yr];
    if (!yd || !yd.stats.count) return `<div class="year-stat-card"><div class="ysc-year">${yr}</div><div class="ysc-empty">No trades</div></div>`;
    const s = yd.stats;
    const pnlCls = s.totalPnl >= 0 ? 'pos' : 'neg';
    return `<div class="year-stat-card">
      <div class="ysc-year">${yr}</div>
      <div class="ysc-row"><span>Trades</span><span>${s.count}</span></div>
      <div class="ysc-row"><span>Win Rate</span><span>${s.winRate}%</span></div>
      <div class="ysc-row"><span>P&amp;L</span><span class="${pnlCls}">${fmt$(s.totalPnl)}</span></div>
      <div class="ysc-row"><span>Avg R:R</span><span>${fmtRR(s.avgRR)}</span></div>
      <div class="ysc-row"><span>Profit Factor</span><span>${s.profitFactor}</span></div>
      <div class="ysc-row"><span>Hit 2x</span><span>${s.hit2xRate}%</span></div>
      <div class="ysc-row"><span>Hit 3x</span><span>${s.hit3xRate}%</span></div>
    </div>`;
  }).join('');
}

// ── Charts ────────────────────────────────────────────────────────────────────
function renderCharts(results) {
  const years    = [2022, 2023, 2024, 2025];
  const yearData = years.map(y => results.byYear[y]?.stats || {});

  // P&L by year
  destroyChart('pnl');
  charts.pnl = new Chart($('chart-pnl-year'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{
        label: 'P&L ($)',
        data: yearData.map(s => s.totalPnl || 0),
        backgroundColor: yearData.map(s => (s.totalPnl || 0) >= 0 ? 'rgba(34,197,94,0.7)' : 'rgba(239,68,68,0.7)'),
      }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => '$' + v.toLocaleString() } } } },
  });

  // Win rate by year
  destroyChart('wr');
  charts.wr = new Chart($('chart-winrate-year'), {
    type: 'bar',
    data: {
      labels: years,
      datasets: [{
        label: 'Win Rate (%)',
        data: yearData.map(s => s.winRate || 0),
        backgroundColor: 'rgba(59,130,246,0.7)',
      }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { max: 100, ticks: { callback: v => v + '%' } } } },
  });

  // Outcome distribution
  const os = results.overall.stats;
  destroyChart('out');
  charts.out = new Chart($('chart-outcomes'), {
    type: 'doughnut',
    data: {
      labels: ['Stop Loss', 'Win', '2x Win', '3x Win', 'Loss/Other'],
      datasets: [{
        data: [
          os.slCount,
          os.winCount - os.win2xCount - os.win3xCount,
          os.win2xCount - os.win3xCount,
          os.win3xCount,
          os.count - os.winCount - os.slCount,
        ],
        backgroundColor: ['#ef4444','#22c55e','#3b82f6','#f59e0b','#9ca3af'],
      }],
    },
    options: { plugins: { legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 } } } } },
  });

  // Milestone hit rates
  destroyChart('ms');
  charts.ms = new Chart($('chart-milestones'), {
    type: 'bar',
    data: {
      labels: ['2x Hit', '3x Hit', '5x Hit'],
      datasets: [{
        label: 'Rate (%)',
        data: [os.hit2xRate, os.hit3xRate, os.hit5xRate],
        backgroundColor: ['rgba(251,191,36,0.8)', 'rgba(245,101,15,0.8)', 'rgba(168,85,247,0.8)'],
      }],
    },
    options: { plugins: { legend: { display: false } }, scales: { y: { max: 100, ticks: { callback: v => v + '%' } } } },
  });

  // Forward return line chart
  destroyChart('fwd');
  charts.fwd = new Chart($('chart-fwd-return'), {
    type: 'line',
    data: {
      labels: ['5d', '10d', '21d', '42d', '63d', '90d'],
      datasets: [{
        label: 'Avg Forward Return (%)',
        data: [os.fwdAvg5d, os.fwdAvg10d, os.fwdAvg21d, os.fwdAvg42d, os.fwdAvg63d, os.fwdAvg90d],
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,0.1)',
        tension: 0.4,
        fill: true,
        pointRadius: 5,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: {
          ticks: { callback: v => v + '%' },
          grid:  { color: 'rgba(0,0,0,0.05)' },
        },
      },
    },
  });
}

// ── Trade Table ───────────────────────────────────────────────────────────────
function renderTradeTable() {
  const search = ($('table-search').value || '').toLowerCase();

  let trades = [...allTrades];

  // Outcome filter
  if (activeOutcome === 'wins')      trades = trades.filter(t => ['WIN','2x WIN','3x WIN'].includes(t.outcome));
  else if (activeOutcome === 'sl')   trades = trades.filter(t => t.outcome === 'SL');
  else if (activeOutcome === 'milestone') trades = trades.filter(t => ['2x WIN','3x WIN'].includes(t.outcome));
  else if (activeOutcome === 'others')    trades = trades.filter(t => !['WIN','2x WIN','3x WIN','SL','LOSS'].includes(t.outcome));

  // Search
  if (search) trades = trades.filter(t => t.ticker.toLowerCase().includes(search));

  $('table-meta').textContent = `Showing ${trades.length} trade${trades.length !== 1 ? 's' : ''}`;

  const outcomeClass = {
    'WIN':      'outcome-win',
    '2x WIN':   'outcome-2x',
    '3x WIN':   'outcome-3x',
    'SL':       'outcome-sl',
    'LOSS':     'outcome-loss',
    'OPEN':     'outcome-open',
  };

  const tbody = $('trade-tbody');
  tbody.innerHTML = trades.map(t => {
    const pnlCls = t.pnl >= 0 ? 'pos' : 'neg';
    const oCls   = outcomeClass[t.outcome] || '';
    return `<tr>
      <td>${t.signalDate || '—'}</td>
      <td>${t.entryDate  || '—'}</td>
      <td>${t.exitDate   || '—'}</td>
      <td><strong>${t.ticker}</strong></td>
      <td>$${(t.entryPrice||0).toFixed(2)}</td>
      <td>$${(t.stopPrice||0).toFixed(2)}</td>
      <td>$${(t.exitPrice||0).toFixed(2)}</td>
      <td class="${pnlCls}">${fmt$(t.pnl)}</td>
      <td class="${pnlCls}">${fmtRR(t.rr)}</td>
      <td>${t.holdDays ?? '—'}</td>
      <td><span class="outcome-badge ${oCls}">${t.outcome}</span></td>
      <td>${t.rubricScore ?? '—'}</td>
      <td>${t.litScore != null ? t.litScore.toFixed(0) : '—'}</td>
      <td>${t.volZScore != null ? t.volZScore.toFixed(2) : '—'}</td>
      <td>${t.mfePct != null ? (t.mfePct*100).toFixed(1)+'%' : '—'}</td>
      <td>${t.maePct != null ? (t.maePct*100).toFixed(1)+'%' : '—'}</td>
      <td>${(t.exitReason||'').replace(/_/g,' ')}</td>
    </tr>`;
  }).join('');
}
