import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.error(
    `\n  This journal needs Node.js 22.5 or newer (it uses the built-in node:sqlite module).\n  You are running ${process.version}. Install a newer Node from https://nodejs.org and try again.\n`,
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.JOURNAL_DB || path.join(DATA_DIR, 'journal.db');

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}
const PORT = Number(flag('port', process.env.PORT || 4173));
const HOST = flag('host', process.env.HOST || '0.0.0.0');
const OPEN_BROWSER = argv.includes('--open');
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol       TEXT    NOT NULL,
    side         TEXT    NOT NULL DEFAULT 'long',
    setup        TEXT    NOT NULL DEFAULT '',
    entry_price  REAL    NOT NULL,
    exit_price   REAL,
    size         REAL    NOT NULL,
    stop_price   REAL,
    target_price REAL,
    fees         REAL    NOT NULL DEFAULT 0,
    entry_at     TEXT    NOT NULL,
    exit_at      TEXT,
    notes        TEXT    NOT NULL DEFAULT '',
    rating       INTEGER,
    created_at   TEXT    NOT NULL,
    updated_at   TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_trades_entry ON trades(entry_at);
  CREATE INDEX IF NOT EXISTS idx_trades_setup ON trades(setup);

  CREATE TABLE IF NOT EXISTS images (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id   INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL DEFAULT 'screenshot',
    mime       TEXT    NOT NULL DEFAULT 'image/png',
    data       BLOB    NOT NULL,
    created_at TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_images_trade ON images(trade_id);
`);

/* ---------------------------------------------------------------- helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const nowIso = () => new Date().toISOString();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, 1024 * 1024);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v, fallback = '') => (typeof v === 'string' ? v.trim() : v == null ? fallback : String(v).trim());

/** Normalise + validate an incoming trade payload. */
function normaliseTrade(input, { partial = false } = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const out = {};

  if (has('symbol') || !partial) out.symbol = str(input.symbol).toUpperCase().slice(0, 24);
  if (has('setup') || !partial) out.setup = str(input.setup).slice(0, 60);
  if (has('side') || !partial) out.side = input.side === 'short' ? 'short' : 'long';
  if (has('entry_price') || !partial) out.entry_price = num(input.entry_price);
  if (has('size') || !partial) out.size = num(input.size);
  if (has('exit_price')) out.exit_price = num(input.exit_price);
  if (has('stop_price')) out.stop_price = num(input.stop_price);
  if (has('target_price')) out.target_price = num(input.target_price);
  if (has('fees')) out.fees = num(input.fees) ?? 0;
  else if (!partial) out.fees = 0;
  if (has('entry_at') || !partial) out.entry_at = str(input.entry_at) || new Date().toISOString().slice(0, 16);
  if (has('exit_at')) out.exit_at = str(input.exit_at) || null;
  if (has('notes') || !partial) out.notes = typeof input.notes === 'string' ? input.notes.slice(0, 20000) : '';
  if (has('rating')) {
    const r = num(input.rating);
    out.rating = r === null ? null : Math.min(5, Math.max(1, Math.round(r)));
  }

  if (!partial) {
    if (!out.symbol) throw Object.assign(new Error('Symbol is required'), { status: 400 });
    if (out.entry_price === null || out.entry_price <= 0) throw Object.assign(new Error('Entry price must be greater than 0'), { status: 400 });
    if (out.size === null || out.size <= 0) throw Object.assign(new Error('Position size must be greater than 0'), { status: 400 });
    if (!out.entry_at) throw Object.assign(new Error('Entry time is required'), { status: 400 });
  }
  return out;
}

const TRADE_COLUMNS = ['symbol', 'setup', 'side', 'entry_price', 'exit_price', 'size', 'stop_price', 'target_price', 'fees', 'entry_at', 'exit_at', 'notes', 'rating'];

function listTrades() {
  const rows = db.prepare(`SELECT * FROM trades ORDER BY COALESCE(exit_at, entry_at) DESC, id DESC`).all();
  const imgs = db.prepare(`SELECT id, trade_id, name, mime, created_at FROM images ORDER BY id`).all();
  const byTrade = new Map();
  for (const img of imgs) {
    if (!byTrade.has(img.trade_id)) byTrade.set(img.trade_id, []);
    byTrade.get(img.trade_id).push({ id: img.id, name: img.name, mime: img.mime, created_at: img.created_at });
  }
  return rows.map((r) => ({ ...r, images: byTrade.get(r.id) || [] }));
}

function getTrade(id) {
  const row = db.prepare(`SELECT * FROM trades WHERE id = ?`).get(id);
  if (!row) return null;
  row.images = db
    .prepare(`SELECT id, trade_id, name, mime, created_at FROM images WHERE trade_id = ? ORDER BY id`)
    .all(id);
  return row;
}

/* ------------------------------------------------------------- sample data */

function seedSampleData() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM trades').get().n;
  if (existing > 0) return { inserted: 0 };

  const setups = [
    { name: 'Opening range breakout', win: 0.62, rr: 2.1, symbols: ['NVDA', 'AMD', 'TSLA', 'META'] },
    { name: 'VWAP reclaim', win: 0.58, rr: 1.6, symbols: ['SPY', 'QQQ', 'AAPL', 'MSFT'] },
    { name: 'Failed breakdown', win: 0.7, rr: 2.6, symbols: ['BTCUSD', 'ETHUSD', 'COIN'] },
    { name: 'Trend pullback', win: 0.55, rr: 1.9, symbols: ['AMZN', 'GOOGL', 'NFLX'] },
    { name: 'Earnings gap fade', win: 0.42, rr: 1.3, symbols: ['SHOP', 'PLTR', 'SMCI'] },
  ];
  const notesGood = [
    'Waited for the retest instead of chasing. Fill was clean and the stop never got tested.',
    'Sized down since volatility was elevated. Took partials into the first resistance shelf.',
    'Textbook setup. Trail moved to breakeven after 1R and let the rest run.',
    'News catalyst lined up with the level. Managed risk well and let the runner work.',
  ];
  const notesBad = [
    'Entered before the level confirmed. Should have waited for the reclaim candle to close.',
    'Moved my stop twice. Size was too big for the range, got shaken out.',
    'Chased the extension, no plan for the exit, ended up cutting for a scratch.',
    'Ignored the higher timeframe trend. Faded strength into a strong tape.',
  ];

  let seed = 1337;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const insert = db.prepare(`
    INSERT INTO trades (symbol, side, setup, entry_price, exit_price, size, stop_price, target_price, fees, entry_at, exit_at, notes, rating, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let cursor = new Date();
  cursor.setHours(9, 30, 0, 0);
  cursor.setDate(cursor.getDate() - 26);
  const trades = [];

  for (let day = 0; day < 26; day++) {
    const date = new Date(cursor);
    date.setDate(cursor.getDate() + day);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    const perDay = rand() < 0.28 ? 0 : rand() < 0.5 ? 1 : rand() < 0.85 ? 2 : 3;
    for (let i = 0; i < perDay; i++) {
      const setup = setups[Math.floor(rand() * setups.length)];
      const symbol = setup.symbols[Math.floor(rand() * setup.symbols.length)];
      const side = rand() < 0.28 ? 'short' : 'long';
      const base = symbol.includes('BTC') ? 61000 : symbol.includes('ETH') ? 3100 : symbol === 'SPY' || symbol === 'QQQ' ? 480 : 60 + rand() * 240;
      const entry = Math.round((base * (1 + (rand() - 0.5) * 0.02)) * 100) / 100;
      const stopDist = entry * (0.004 + rand() * 0.01);
      const stop = Math.round((entry - (side === 'long' ? stopDist : -stopDist)) * 100) / 100;
      const riskPerShare = Math.abs(entry - stop);
      const size = Math.max(1, Math.round((riskPerShare > 0 ? 600 / riskPerShare : 100) * 10) / 10);
      const win = rand() < setup.win;
      const rMult = win ? 0.6 + rand() * setup.rr * 1.2 : -(0.35 + rand() * 1.05);
      const move = riskPerShare * rMult * (side === 'long' ? 1 : -1);
      const exit = Math.round((entry + move) * 100) / 100;
      const target = Math.round((entry + riskPerShare * setup.rr * (side === 'long' ? 1 : -1)) * 100) / 100;
      const fees = Math.round(size * 0.005 * 100) / 100;

      const entryAt = new Date(date);
      entryAt.setHours(9 + Math.floor(rand() * 6), Math.floor(rand() * 60), 0, 0);
      const exitAt = new Date(entryAt.getTime() + (6 + rand() * 180) * 60000);
      const iso = (d) => {
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      const notes = rand() < 0.75 ? (win ? notesGood : notesBad)[Math.floor(rand() * 4)] : '';
      const rating = win ? 3 + Math.round(rand() * 2) : 1 + Math.round(rand() * 3);
      const timestamp = nowIso();

      const info = insert.run(symbol, side, setup.name, entry, exit, size, stop, target, fees, iso(entryAt), iso(exitAt), notes, rating, timestamp, timestamp);
      trades.push(info.lastInsertRowid);
    }
  }
  return { inserted: trades.length };
}

/* -------------------------------------------------------------- static file */

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  } catch {
    fail(res, 404, 'Not found');
  }
}

