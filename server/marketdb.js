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
    // Corporate actions: one row per stock split we know about.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS splits (symbol TEXT, ts INTEGER, sfrom REAL, sto REAL, applied INTEGER DEFAULT 0, PRIMARY KEY (symbol, ts));'
    );
    // Cash dividends: one row per ex-dividend date.
    this.db.exec('CREATE TABLE IF NOT EXISTS dividends (symbol TEXT, ts INTEGER, cash REAL, PRIMARY KEY (symbol, ts));');
    // Earnings announcement dates.
    this.db.exec('CREATE TABLE IF NOT EXISTS earnings (symbol TEXT, ts INTEGER, PRIMARY KEY (symbol, ts));');
    this.insert = this.db.prepare('INSERT OR REPLACE INTO bars (symbol, interval, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.selRange = this.db.prepare('SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND interval = ? AND t BETWEEN ? AND ? ORDER BY t');
    this.selAll = this.db.prepare('SELECT t, o, h, l, c, v FROM bars WHERE symbol = ? AND interval = ? ORDER BY t');
    this.selSplits = this.db.prepare('SELECT ts, sfrom, sto, applied FROM splits WHERE symbol = ? ORDER BY ts');
    this.insSplit = this.db.prepare('INSERT OR IGNORE INTO splits (symbol, ts, sfrom, sto, applied) VALUES (?, ?, ?, ?, ?)');
    this.getApplied = this.db.prepare('SELECT applied FROM splits WHERE symbol = ? AND ts = ?');
    this.setApplied = this.db.prepare('UPDATE splits SET applied = 1 WHERE symbol = ? AND ts = ?');
    // Back-adjust every stored bar before a split: prices x priceMul, volume x volMul.
    this.adjust = this.db.prepare('UPDATE bars SET o = o * ?, h = h * ?, l = l * ?, c = c * ?, v = v * ? WHERE symbol = ? AND t < ?');
    this.selDivs = this.db.prepare('SELECT ts, cash FROM dividends WHERE symbol = ? ORDER BY ts');
    this.insDiv = this.db.prepare('INSERT OR REPLACE INTO dividends (symbol, ts, cash) VALUES (?, ?, ?)');
    this.selDivsBetween = this.db.prepare('SELECT ts, cash FROM dividends WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts');
  }
  getDividends(symbol) {
    return this.selDivs.all(symbol).map((r) => ({ ts: r.ts, cash: r.cash }));
  }
  recordDividend(symbol, ts, cash) {
    this.insDiv.run(symbol, ts, cash);
  }
  dividendsBetween(symbol, from, to) {
    return this.selDivsBetween.all(symbol, from, to).map((r) => ({ ts: r.ts, cash: r.cash }));
  }
  getEarnings(symbol) {
    return (this._selEarn || (this._selEarn = this.db.prepare('SELECT ts FROM earnings WHERE symbol = ? ORDER BY ts'))).all(symbol).map((r) => r.ts);
  }
  recordEarning(symbol, ts) {
    (this._insEarn || (this._insEarn = this.db.prepare('INSERT OR IGNORE INTO earnings (symbol, ts) VALUES (?, ?)'))).run(symbol, ts);
  }
  earningsBetween(symbol, from, to) {
    return (this._selEarnBtw || (this._selEarnBtw = this.db.prepare('SELECT ts FROM earnings WHERE symbol = ? AND ts > ? AND ts <= ? ORDER BY ts'))).all(symbol, from, to).map((r) => r.ts);
  }
  getSplits(symbol) {
    return this.selSplits.all(symbol).map((r) => ({ ts: r.ts, from: r.sfrom, to: r.sto, applied: r.applied === 1 }));
  }
  recordSplit(symbol, ts, from, to, applied) {
    this.insSplit.run(symbol, ts, from, to, applied ? 1 : 0);
  }
  splitApplied(symbol, ts) {
    const r = this.getApplied.get(symbol, ts);
    return r ? r.applied === 1 : false;
  }
  markSplitApplied(symbol, ts) {
    this.setApplied.run(symbol, ts);
  }
  adjustBars(symbol, beforeTs, priceMul, volMul) {
    this.adjust.run(priceMul, priceMul, priceMul, priceMul, volMul, symbol, beforeTs);
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
    const sp = this.db.prepare('SELECT COUNT(*) n FROM splits').get();
    const dv = this.db.prepare('SELECT COUNT(*) n FROM dividends').get();
    const ea = this.db.prepare('SELECT COUNT(*) n FROM earnings').get();
    return { backend: 'sqlite', bars: g.n || 0, symbols: g.syms || 0, from: g.lo || null, to: g.hi || null, byInterval: Object.fromEntries(perInt.map((r) => [r.interval, r.n])), splits: sp.n || 0, dividends: dv.n || 0, earnings: ea.n || 0 };
  }
}

