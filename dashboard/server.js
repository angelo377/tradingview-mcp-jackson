#!/usr/bin/env node
/**
 * dashboard/server.js
 * Local web dashboard for TradingView automation commands.
 * Serves the UI at http://localhost:3210
 * Streams script output live via WebSocket.
 */
import { createServer }   from 'http';
import { readFileSync, existsSync } from 'fs';
import { dirname, join }  from 'path';
import { fileURLToPath }  from 'url';
import { spawn }          from 'child_process';
import { WebSocketServer } from 'ws';
import net                from 'net';
import { execSync }       from 'child_process';

// Path to the Launch TradingView bat on the Desktop
const LAUNCH_BAT = 'C:\\Users\\admin\\Desktop\\Launch TradingView.bat';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');          // tradingview-mcp-jackson/
const PUBLIC     = join(__dirname, 'public');
const PORT       = 3210;

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

// ── Scripts map ──────────────────────────────────────────────────────────────
const SCRIPTS = {
  tv_cycle:              join(ROOT, 'scripts', 'tv_cycle.js'),
  tv_health_check:       join(ROOT, 'scripts', 'tv_healthcheck_full.js'),
  tv_earnings:           join(ROOT, 'scripts', 'tv_earnings.js'),
  tv_panel:              join(ROOT, 'scripts', 'tv_panel.js'),
  tv_refresh_watchlist:  join(ROOT, 'scripts', 'tv_refresh_watchlist.js'),
};

// ── Cache files ───────────────────────────────────────────────────────────────
const CACHES = {
  cycle:     join(ROOT, 'scripts', 'cycle_cache.json'),
  scan:      join(ROOT, 'scripts', 'scan_cache.json'),
  watchlist: join(ROOT, 'scripts', 'watchlist_cache.json'),
  earnings:  join(ROOT, 'scripts', 'earnings_cache.json'),
};

function readCache(key) {
  try {
    if (existsSync(CACHES[key])) return JSON.parse(readFileSync(CACHES[key], 'utf-8'));
  } catch (_) {}
  return null;
}

// ── TradingView CDP health check (port 9222) ──────────────────────────────────
function checkTVConnection() {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timeout = setTimeout(() => { sock.destroy(); resolve(false); }, 1500);
    sock.connect(9222, 'localhost', () => {
      clearTimeout(timeout); sock.destroy(); resolve(true);
    });
    sock.on('error', () => { clearTimeout(timeout); resolve(false); });
  });
}

