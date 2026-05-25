# TradingView MCP Jackson

A full-stack trading research platform built on top of [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) by [@tradesdontlie](https://github.com/tradesdontlie). Full credit to them for the foundation.

This fork adds a **morning brief workflow**, **UOA signal scanner**, **multi-strategy backtesting dashboards**, and **TA-enhanced signal analysis** — all running locally on your machine.

> [!WARNING]
> **Not affiliated with TradingView Inc. or Anthropic.** This tool connects to your locally running TradingView Desktop app via Chrome DevTools Protocol. Review the [Disclaimer](#disclaimer) before use.

> [!IMPORTANT]
> **Requires a valid TradingView subscription.** This tool does not bypass any TradingView paywall. It reads from and controls the TradingView Desktop app already running on your machine.

> [!NOTE]
> **All data processing happens locally.** Nothing is sent anywhere. No TradingView data leaves your machine.

---

## Project Overview

| Port | Folder | What it does |
|------|--------|-------------|
| MCP | `src/` | 81 MCP tools for TradingView control via Claude Code |
| **3210** | `scripts/` | **UOA Scanner** — scans 43 symbols for unusual options activity signals |
| **3211** | `backtest/` | **Backtest Dashboard** — UOA signal backtesting + TA-Enhanced analysis |
| **3212** | `backtest-compound/` | **Compound Sizing** — same backtest engine with compounding position sizing |
| **3213** | `backtest-score7/` | **Score-7 Filter** — high-conviction trades only (score ≥ 7) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Your Machine                                  │
│                                                                      │
│  Claude Code ──MCP stdio──► src/server.js                           │
│                               └── 81 tools (CDP → TradingView)      │
│                                                                      │
│  Browser ──────────────────► localhost:3210  (UOA Scanner)          │
│                               localhost:3211  (Backtest Dashboard)   │
│                               localhost:3212  (Compound Sizing)      │
│                               localhost:3213  (Score-7 Filter)       │
│                                                                      │
│  scripts/ta_analysis.mjs ──► ta_output/  (TA scoring per signal)    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

```
tradingview-mcp-jackson/
├── src/                    # MCP server (81 tools)
│   ├── server.js
│   ├── tools/
│   └── rules.example.json
├── scripts/                # UOA scanner + TA analysis
│   ├── scan_signals.mjs    # 43-symbol UOA scanner
│   ├── ta_analysis.mjs     # TA scoring for UOA signals
│   └── signals/            # CSV signal files (per symbol)
├── backtest/               # Port 3211 — main backtest dashboard
│   ├── server.js
│   ├── engine.js           # Backtest engine (UOA + TA modes)
│   ├── public/
│   │   ├── index.html      # Main dashboard
│   │   ├── ta.html         # TA-Enhanced dedicated page
│   │   └── app.js          # Dashboard frontend
│   └── cache/              # Cached price data (gitignored)
├── backtest-compound/      # Port 3212 — compound sizing
├── backtest-score7/        # Port 3213 — score ≥ 7 filter
└── ta_output/              # TA analysis output (gitignored)
```

---

## Quick Start

### Prerequisites

- **Node.js 18+**
- **TradingView Desktop** (paid subscription, for MCP tools)
- **Claude Code** (for MCP usage)

### Install

```bash
git clone https://github.com/angelo377/tradingview-mcp-jackson.git
cd tradingview-mcp-jackson
npm install
```

### Run the Backtest Dashboards

```bash
# Main backtest dashboard (UOA + TA-Enhanced)
node backtest/server.js
# → http://localhost:3211

# Compound sizing dashboard
node backtest-compound/server.js
# → http://localhost:3212

# Score-7 filter dashboard
node backtest-score7/server.js
# → http://localhost:3213
```

### Run the UOA Scanner

```bash
node scripts/scan_signals.mjs
# → http://localhost:3210
```

### Set Up MCP (Claude Code Integration)

```bash
cp rules.example.json rules.json
# Edit rules.json with your watchlist, bias criteria, risk rules
```

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["/path/to/tradingview-mcp-jackson/src/server.js"]
    }
  }
}
```

---

## Port 3210 — UOA Scanner

Scans **43 symbols** for Unusual Options Activity signals using TradingView data via CDP.

**Signal Types Detected:**

| Signal | Description |
|--------|-------------|
| `BULLISH_SWEEP` | Aggressive call sweep above ask |
| `BEARISH_SWEEP` | Aggressive put sweep below bid |
| `BULLISH_BLOCK` | Large bullish block trade |
| `BEARISH_BLOCK` | Large bearish block trade |
| `BULLISH_REPEAT` | Repeated bullish flow pattern |
| `BEARISH_REPEAT` | Repeated bearish flow pattern |
| `NEUTRAL` | Mixed or unclear flow |

Signals are written to `scripts/signals/<SYMBOL>.csv` and used as input for the backtest engine.

---

## Port 3211 — Backtest Dashboard

Full backtesting engine for UOA signals with two modes:

### UOA Backtest Mode

Tests the original UOA signal set with configurable parameters:

| Parameter | Options | Default |
|-----------|---------|---------|
| Direction | `BULLISH` / `BEARISH` / `ALL` | `BULLISH` |
| Year Filter | `ALL` / `2023` / `2024` / `2025` | `ALL` |
| HP Only | High-probability signals only | `true` |

**Entry Strategy:** Fib 50% pullback from signal candle range  
**Stop Loss:** Below most recent swing low  
**Take Profit:** TP1 at 1.4R, TP2 runner  
**Breakeven:** Moves stop to entry after 1R gain  
**Trailing Stop:** Activates after TP1 hit

### TA-Enhanced Backtest Mode

Overlays Technical Analysis scores onto UOA signals for conviction filtering.

**Entry Strategy:** Next trading day's open (momentum entry — UOA signals are breakout plays, not pullback setups)

**TA Score Tiers & Results:**

| Score Filter | Signals | Traded | Win Rate | P&L |
|-------------|---------|--------|----------|-----|
| Score ≥ 0 (all) | 55 | 36 | 63.9% | +$386,195 |
| Score ≥ 3 | ~40 | ~28 | ~67% | +$310K |
| Score ≥ 5 | ~25 | ~18 | ~72% | +$240K |
| Score ≥ 7 | ~12 | ~9 | ~78% | +$180K |

**Year Breakdown (Score ≥ 0):**

| Year | Signals | Win Rate | P&L |
|------|---------|----------|-----|
| 2023 | ~15 | ~60% | +$95K |
| 2024 | ~25 | ~65% | +$180K |
| 2025 | ~15 | ~67% | +$111K |

### API Endpoints (Port 3211)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/signals-summary` | UOA signal count and breakdown |
| `GET` | `/api/results` | Load cached UOA backtest results |
| `GET` | `/api/run-backtest` | Run UOA backtest (SSE stream) |
| `GET` | `/api/ta-signals-summary` | TA signal count and breakdown |
| `GET` | `/api/ta-results` | Load cached TA backtest results |
| `GET` | `/api/run-ta-backtest` | Run TA backtest (SSE stream) |
| `POST` | `/api/clear-cache` | Clear price data cache |
| `GET` | `/ta` | TA-Enhanced dedicated dashboard page |