// ---- file backend (fallback) -------------------------------------------------
class FileStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.splitsFile = join(dir, '_splits.json');
    this.splits = loadJSON(this.splitsFile, () => ({})) || {}; // { symbol: [{ts,from,to,applied}] }
    this.divsFile = join(dir, '_dividends.json');
    this.divs = loadJSON(this.divsFile, () => ({})) || {}; // { symbol: [{ts,cash}] }
    this.earnFile = join(dir, '_earnings.json');
    this.earn = loadJSON(this.earnFile, () => ({})) || {}; // { symbol: [ts, ...] }
  }
  getEarnings(symbol) {
    return (this.earn[symbol] || []).slice();
  }
  recordEarning(symbol, ts) {
    const list = this.earn[symbol] || (this.earn[symbol] = []);
    if (!list.includes(ts)) {
      list.push(ts);
      list.sort((a, b) => a - b);
      saveJSON(this.earnFile, this.earn);
    }
  }
  earningsBetween(symbol, from, to) {
    return (this.earn[symbol] || []).filter((ts) => ts > from && ts <= to);
  }
  _saveSplits() {
    saveJSON(this.splitsFile, this.splits);
  }
  getDividends(symbol) {
    return (this.divs[symbol] || []).map((d) => ({ ...d }));
  }
  recordDividend(symbol, ts, cash) {
    const list = this.divs[symbol] || (this.divs[symbol] = []);
    const ex = list.find((d) => d.ts === ts);
    if (ex) ex.cash = cash;
    else {
      list.push({ ts, cash });
      list.sort((a, b) => a.ts - b.ts);
    }
    saveJSON(this.divsFile, this.divs);
  }
  dividendsBetween(symbol, from, to) {
    return (this.divs[symbol] || []).filter((d) => d.ts > from && d.ts <= to).map((d) => ({ ...d }));
  }
  _intervals(symbol) {
    let files = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.startsWith(`${symbol}__`) && f.endsWith('.json'));
    } catch {
      /* none */
    }
    return files.map((f) => f.replace(/\.json$/, '').split('__')[1]);
  }
  getSplits(symbol) {
    return (this.splits[symbol] || []).map((s) => ({ ...s }));
  }
  recordSplit(symbol, ts, from, to, applied) {
    const list = this.splits[symbol] || (this.splits[symbol] = []);
    if (!list.some((s) => s.ts === ts)) {
      list.push({ ts, from, to, applied: !!applied });
      list.sort((a, b) => a.ts - b.ts);
      this._saveSplits();
    }
  }
  splitApplied(symbol, ts) {
    const s = (this.splits[symbol] || []).find((x) => x.ts === ts);
    return s ? !!s.applied : false;
  }
  markSplitApplied(symbol, ts) {
    const s = (this.splits[symbol] || []).find((x) => x.ts === ts);
    if (s) {
      s.applied = true;
      this._saveSplits();
    }
  }
  adjustBars(symbol, beforeTs, priceMul, volMul) {
    for (const interval of this._intervals(symbol)) {
      const arr = this._load(symbol, interval);
      let changed = false;
      for (const b of arr) {
        if (b.time < beforeTs) {
          b.open *= priceMul;
          b.high *= priceMul;
          b.low *= priceMul;
          b.close *= priceMul;
          b.volume = (b.volume || 0) * volMul;
          changed = true;
        }
      }
      if (changed) saveJSON(this._path(symbol, interval), arr);
    }
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
    const splits = Object.values(this.splits).reduce((a, l) => a + l.length, 0);
    const dividends = Object.values(this.divs).reduce((a, l) => a + l.length, 0);
    const earnings = Object.values(this.earn).reduce((a, l) => a + l.length, 0);
    return { backend: 'file', bars, symbols: syms.size, files: files.length, splits, dividends, earnings };
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
export function getSplits(symbol) {
  return store.getSplits(String(symbol).toUpperCase());
}
export function getDividends(symbol) {
  return store.getDividends(String(symbol).toUpperCase());
}
// Cash dividends with an ex-date in (from, to] — used to make holding-period
// returns total-return (add back what you'd have been paid while holding).
export function dividendsBetween(symbol, from, to) {
  return store.dividendsBetween(String(symbol).toUpperCase(), from, to);
}
export function recordDividends(symbol, events) {
  const sym = String(symbol).toUpperCase();
  let n = 0;
  for (const e of events || []) {
    if (!(e.ts > 0) || !(e.cash > 0)) continue;
    store.recordDividend(sym, e.ts, e.cash);
    n++;
  }
  return n;
}
export function getEarnings(symbol) {
  return store.getEarnings(String(symbol).toUpperCase());
}
export function recordEarnings(symbol, events) {
  const sym = String(symbol).toUpperCase();
  let n = 0;
  for (const e of events || []) {
    const ts = typeof e === 'number' ? e : e.ts;
    if (!(ts > 0)) continue;
    store.recordEarning(sym, ts);
    n++;
  }
  return n;
}
// Any earnings dates with the announcement in (from, to] — used to avoid holding
// a backtest trade through earnings.
export function earningsBetween(symbol, from, to) {
  return store.earningsBetween(String(symbol).toUpperCase(), from, to);
}
// The next earnings date after `afterTs`. If none is known ahead, project forward
// from the latest known date in ~quarterly (91-day) steps — enough to steer live
// entries away from an upcoming report.
export function nextEarnings(symbol, afterTs) {
  const list = store.getEarnings(String(symbol).toUpperCase());
  if (!list.length) return null;
  const ahead = list.find((ts) => ts > afterTs);
  if (ahead) return ahead;
  let t = list[list.length - 1];
  const QUARTER = 91 * 86400;
  while (t <= afterTs) t += QUARTER;
  return t;
}

// Record splits as ALREADY reflected in our stored bars (no adjustment). Called
// after we fetch a full adjusted history (backfill), so a later reconcile won't
// double-adjust bars that already account for these splits.
export function seedSplits(symbol, events) {
  const sym = String(symbol).toUpperCase();
  for (const e of events || []) {
    if (!(e.ts > 0) || !(e.from > 0) || !(e.to > 0)) continue;
    store.recordSplit(sym, e.ts, e.from, e.to, true);
    store.markSplitApplied(sym, e.ts);
  }
}

// Apply any not-yet-applied splits to our stored bars so history stays adjusted:
// every bar before a split's date is back-adjusted (prices x from/to, volume x
// to/from). Returns the list of splits newly applied.
export function reconcileSplits(symbol, events) {
  const sym = String(symbol).toUpperCase();
  const applied = [];
  for (const e of events || []) {
    if (!(e.ts > 0) || !(e.from > 0) || !(e.to > 0)) continue;
    store.recordSplit(sym, e.ts, e.from, e.to, false);
    if (!store.splitApplied(sym, e.ts)) {
      store.adjustBars(sym, e.ts, e.from / e.to, e.to / e.from);
      store.markSplitApplied(sym, e.ts);
      applied.push(e);
    }
  }
  return applied;
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
  // Daily bars: tolerate multi-day gaps (weekends / holidays) before calling the
  // series stale — otherwise a Friday close looks "stale" all weekend and forces
  // a needless refetch.
  const maxStale = DAILY_INTERVALS.has(interval) ? 4 * 86400 : 3 * 3600;
  const startTol = intervalSeconds(interval) * 5;
  // "Deep enough" means we reach the requested start OR we already hold a long
  // history. The latter is essential for `max`/multi-year requests: a symbol can
  // never have data back to `from` (30 years ago), so once its FULL available
  // history is stored we must treat that as covered instead of refetching forever.
  const deepEnough = oldest <= from + startTol || bars.length >= 240;
  return deepEnough && newest >= to - maxStale;
}
function metaFromBars(symbol, bars) {
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  return { symbol, currency: 'USD', exchange: null, regularMarketPrice: last ? last.close : null, previousClose: prev ? prev.close : last ? last.open : null, regularMarketTime: last ? last.time : null };
}

const FETCH_LOG_FILE = join(DATA_DIR, 'marketdb-fetch.json');

export function withDatabase(upstream) {
  // Load the last-fetch log from disk so the cooldown survives across processes —
  // a fresh `npm run momentum` must NOT re-hammer the provider for series we just
  // pulled in a previous run.
  const persisted = loadJSON(FETCH_LOG_FILE, () => ({})) || {};
  const lastFetch = new Map(Object.entries(persisted).map(([k, v]) => [k, Number(v)]));
  const rememberFetch = (key) => {
    lastFetch.set(key, Date.now());
    const obj = {};
    for (const [k, v] of lastFetch) obj[k] = v;
    try {
      saveJSON(FETCH_LOG_FILE, obj);
    } catch {
      /* non-fatal: cooldown just won't persist */
    }
  };
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
      rememberFetch(key);
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
