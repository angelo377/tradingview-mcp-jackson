#!/usr/bin/env node
/**
 * tv_refresh_watchlist.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lightweight live watchlist scrape — updates watchlist_cache.json from the
 * live TradingView DOM without running a full Cycle Scan.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join }                           from 'path';
import { fileURLToPath }                           from 'url';
import { get as getWatchlist }                     from '../src/core/watchlist.js';

process.on('unhandledRejection', () => {});

const __dirname  = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = join(__dirname, 'watchlist_cache.json');

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

(async () => {
  console.log('  🔄 Scraping live watchlist from TradingView…');

  try {
    const wl = await withTimeout(getWatchlist(), 60000, { count: 0, symbols: [] });

    if (!wl || wl.count === 0) {
      console.log('  ❌ No symbols returned — TradingView may not be open or focused.');
      process.exit(1);
    }

    const symbols = wl.symbols.map(s => s.symbol);
    console.log(`  ✅ Found ${symbols.length} symbols (source: ${wl.source})`);

    // Read existing cache to preserve name/signals/earnings fields
    let cache = { name: 'UOA Watchlist', symbols: [] };
    try {
      if (existsSync(CACHE_FILE)) {
        cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
      }
    } catch (_) {}

    cache.symbols = symbols;
    cache.updated = new Date().toISOString().slice(0, 10);
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

    console.log(`  💾 watchlist_cache.json updated — ${symbols.length} symbols`);
    process.exit(0);

  } catch (err) {
    console.error('  ❌ Error:', err.message || err);
    process.exit(1);
  }
})();
