# TV Health Check — How It Works

> **File:** `scripts/tv_healthcheck_full.js`
> **Triggered by:** Dashboard → "Health Check" button on `localhost:3210`
> **CLI equivalent:** `tv status`

---

## Overview

The Health Check scans every symbol in your watchlist across **5 indicators** simultaneously. It reads indicator primitives (labels, boxes) directly from TradingView's internal JavaScript API via CDP (Chrome DevTools Protocol) — no screen scraping, no DOM reading. It then renders a floating panel on the TradingView chart and outputs a full Markdown summary to the console.

---

## The 7-Step Process

```
[1] CDP Connection Check
        ↓
[2] Load Watchlist (live → cache fallback)
        ↓
[3] Switch chart to 1H timeframe
        ↓
[4] Ensure Market Structure + BOS + POI indicator is on chart
        ↓
[5] For each symbol → switch chart → read 5 indicators
        │
        ├── Market Structure (BOS ↑ / BOS ↓ + HH/HL/LH/LL)
        ├── POI Zone (orange Fib 0.618–0.65 box)
        ├── Fib 0.50 (yellow mid-level label)
        ├── SOS/SOW (Auto SOS/SOW V2 — green/red dots)
        └── CF Cycle Trading (DCL/WCL windows)
        ↓
[6] Restore original symbol
        ↓
[7] Render on-chart panel + print Markdown summary
```

---

## Step 1 — CDP Connection Check

```js
// src/core/health.js → healthCheck()
const state = await evaluate(`
  window.TradingViewApi._activeChartWidgetWV.value().symbol()
`);
```

Checks:
- `cdp_connected` — can reach TradingView Desktop on `localhost:9222`
- `api_available` — `window.TradingViewApi._activeChartWidgetWV` is accessible
- `chart_symbol` — current symbol on chart
- `chart_resolution` — current timeframe

If CDP is unreachable → exits immediately with error. Buttons on the dashboard stay locked until this passes.

---

## Step 2 — Load Watchlist

```js
let wl = await withTimeout(getWatchlist(), 30_000, { count: 0, symbols: [] });
```

**Live scrape first** — reads the watchlist panel DOM from TradingView Desktop (symbol names + last prices).

**Cache fallback** — if live returns 0 symbols (panel hidden or loading), reads from `scripts/watchlist_cache.json`:
```json
{ "symbols": ["NYSE:HAL", "NASDAQ:NVDA", "NYSE:OXY", ...], "updated": "2026-05-26" }
```

After a successful live scrape the cache is auto-updated for next time.

---

## Step 3 — Switch to 1H Timeframe

```js
window.TradingViewApi._activeChartWidgetWV.value().setResolution('60', {});
```

All reads happen on **1 Hour (60 min)** bars. This is hardcoded — the Market Structure indicator was tuned on 1H with `swing_len=30`.

---

## Step 4 — Ensure Market Structure Indicator

Checks if `"Market Structure + BOS + POI"` is already on the chart:
```js
chart.getAllStudies().some(s => s.name.toLowerCase().includes('market structure'))
```

If **not found** — auto-adds it by:
1. Clicking the Indicators toolbar button
2. Typing `"Market Structure"` into the search input (React synthetic event)
3. Clicking the first matching result
4. Closing the dialog with Escape
5. Verifying it now appears in `getAllStudies()`

> ⚠ If TradingView is offline or the indicator library hasn't loaded, this step is skipped and the scan continues (data will return `NO DATA`).

---

## Step 5 — Per-Symbol Scan

For each symbol in the watchlist:

```js
window.TradingViewApi._activeChartWidgetWV.value().setSymbol('NYSE:HAL', {});
await sleep(5000);  // wait for chart data to load
```

Then reads **5 indicators in parallel** (each with an independent timeout):

---

### 5A — Market Structure (BOS + Swing Labels)

**Source:** `"Market Structure + BOS + POI"` indicator
**API path:** `dataSources → _graphics._primitivesCollection → dwglabels`

