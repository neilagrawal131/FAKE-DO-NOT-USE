// Our own market-data database.
//
//     Polygon / Yahoo  ->  marketdb  ->  Dashboard & backtester
//
// Every OHLCV bar we ever fetch is stored here, so the backtester reads from OUR
// database instead of repeatedly calling the API. Over time the store accumulates
// years of bars that belong to us and can be scanned for free.
//
// Backend: uses the built-in `node:sqlite` when available (scales to minute bars
// and beyond); otherwise falls back to a zero-dependency per-symbol file store so
// it still works on any Node version.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { saveJSON, loadJSON } from './store.js';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'data');
const SQLITE_FILE = join(DATA_DIR, 'marketdb.sqlite');
const FILE_DIR = join(DATA_DIR, 'marketdb');

const DAILY_INTERVALS = new Set(['1d', '1wk', '1mo']);
const INTERVAL_SECONDS = { '1m': 60, '5m': 300, '10m': 600, '15m': 900, '30m': 1800, '60m': 3600, '1h': 3600, '90m': 5400, '1d': 86400, '1wk': 604800, '1mo': 2592000 };
const intervalSeconds = (iv) => INTERVAL_SECONDS[iv] || 86400;

// ---- SQLite backend ----------------------------------------------------------
class SqliteStore {
  constructor(DatabaseSync, file) {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;'); // tolerate the backfill script writing concurrently
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS bars (symbol TEXT, interval TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (symbol, interval, t));'
    );
    this.insert = this.db.prepare('INSERT OR REPLACE INTO bars (symbol, interval, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.selRange = this.db.prepare('SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND interval = ? AND t BETWEEN ? AND ? ORDER BY t');
    this.selAll = this.db.prepare('SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND interval = ? ORDER BY t');
  }
  getBars(symbol, interval, from, to) {
    const rows = from == null || to == null ? this.selAll.all(symbol, interval) : this.selRange.all(symbol, interval, from, to);
    return rows.map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }));
  }
  upsert(symbol, interval, bars) {
    if (!bars.length) return;
    this.db.exec('BEGIN');
    try {
      for (const b of bars) this.insert.run(symbol, interval, b.time, b.open, b.high, b.low, b.close, b.volume || 0);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
  stats() {
    const g = this.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT symbol) syms, MIN(t) lo, MAX(t) hi FROM bars').get();
    const perInt = this.db.prepare('SELECT interval, COUNT(*) n FROM bars GROUP BY interval').all();
    return { backend: 'sqlite', bars: g.n || 0, symbols: g.syms || 0, from: g.lo || null, to: g.hi || null, byInterval: Object.fromEntries(perInt.map((r) => [r.interval, r.n])) };
  }
}