/* ------------------------------------------------------------------- router */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (parts[0] === 'api') {
      const [, resource, idRaw, sub] = parts;

      if (resource === 'health') return sendJson(res, 200, { ok: true });

      if (resource === 'trades' && parts.length === 2) {
        if (req.method === 'GET') return sendJson(res, 200, { trades: listTrades() });
        if (req.method === 'POST') {
          const data = normaliseTrade(await readJson(req));
          const ts = nowIso();
          const cols = [...TRADE_COLUMNS];
          const values = cols.map((c) => (data[c] === undefined ? null : data[c]));
          const placeholders = cols.map(() => '?').join(', ');
          const info = db
            .prepare(`INSERT INTO trades (${cols.join(', ')}, created_at, updated_at) VALUES (${placeholders}, ?, ?)`)
            .run(...values, ts, ts);
          return sendJson(res, 201, { trade: getTrade(info.lastInsertRowid) });
        }
        if (req.method === 'DELETE') {
          db.exec('DELETE FROM images; DELETE FROM trades;');
          return sendJson(res, 200, { ok: true });
        }
      }

      if (resource === 'trades' && idRaw && parts.length === 3) {
        const id = Number(idRaw);
        if (!Number.isInteger(id)) return fail(res, 400, 'Bad trade id');
        const existing = getTrade(id);
        if (!existing) return fail(res, 404, 'Trade not found');

        if (req.method === 'GET') return sendJson(res, 200, { trade: existing });

        if (req.method === 'PATCH' || req.method === 'PUT') {
          const patch = normaliseTrade(await readJson(req), { partial: req.method === 'PATCH' });
          const keys = Object.keys(patch).filter((k) => TRADE_COLUMNS.includes(k));
          if (!keys.length) return sendJson(res, 200, { trade: existing });
          const merged = { ...existing, ...patch };
          // Re-validate the fully merged record so a partial edit cannot break invariants.
          const valid = normaliseTrade(merged);
          const assignments = keys.map((k) => `${k} = ?`).join(', ');
          db.prepare(`UPDATE trades SET ${assignments}, updated_at = ? WHERE id = ?`).run(
            ...keys.map((k) => valid[k] ?? null),
            nowIso(),
            id,
          );
          return sendJson(res, 200, { trade: getTrade(id) });
        }

        if (req.method === 'DELETE') {
          db.prepare('DELETE FROM trades WHERE id = ?').run(id);
          return sendJson(res, 200, { ok: true });
        }
      }

      if (resource === 'trades' && idRaw && sub === 'images') {
        const tradeId = Number(idRaw);
        const trade = db.prepare('SELECT id FROM trades WHERE id = ?').get(tradeId);
        if (!trade) return fail(res, 404, 'Trade not found');
        if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');

        const body = await readBody(req, MAX_IMAGE_BYTES);
        if (!body.length) return fail(res, 400, 'Empty upload');
        const mime = String(req.headers['content-type'] || 'image/png').split(';')[0];
        if (!/^image\/(png|jpeg|jpg|webp|gif)$/i.test(mime)) return fail(res, 415, 'Only PNG, JPEG, WebP or GIF images are supported');
        const name = str(url.searchParams.get('name') || 'screenshot').slice(0, 120) || 'screenshot';
        const info = db
          .prepare('INSERT INTO images (trade_id, name, mime, data, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(tradeId, name, mime, body, nowIso());
        return sendJson(res, 201, { image: { id: info.lastInsertRowid, trade_id: tradeId, name, mime } });
      }

      if (resource === 'images' && idRaw && parts.length === 3) {
        const imageId = Number(idRaw);
        const row = db.prepare('SELECT id, mime, data, name FROM images WHERE id = ?').get(imageId);
        if (!row) return fail(res, 404, 'Image not found');
        if (req.method === 'DELETE') {
          db.prepare('DELETE FROM images WHERE id = ?').run(imageId);
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'GET') {
          const buf = Buffer.from(row.data);
          res.writeHead(200, {
            'content-type': row.mime || 'image/png',
            'content-length': buf.length,
            'cache-control': 'public, max-age=31536000, immutable',
          });
          return res.end(buf);
        }
      }

      if (resource === 'seed' && req.method === 'POST') {
        const result = seedSampleData();
        return sendJson(res, 200, { ...result, trades: listTrades() });
      }

      return fail(res, 404, 'Unknown API route');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed');
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) console.error(err);
    return fail(res, status, err?.message || 'Server error');
  }
});

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already in use — another copy of the journal is probably running.\n` +
        `  Open http://${HOST}:${PORT} in your browser, or start on another port:\n\n` +
        `    npm start -- --port ${PORT + 1}\n`,
    );
  } else if (err.code === 'EACCES') {
    console.error(`\n  Not allowed to listen on ${HOST}:${PORT}. Try a different port with: npm start -- --port 8080\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Trading journal running at ${url}\n  Database: ${DB_PATH}\n  Press Ctrl+C to stop.\n`);
  if (OPEN_BROWSER) openBrowser(url);
});

export { server, db, seedSampleData };