Reads two sets of labels from the indicator's primitive collection:

| Label Type | Values | What it means |
|-----------|--------|---------------|
| BOS labels | `BOS ↑`, `BOS ↓` | Break of Structure direction |
| Swing labels | `HH`, `HL`, `LH`, `LL` | Most recent swing structure |

Takes the **most recent by bar index** (`v.x` = bar position):

```
BOS ↑ → BULLISH structure
BOS ↓ → BEARISH structure
```

**Swing phases decoded:**

| Last Swing Label | Phase | Meaning |
|-----------------|-------|---------|
| `HH` | Higher High | Bullish — trend extending |
| `HL` | Higher Low | Bullish — holding structure |
| `LH` | Lower High | Bearish — losing momentum |
| `LL` | Lower Low | Bearish — trend extending |

---

### 5B — POI Zone (Point of Interest)

**Source:** Same `"Market Structure + BOS + POI"` indicator
**API path:** `dataSources → _graphics._primitivesCollection → dwgboxes`

Reads the orange box drawn at the Fib **0.618–0.65 retracement zone** of the most recent BOS ↑ candle.

Picks the box with the highest `x1` value (most recent):

```
box.y1, box.y2 → poiBottom, poiTop
```

**Stage logic based on current price vs box:**

| Price position | Stage | Meaning |
|---------------|-------|---------|
| `price >= poiBottom && price <= poiTop` | **AT POI** 🎯 | Price is inside the zone right now |
| `price > poiTop` | **RETRACING** ⏳ | BOS fired, waiting for pullback to zone |
| `price < poiBottom` | **MISSED** ❌ | Retracement went below the zone |
| No box found | **NO POI** | No BOS ↑ box drawn (bearish or no signal) |

---

### 5C — Fib 0.50 Level

**Source:** Same `"Market Structure + BOS + POI"` indicator
**API path:** `dwglabels` — finds labels with text `"0.50"`

Checks if current price is within **±0.5%** of the yellow midline:
```js
Math.abs(price - level) / level <= 0.005
```

Returns: `{ hit: true/false, text: "~194.32" }`

The 0.50 level is the midpoint of the full Fib range — hitting it often precedes a reaction.

---

### 5D — SOS / SOW Signal

**Source:** `"Auto SOS/SOW V2"` indicator
**API path:** `src._data._items` (raw plot data array)

Data format per bar: `[timestamp, sos, sow, alert_sos, alert_sow]`

Scans backwards through the last **300 bars** for the most recent signal:
```
items[i].value[1] === 1  →  SOS (Sign of Strength — bullish green dot)
items[i].value[2] === 1  →  SOW (Sign of Weakness — bearish red dot)
```

| Signal | Colour | Meaning |
|--------|--------|---------|
| `SOS` | 🟩 Green | Institutional buying — bullish confirmation |
| `SOW` | 🟥 Red | Institutional selling — bearish confirmation |
| `null` | — | No signal in last 300 bars |

---

### 5E — Auto Metrics BUY / SELL Signal

**Source:** `"Auto Metrics signals V4"` indicator
**API path:** `src._data._items`

Data format: `[timestamp, ema1, colorer1, ema2, colorer2, SELL, BUY, ...]`

Scans backwards through last **500 bars**:
```
items[i].value[5] === 1  →  SELL 🔴
items[i].value[6] === 1  →  BUY  🟢
```

Returns the signal, its date/time (`"Apr 28 17:00"`), and how many bars ago it fired.

---

### 5F — CF Cycle Trading (DCL / WCL Windows)

**Source:** `"CF Cycle Trading"` indicator
**API path:** `dwglabels` + `dwgboxes`

**Labels scanned:**
- `"48D"` style labels → `lastDclDays` (day count of the most recent DCL)
- `"W"` label → `hasWeekly` (weekly cycle low confirmed at same point)

**Boxes scanned** and classified by colour:

| Box colour | Channel | Window type |
|-----------|---------|-------------|
| Green (g > r, g > b) | DCL | Next Daily Cycle Low window |
| Blue (b > r, b > g) | WCL | Next Weekly Cycle Low window |

