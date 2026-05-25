/**
 * Core watchlist logic.
 * Uses TradingView's internal widget API with DOM fallback.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

export async function get() {
  // Helper: collect all visible data-symbol-full elements
  async function scrapeVisible() {
    return await evaluate(`
      (function() {
        var els = document.querySelectorAll('[data-symbol-full]');
        var syms = [];
        for (var i = 0; i < els.length; i++) {
          var s = els[i].getAttribute('data-symbol-full');
          if (s) syms.push(s);
        }
        return syms;
      })()
    `);
  }

  // Helper: scroll the watchlist container to a given scrollTop
  async function scrollTo(pos) {
    return await evaluate(`
      (function() {
        var container = document.querySelector('[class*="layout__area--right"]');
        if (!container) return false;
        var best = null, bestSH = 0;
        var all = container.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (el.scrollHeight > el.clientHeight + 100 && el.scrollHeight > bestSH) {
            best = el; bestSH = el.scrollHeight;
          }
        }
        if (!best) return false;
        best.scrollTop = ${pos};
        return { scrollHeight: best.scrollHeight, clientHeight: best.clientHeight };
      })()
    `);
  }

  const seen = new Set();
  const allSymbols = [];

  const ROW_H      = 40;   // TradingView watchlist row height
  const STEP_DELAY = 160;  // ms between steps

  // ── Step 1: Scrape at top ──────────────────────────────────────────────────
  await scrollTo(0);
  await new Promise(r => setTimeout(r, 400));
  (await scrapeVisible() || []).forEach(s => {
    if (!seen.has(s)) { seen.add(s); allSymbols.push(s); }
  });

  // ── Step 2: Scroll to absolute bottom, get the actual maxScroll ────────────
  const bottomInfo = await scrollTo(999999);
  await new Promise(r => setTimeout(r, 400));
  (await scrapeVisible() || []).forEach(s => {
    if (!seen.has(s)) { seen.add(s); allSymbols.push(s); }
  });

  // Determine true maxScroll from the bottom position
  const trueMax = bottomInfo?.scrollHeight && bottomInfo?.clientHeight
    ? bottomInfo.scrollHeight - bottomInfo.clientHeight
    : 2400;   // safe fallback for ~60-item watchlist

  // ── Step 3: Sweep from bottom back to top in 40px steps ───────────────────
  for (let pos = trueMax; pos >= 0; pos -= ROW_H) {
    await scrollTo(pos);
    await new Promise(r => setTimeout(r, STEP_DELAY));
    (await scrapeVisible() || []).forEach(s => {
      if (!seen.has(s)) { seen.add(s); allSymbols.push(s); }
    });
  }

  // ── Restore scroll to top ──────────────────────────────────────────────────
  await scrollTo(0);
  await new Promise(r => setTimeout(r, 200));

  if (allSymbols.length > 0) {
    return {
      success: true,
      count:   allSymbols.length,
      source:  'scroll_scrape',
      symbols: allSymbols.map(sym => ({ symbol: sym, last: null, change: null, change_percent: null })),
    };
  }

  // Fallback: static text scan
  const fallback = await evaluate(`
    (function() {
      var results = [], seen = {};
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };
      var items = container.querySelectorAll('[class*="symbolName"],[class*="tickerName"],[class*="symbol-"]');
      for (var k = 0; k < items.length; k++) {
        var text = items[k].textContent.trim();
        if (text && /^[A-Z][A-Z0-9.:!]{0,20}$/.test(text) && !seen[text]) {
          seen[text] = true;
          results.push({ symbol: text, last: null, change: null, change_percent: null });
        }
      }
      return { symbols: results, source: 'text_scan' };
    })()
  `);

  return {
    success: true,
    count:   fallback?.symbols?.length || 0,
    source:  fallback?.source || 'unknown',
    symbols: fallback?.symbols || [],
  };
}

export async function add({ symbol }) {
  // Use keyboard shortcut to open symbol search in watchlist, type symbol, press Enter
  const c = await getClient();

  // First ensure watchlist panel is open
  const panelState = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="base-watchlist-widget-button"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (!btn) return { error: 'Watchlist button not found' };
      var isActive = btn.getAttribute('aria-pressed') === 'true'
        || btn.classList.toString().indexOf('Active') !== -1
        || btn.classList.toString().indexOf('active') !== -1;
      if (!isActive) { btn.click(); return { opened: true }; }
      return { opened: false };
    })()
  `);

  if (panelState?.error) throw new Error(panelState.error);
  if (panelState?.opened) await new Promise(r => setTimeout(r, 500));

  // Click the "Add symbol" button (various selectors)
  const addClicked = await evaluate(`
    (function() {
      var selectors = [
        '[data-name="add-symbol-button"]',
        '[aria-label="Add symbol"]',
        '[aria-label*="Add symbol"]',
        'button[class*="addSymbol"]',
      ];
      for (var s = 0; s < selectors.length; s++) {
        var btn = document.querySelector(selectors[s]);
        if (btn && btn.offsetParent !== null) { btn.click(); return { found: true, selector: selectors[s] }; }
      }
      // Fallback: find + button in right panel
      var container = document.querySelector('[class*="layout__area--right"]');
      if (container) {
        var buttons = container.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
          var ariaLabel = buttons[i].getAttribute('aria-label') || '';
          if (/add.*symbol/i.test(ariaLabel) || buttons[i].textContent.trim() === '+') {
            buttons[i].click();
            return { found: true, method: 'fallback' };
          }
        }
      }
      return { found: false };
    })()
  `);

  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await new Promise(r => setTimeout(r, 300));

  // Type the symbol into the search input
  await c.Input.insertText({ text: symbol });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to select the first result
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await new Promise(r => setTimeout(r, 300));

  // Press Escape to close search
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });

  return { success: true, symbol, action: 'added' };
}