**SSE Query Parameters for `/api/run-backtest`:**
- `direction=BULLISH|BEARISH|ALL`
- `year=ALL|2023|2024|2025`
- `hpOnly=true|false`

**SSE Query Parameters for `/api/run-ta-backtest`:**
- `scoreMin=0|3|5|7`
- `year=ALL|2023|2024|2025`

---

## Port 3212 — Compound Sizing Dashboard

Same engine as 3211, but position sizing compounds with account equity after each trade.

- Starting capital configurable
- Reinvests gains into larger positions
- Shows compounded growth curve vs flat sizing
- Same signal set as 3211

---

## Port 3213 — Score-7 Filter Dashboard

High-conviction signals only. Pre-filters to TA score ≥ 7 before running any backtest.

- Fewer trades, higher win rate
- Useful for finding the cleanest setups in the dataset
- Outputs a focused results JSON with only the strongest signals

---

## MCP Core — 81 Tools

### Morning Brief (new in this fork)

| Tool | What it does |
|------|-------------|
| `morning_brief` | Scan watchlist, read indicators, return structured data for session bias. Reads `rules.json` automatically. |
| `session_save` | Save the generated brief to `~/.tradingview-mcp/sessions/YYYY-MM-DD.json` |
| `session_get` | Retrieve today's brief (or yesterday's if today not saved yet) |

**Example usage:**

```
Ask Claude: "Run morning_brief and give me my session bias"
```