Colour is read from the raw RGB object TradingView stores: `{ r: 0–1, g: 0–1, b: 0–1, a: 0–1 }`

Bar index is converted to calendar date via:
```js
chart.model().timeScale().indexToTime(barIdx)
```

Returns: `{ dclWindow: { dateStart: "Jun 23", dateEnd: "Jun 28" }, wclWindow: ... }`

---

## Step 6 — Restore Original Symbol

After scanning all symbols, the chart is switched back to whichever symbol was active before the scan started.

```js
chart.setSymbol(origSymbol, {});
```

---

## Step 7A — On-Chart Panel

An overlay panel is injected directly into TradingView's DOM via `evaluate()`:

```
┌─────────────────────────────────────────────────────────┐
│ 📊 Angelo · Health Check 2026               22:11 · live │
├──────────┬─────────┬─────────┬────────────┬─────────────┤
│ BULLISH  │ BEARISH │ AT POI  │ RETRACING  │ HI-PRI      │
│   12     │    8    │    3    │     5      │    3        │
├─────────────────────────────────────────────────────────┤
│ 🟢 Bullish (12)    NVDA · AAPL · OXY · ...              │
│ 🔴 Bearish (8)     HAL · WOLF · ...                     │
│ 🎯 AT POI (3)      NVDA · META · ...                    │
│ ⏳ Retracing (5)   AAPL · OXY · ...                     │
│ ⚡ At Fib 0.50 (2) AMD · MSFT                           │
│ 🔄 Cycle Windows   NVDA 48D → DCL Jun 23 – Jun 28       │
│ 🔥 High Priority   NVDA · META (Bullish BOS ↑ + AT POI) │
├─────────────────────────────────────────────────────────┤
│ SYMBOL  PRICE   STRUCTURE  SWING  POI      FIB  CYCLE   │
│ NVDA    132.40  🟢 BOS ↑   HH    🎯 AT POI  —   48D     │
│ AAPL    194.10  🟢 BOS ↑   HL    ⏳ RETR.   —    —      │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

Panel is **draggable** (mouse drag on header) and has a **✕ close button**.

---

## Step 7B — Console Markdown Output

The script prints a full Markdown report to the terminal (also captured by the dashboard's Live Log tab):

```markdown
## 📊 Angelo · UOA Health Check — 22:11:59

| Category            | Count | Tickers |
|---------------------|------:|---------|
| 🟢 Bullish BOS ↑    | 12    | NVDA, AAPL, OXY, ... |
| 🔴 Bearish BOS ↓    | 8     | HAL, WOLF, ... |
| 🎯 AT POI           | 3     | NVDA, META, ... |
| ⏳ Retracing to POI | 5     | AAPL, OXY, ... |
| ❌ Missed POI       | 2     | ... |
| ⚡ At Fib 0.50      | 2     | AMD, MSFT |
| 🔥 High Priority    | 3     | NVDA, META, ... |
| 📅 Earnings ≤14 days| 1     | VELO |

### 🔄 Cycle Analysis
| Ticker | Last DCL | Weekly? | Next DCL Window | Next WCL Window |
|--------|----------|:-------:|-----------------|-----------------|
| NVDA   | 48D      | ✅ W    | 🟩 Jun 23 – Jun 28 | 🟦 Jul 10 |

### 🔥 High Priority Setups
| # | Ticker | Price  | BOS      | Swing | POI Zone           |
|---|--------|--------|----------|-------|--------------------|
| 1 | NVDA   | 132.40 | 🟢 BOS ↑ | HH    | 128.40 – 130.20    |

### 📅 Upcoming Earnings
| Ticker | Date   | Days | Structure  | Hi-Pri? |
|--------|--------|------|------------|:-------:|
| VELO   | Jun 01 | ⚠️ 6d | 🟢 Bullish | —      |