// Broadcast TV status to all connected WebSocket clients every 5 seconds
let lastTVStatus = null;
async function broadcastTVStatus() {
  const online = await checkTVConnection();
  if (online !== lastTVStatus) {
    lastTVStatus = online;
    const msg = JSON.stringify({ type: 'tv_status', online });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ── REST API ─────────────────────────────────────────────────────────────
  if (path === '/api/cache' && req.method === 'GET') {
    const key = url.searchParams.get('key');
    const data = readCache(key);
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data || { error: 'not found' }));
  }

  if (path === '/api/watchlist' && req.method === 'GET') {
    const data = readCache('watchlist');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data || { symbols: [] }));
  }

  if (path === '/api/refresh-watchlist' && req.method === 'GET') {
    const scriptPath = SCRIPTS['tv_refresh_watchlist'];
    if (!existsSync(scriptPath)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'refresh script not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });

    const child = spawn('node', [scriptPath], { cwd: ROOT, env: { ...process.env } });
    child.stdout.on('data', d => res.write(`data: ${JSON.stringify({ type: 'log', text: d.toString().trim() })}\n\n`));
    child.stderr.on('data', d => res.write(`data: ${JSON.stringify({ type: 'log', text: d.toString().trim() })}\n\n`));
    child.on('close', (code) => {
      const wl = readCache('watchlist');
      res.write(`data: ${JSON.stringify({ type: 'done', code, count: wl?.symbols?.length || 0, symbols: wl?.symbols || [] })}\n\n`);
      res.end();
    });
    return;
  }

  if (path === '/api/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      server: 'running',
      port: PORT,
      caches: Object.fromEntries(
        Object.entries(CACHES).map(([k, p]) => [k, existsSync(p)])
      ),
    }));
  }

  if (path === '/api/tv-status' && req.method === 'GET') {
    const online = await checkTVConnection();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ online }));
  }

  if (path === '/api/launch-tv' && req.method === 'POST') {
    try {
      if (!existsSync(LAUNCH_BAT)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Launch TradingView.bat not found on Desktop' }));
      }
      // Run the bat file detached so it doesn't block the server
      spawn('cmd.exe', ['/c', LAUNCH_BAT], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, message: 'TradingView is launching…' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: e.message }));
    }
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = path === '/' ? join(PUBLIC, 'index.html') : join(PUBLIC, path.slice(1));
  const ext = filePath.match(/\.[a-z]+$/i)?.[0] || '.html';

  if (existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    return res.end(readFileSync(filePath));
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

// Active processes map: commandName → child process
const active = new Map();

wss.on('connection', (ws) => {
  // Send current TV status immediately on connect
  checkTVConnection().then(online => {
    ws.send(JSON.stringify({ type: 'tv_status', online }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    // ── run command ───────────────────────────────────────────────────────
    if (msg.type === 'run') {
      const cmd = msg.command;
      const scriptPath = SCRIPTS[cmd];
      if (!scriptPath || !existsSync(scriptPath)) {
        ws.send(JSON.stringify({ type: 'error', command: cmd, text: `Script not found: ${cmd}` }));
        return;
      }

      // Kill any existing run of this command
      if (active.has(cmd)) {
        try { active.get(cmd).kill(); } catch (_) {}
        active.delete(cmd);
      }

      ws.send(JSON.stringify({ type: 'start', command: cmd }));

      const child = spawn('node', [scriptPath], {
        cwd: ROOT,
        env: { ...process.env },
      });
      active.set(cmd, child);

      child.stdout.on('data', (d) => {
        ws.send(JSON.stringify({ type: 'stdout', command: cmd, text: d.toString() }));
      });
      child.stderr.on('data', (d) => {
        ws.send(JSON.stringify({ type: 'stderr', command: cmd, text: d.toString() }));
      });
      child.on('close', (code) => {
        active.delete(cmd);
        ws.send(JSON.stringify({ type: 'done', command: cmd, code }));
        // Send updated cache after completion
        const cacheKey = cmd === 'tv_cycle'        ? 'cycle'
                       : cmd === 'tv_health_check' ? 'scan'
                       : cmd === 'tv_earnings'     ? 'earnings'
                       : null;
        if (cacheKey) {
          const data = readCache(cacheKey);
          if (data) ws.send(JSON.stringify({ type: 'cache', command: cmd, cacheKey, data }));
        }
      });
    }

    // ── stop command ──────────────────────────────────────────────────────
    if (msg.type === 'stop') {
      const cmd = msg.command;
      if (active.has(cmd)) {
        try { active.get(cmd).kill(); } catch (_) {}
        active.delete(cmd);
        ws.send(JSON.stringify({ type: 'stopped', command: cmd }));
      }
    }

    // ── get cache ─────────────────────────────────────────────────────────
    if (msg.type === 'get_cache') {
      const data = readCache(msg.key);
      ws.send(JSON.stringify({ type: 'cache', cacheKey: msg.key, data }));
    }
  });

  ws.on('close', () => {
    // Kill all active processes when client disconnects
    active.forEach((child) => { try { child.kill(); } catch (_) {} });
    active.clear();
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n  🖥️  TradingView Dashboard running at http://localhost:${PORT}\n`);
  // Poll TradingView CDP status every 5 seconds
  setInterval(broadcastTVStatus, 5000);
  broadcastTVStatus(); // immediate first check
});