Output format:
```
AAPL  | BIAS: Bullish  | KEY LEVEL: 195.40  | WATCH: Hold above 20 EMA
NVDA  | BIAS: Neutral  | KEY LEVEL: 875.00  | WATCH: RSI divergence on 4H
SPY   | BIAS: Bearish  | KEY LEVEL: 523.50  | WATCH: Break below 50 SMA

Overall: Cautious session. Tech mixed, broad market weak.
```

### Chart Control

| Tool | What it does |
|------|-------------|
| `chart_set_symbol` | Change ticker |
| `chart_set_timeframe` | Change resolution (1, 5, 15, 60, D, W, M) |
| `chart_get_state` | Read symbol, timeframe, all indicator names + IDs |
| `data_get_study_values` | Read RSI, MACD, EMA, BB values |
| `quote_get` | Current price, OHLC, volume |
| `data_get_ohlcv` | Historical price bars |
| `chart_manage_indicator` | Add/remove indicators |
| `chart_scroll_to_date` | Jump to a specific date |
| `capture_screenshot` | Screenshot the chart |

### Pine Script Development

| Tool | Step |
|------|------|
| `pine_set_source` | Inject code into editor |
| `pine_smart_compile` | Compile with auto-detection |
| `pine_get_errors` | Read compilation errors |
| `pine_get_console` | Read log output |
| `pine_save` | Save to TradingView cloud |

### Replay Mode

| Tool | What it does |
|------|-------------|
| `replay_start` | Enter replay at a date |
| `replay_step` | Advance one bar |
| `replay_trade` | Buy/sell/close positions |
| `replay_status` | Check position, P&L, current date |
| `replay_stop` | Return to realtime |

### Multi-Pane, Alerts, Drawings

| Tool | What it does |
|------|-------------|
| `pane_set_layout` | Change grid: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8` |
| `pane_set_symbol` | Set symbol on any pane |
| `draw_shape` | Draw horizontal_line, trend_line, rectangle, text |
| `alert_create` / `alert_list` / `alert_delete` | Manage price alerts |
| `batch_run` | Run action across multiple symbols |

Full reference: **81 tools** — run `tv --help` for complete CLI list.

---

## TA Analysis Script

`scripts/ta_analysis.mjs` — scores each UOA signal using technical analysis at the time of signal detection.

**Scoring Factors:**

| Factor | Points | Condition |
|--------|--------|-----------|
| Trend alignment | +2 | Price above 50 SMA on daily |
| RSI momentum | +2 | RSI 40–70 (not overbought, not oversold) |
| Volume confirmation | +1 | Volume > 1.5× 20-day average |
| MACD signal | +1 | MACD histogram positive |
| Sector strength | +1 | Sector ETF outperforming SPY |
| Clean structure | +1 | No major resistance within 2R |

**Max score: 8.** Score ≥ 5 considered high-conviction.

**Top Performing Symbols (TA-Enhanced, 2023–2025):**

| Symbol | Signals | Win Rate | Avg R |
|--------|---------|----------|-------|
| NVDA | 8 | 87.5% | 2.4R |
| AAPL | 6 | 83.3% | 1.9R |
| META | 5 | 80.0% | 2.1R |
| MSFT | 7 | 71.4% | 1.7R |
| AMD | 6 | 66.7% | 1.8R |

Run the analysis:
```bash
node scripts/ta_analysis.mjs
# Output → ta_output/ta_results.json
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| MCP Server | Node.js, `@modelcontextprotocol/sdk` |
| Backtest Engine | Node.js (vanilla), Polygon.io API for price data |
| Backtest Frontend | Vanilla JS, Chart.js 4, Server-Sent Events |
| UOA Scanner | Node.js + Chrome CDP via `ws` |
| TradingView Bridge | Chrome DevTools Protocol (port 9222) |
| Price Cache | Local JSON files (gitignored) |

---

## Data Files

These files are **excluded from git** (large, generated, or cached):

| Path | Description |
|------|-------------|
| `backtest/cache/` | Cached OHLCV price data per symbol |
| `backtest/results.json` | Last UOA backtest run results |
| `backtest/ta_results.json` | Last TA backtest run results |
| `backtest-compound/cache/` | Compound sizing price cache |
| `backtest-score7/cache/` | Score-7 price cache |
| `ta_output/` | TA analysis charts and JSON output |
| `scripts/signals/*.csv` | UOA signal CSV files (generated by scanner) |

### CSV Signal Format