### 📋 Full Watchlist Scan
| Ticker | Price  | BOS      | Swing | POI Stage    | Fib | Last DCL | Next DCL     | SOS/SOW | Earnings |
|--------|--------|----------|-------|--------------|:---:|----------|--------------|:-------:|----------|
| NVDA   | 132.40 | 🟢 BOS ↑ | HH    | 🎯 AT POI    | —   | 48D+W    | 🟩 Jun 23    | —       | —        |
| AAPL   | 194.10 | 🟢 BOS ↑ | HL    | ⏳ RETRACING | —   | —        | —            | 🟩 SOS  | —        |
```

---

## Priority Classification

| Priority | Condition | Why it matters |
|----------|-----------|----------------|
| 🔥 **High Priority LONG** | `BOS ↑` AND `AT POI` | Bullish structure + price at entry zone |
| 🔥 **High Priority SHORT** | `BOS ↓` AND `AT POI` | Bearish structure + price at entry zone |
| ⚡ **Fib Alert** | `AT POI` AND `fib 0.50 hit` | Price at POI midpoint — tightest entry |
| 🚨 **Earnings Risk** | `earnDays <= 3` | Earnings in 3 days or less — avoid or size down |

---

## Caches & Outputs

| File | Purpose |
|------|---------|
| `scripts/watchlist_cache.json` | Saved symbol list — used as fallback if live scrape returns 0 |
| `scripts/scan_cache.json` | Last full scan results — used by dashboard sidebar (HIGH PRIORITY / GOLDEN ZONE panels) |
| `scripts/earnings_cache.json` | Pre-fetched earnings dates per ticker (run `node scripts/tv_earnings.js` to refresh) |

---

## Timeouts (per indicator read)

| Read | Timeout | Fallback |
|------|---------|---------|
| Market Structure labels | 6 000 ms | `{ label: 'NO DATA' }` |
| POI boxes | 5 000 ms | `{ stage: 'NO POI' }` |
| Fib 0.50 labels | 5 000 ms | `{ hit: false }` |
| SOS/SOW data | 7 000 ms | `{ signal: null }` |
| Auto Metrics signals | 7 000 ms | `{ signal: null }` |
| Cycle indicator | 8 000 ms | `{ found: false }` |
| Watchlist load | 30 000 ms | empty → cache fallback |

Each symbol takes ~5–8 seconds (dominated by the `SWITCH_MS = 5000` chart load wait). A 39-symbol watchlist takes approximately **3–5 minutes** to complete.

---

## How to Run Manually

```bash
# Via Node directly
node scripts/tv_healthcheck_full.js

# Via CLI
tv status

# Via dashboard
http://localhost:3210 → click "Health Check"
```

**Prerequisites:**
- TradingView Desktop running with `--remote-debugging-port=9222`
- `"Market Structure + BOS + POI"` indicator available in your TradingView account
- `"CF Cycle Trading"`, `"Auto SOS/SOW V2"`, `"Auto Metrics signals V4"` on the chart (optional — health check skips gracefully if not found)

---

## API Path Reference

All reads go through `window.TradingViewApi` — TradingView Desktop's internal JavaScript API exposed via CDP:

```
window.TradingViewApi
  └── _activeChartWidgetWV.value()           ← Active chart widget
        ├── .symbol()                         ← Current symbol string
        ├── .resolution()                     ← Current timeframe string
        ├── .setSymbol(sym, {})              ← Switch symbol
        ├── .setResolution(tf, {})           ← Switch timeframe
        ├── .getAllStudies()                  ← Array of { id, name } for all indicators
        └── ._chartWidget
              └── .model().model()
                    └── .dataSources()        ← Array of all indicators
                          └── [i]
                                ├── .metaInfo().description   ← Indicator name
                                └── ._graphics
                                      └── ._primitivesCollection
                                            ├── dwglabels → labels → _primitivesDataById
                                            │     └── { t: "BOS ↑", x: barIndex, y: price }
                                            └── dwgboxes  → boxes  → _primitivesDataById
                                                  └── { x1, x2, y1, y2, backgroundColor }
```