// ---- file backend (fallback) -------------------------------------------------
class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  _path(symbol, interval) {
    return join(this.dir, `${symbol}__${interval}.json`);
  }
  _load(symbol, interval) {
    const key = `${symbol}|${interval}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const arr = loadJSON(this._path(symbol, interval), () => []) || [];
    this.cache.set(key, arr);
    return arr;
  }
  getBars(symbol, interval, from, to) {
    const arr = this._load(symbol, interval);
    return from == null || to == null ? arr.slice() : arr.filter((b) => b.time >= from && b.time <= to);
  }
  upsert(symbol, interval, bars) {
    if (!bars.length) return;
    const byT = new Map(this._load(symbol, interval).map((b) => [b.time, b]));
    for (const b of bars) byT.set(b.time, { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    const merged = [...byT.values()].sort((a, b) => a.time - b.time);
    this.cache.set(`${symbol}|${interval}`, merged);
    saveJSON(this._path(symbol, interval), merged);
  }
  stats() {
    let files = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      /* none yet */
    }
    let bars = 0;
    const syms = new Set();
    for (const f of files) {
      const [sym] = f.replace(/\.json$/, '').split('__');
      syms.add(sym);
      const [s, i] = f.replace(/\.json$/, '').split('__');
      bars += this._load(s, i).length;
    }
    return { backend: 'file', bars, symbols: syms.size, files: files.length };
  }
}

// ---- backend selection -------------------------------------------------------
let store;
let backendName;
try {
  const { DatabaseSync } = require('node:sqlite');
  store = new SqliteStore(DatabaseSync, SQLITE_FILE);
  backendName = 'sqlite';
} catch {
  store = new FileStore(FILE_DIR);
  backendName = 'file';
}

export function getBars(symbol, interval, from, to) {
  return store.getBars(String(symbol).toUpperCase(), interval, from, to);
}
export function upsertBars(symbol, interval, bars) {
  return store.upsert(String(symbol).toUpperCase(), interval, bars || []);
}
export function dbStats() {
  return store.stats();
}
export function dbBackend() {
  return backendName;
}

// ---- provider wrapper: read from the DB, fetch-and-store on a miss -----------
// How stale the newest stored bar may be before we top up from upstream.
const RANGE_DAYS = { '1d': 4, '5d': 8, '1mo': 33, '3mo': 95, '6mo': 190, '1y': 370, '2y': 735, '5y': 1830, max: 30 * 365 };
const FETCH_COOLDOWN_MS = Number(process.env.MARKETDB_FETCH_COOLDOWN_MS) || 60 * 60 * 1000; // don't re-hit upstream for the same series more than hourly

function windowFor(range) {
  const days = RANGE_DAYS[range] ?? 33;
  const to = Math.floor(Date.now() / 1000);
  return { from: to - days * 86400, to };
}
function covers(bars, from, to, interval) {
  if (bars.length < 20) return false;
  const oldest = bars[0].time;
  const newest = bars[bars.length - 1].time;
  const maxStale = DAILY_INTERVALS.has(interval) ? 30 * 3600 : 3 * 3600;
  const startTol = intervalSeconds(interval) * 5;
  return oldest <= from + startTol && newest >= to - maxStale;
}
function metaFromBars(symbol, bars) {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  return { symbol, currency: 'USD', exchange: null, regularMarketPrice: last ? last.close : null, previousClose: prev ? prev.close : last ? last.open : null, regularMarketTime: last ? last.time : null };
}

export function withDatabase(upstream) {
  const lastFetch = new Map();
  return {
    async chart(symbol, range = '1mo', interval = '1d') {
      const sym = String(symbol).toUpperCase();
      const { from, to } = windowFor(range);
      const stored = store.getBars(sym, interval, from, to);
      const key = `${sym}|${interval}`;
      const cooled = Date.now() - (lastFetch.get(key) || 0) < FETCH_COOLDOWN_MS;
      // Serve from our database when it covers the window, or when we already
      // topped it up recently (so short-history symbols don't refetch forever).
      if (covers(stored, from, to, interval) || (stored.length >= 30 && cooled)) {
        return { meta: metaFromBars(sym, stored), bars: stored, source: 'db' };
      }
      let fresh;
      try {
        fresh = await upstream.chart(symbol, range, interval);
      } catch (err) {
        if (stored.length) return { meta: metaFromBars(sym, stored), bars: stored, source: 'db-stale' };
        throw err;
      }
      lastFetch.set(key, Date.now());
      store.upsert(sym, interval, fresh.bars || []);
      const merged = store.getBars(sym, interval, from, to);
      return { meta: fresh.meta, bars: merged.length ? merged : fresh.bars || [], source: 'upstream' };
    },
    // Live snapshots stay on the upstream (they aren't historical bars).
    quote: (...a) => upstream.quote(...a),
    lastPrice: (...a) => upstream.lastPrice(...a),
    search: (...a) => upstream.search(...a),
    INTRADAY_MAX_DAYS: upstream.INTRADAY_MAX_DAYS,
  };
}