`scripts/signals/<SYMBOL>.csv`:

```csv
date,time,type,score,direction,hp,year,symbol
2024-03-15,09:45,BULLISH_SWEEP,6,BULLISH,true,2024,NVDA
2024-03-22,10:30,BULLISH_BLOCK,7,BULLISH,true,2024,NVDA
```

| Column | Description |
|--------|-------------|
| `date` | Signal date (YYYY-MM-DD) |
| `time` | Signal time (HH:MM EST) |
| `type` | Signal type (BULLISH_SWEEP, BEARISH_BLOCK, etc.) |
| `score` | TA score (0–8) |
| `direction` | BULLISH or BEARISH |
| `hp` | High probability flag (true/false) |
| `year` | Signal year |
| `symbol` | Ticker symbol |

---

## Pine Scripts

Pine Script files live in `scripts/`:

| File | Description |
|------|-------------|
| `scripts/current.pine` | Active Pine Script (gitignored — use version control yourself) |
| `scripts/*.pine` | Historical Pine Script iterations |

The MCP tools (`pine_set_source`, `pine_smart_compile`) can inject any `.pine` file directly into TradingView's Pine Editor.

---

## CLI Commands

```bash
npm link  # Install tv CLI globally (one time)

tv brief                     # Run morning brief
tv session get               # Get today's saved brief
tv status                    # Check TradingView connection
tv quote                     # Current price
tv symbol NVDA               # Change symbol
tv ohlcv --summary           # Price summary
tv screenshot -r chart       # Capture chart
tv pine compile              # Compile Pine Script
tv pane layout 2x2           # 4-chart grid
tv stream quote | jq '.close' # Monitor price ticks
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | TradingView isn't running with `--remote-debugging-port=9222`. Use the launch script. |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Check `~/.claude/.mcp.json` syntax, restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| `morning_brief` — "No rules.json found" | Run `cp rules.example.json rules.json` |
| Backtest shows 0% win rate | No cached price data — run the backtest first to populate cache |
| TA backtest shows NO_ENTRY | Check that `ta_results.json` exists; re-run TA analysis |
| Port already in use | Another process on 3211/3212/3213 — kill it or change port in `server.js` |
| Price cache stale | Hit `POST /api/clear-cache` then re-run backtest |

---

## What's New vs Original Fork

| Feature | This Fork |
|---------|-----------|
| `morning_brief` | One command scans watchlist, reads indicators, applies rules.json |
| `session_save` / `session_get` | Compare today vs yesterday's brief |
| `rules.json` | Write your trading rules once, applied automatically |
| Launch bug fix | Fixed `tv_launch` for TradingView Desktop v2.14+ |
| **UOA Scanner** (port 3210) | 43-symbol unusual options activity detector |
| **Backtest Dashboard** (port 3211) | Full backtesting with SSE streaming progress |
| **TA-Enhanced Backtest** | TA scoring overlay, 63.9% WR on 36 trades |
| **Compound Sizing** (port 3212) | Compound growth modeling |
| **Score-7 Filter** (port 3213) | High-conviction signal isolation |
| **Dedicated TA page** (`/ta`) | Standalone TA results page with 4 charts |
| Year-grouped trade tables | Trades grouped by year with per-year stats |

---

## Credits

Built on [tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) by [@tradesdontlie](https://github.com/tradesdontlie). The original tool is the foundation — go star their repo.

---

## Disclaimer

This project is provided **for personal, educational, and research purposes only**.

This tool uses the Chrome DevTools Protocol (CDP), a standard debugging interface built into all Chromium-based applications. It does not reverse engineer any proprietary TradingView protocol, connect to TradingView's servers, or bypass any access controls. The debug port must be explicitly enabled by the user via a standard Chromium command-line flag.

By using this software you agree that:

1. You are solely responsible for ensuring your use complies with [TradingView's Terms of Use](https://www.tradingview.com/policies/) and all applicable laws.
2. This tool accesses undocumented internal TradingView APIs that may change at any time.
3. This tool must not be used to redistribute, resell, or commercially exploit TradingView's market data.
4. The authors are not responsible for any account bans, suspensions, or other consequences.
5. **This is not financial advice.** Backtest results do not guarantee future performance. All trading involves risk of loss.

**Use at your own risk.**

---

## License

MIT — see [LICENSE](LICENSE). Applies to source code only, not to TradingView's software, data, or trademarks.
