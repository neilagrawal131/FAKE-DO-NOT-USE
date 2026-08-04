// Polygon.io market-data provider — same interface as server/yahoo.js
// (chart, quote, lastPrice, search, INTRADAY_MAX_DAYS) so it drops into the
// existing backend. Reads POLYGON_API_KEY from the environment (see .env).
//
// Endpoints used (Polygon Stocks API):
//   bars      GET /v2/aggs/ticker/{sym}/range/{mult}/{timespan}/{from}/{to}
//   snapshot  GET /v2/snapshot/locale/us/markets/stocks/tickers/{sym}
//   prevClose GET /v2/aggs/ticker/{sym}/prev
//   details   GET /v3/reference/tickers/{sym}
//   search    GET /v3/reference/tickers?search=
//
// Historical bars & fundamentals depend on your Polygon plan. Real-time vs
// 15-min-delayed quotes also depend on the plan (the data still maps the same).

const BASE = 'https://api.polygon.io';

// Deep intraday history is the whole point of using Polygon; the exact reach
// depends on the plan, so it's configurable.
export const INTRADAY_MAX_DAYS = Number(process.env.POLYGON_INTRADAY_MAX_DAYS) || 730;

function apiKey() {
  return process.env.POLYGON_API_KEY || '';
}

// ---- tiny TTL cache (keyed by path, never by the API key) ----
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

async function pget(path, ttlMs = 30_000, skipCache = false) {
  const key = apiKey();
  if (!key) throw new Error('POLYGON_API_KEY is not set');
  if (!skipCache) {
    const cached = cacheGet(path);
    if (cached) return cached;
  }

  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (res.status === 429) throw Object.assign(new Error('Polygon rate limit (429) — upgrade the plan or reduce request rate'), { status: 429 });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Polygon ${res.status} for ${path}: ${body.slice(0, 140)}`);
  }
  const data = await res.json();
  if (data.status === 'ERROR' || data.status === 'NOT_AUTHORIZED') {
    throw new Error(`Polygon: ${data.error || data.message || data.status}`);
  }
  if (!skipCache) cacheSet(path, data, ttlMs);
  return data;
}

// Fetch every bar for an explicit date range (YYYY-MM-DD), following Polygon's
// next_url pagination. Uncached — meant for bulk backfill, not the hot path.
export async function barsBetween(symbol, fromDate, toDate, { multiplier = 1, timespan = 'minute' } = {}) {
  const sym = symbol.toUpperCase();
  let url =
    `/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${multiplier}/${timespan}/` +
    `${fromDate}/${toDate}?adjusted=true&sort=asc&limit=50000`;
  const out = [];
  let guard = 0;
  while (url && guard++ < 200) {
    const data = await pget(url, 0, true);
    for (const r of data.results || []) {
      if (Number.isFinite(r.o) && Number.isFinite(r.c)) {
        out.push({ time: Math.floor(r.t / 1000), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v || 0 });
      }
    }
    // next_url is an absolute URL (Bearer auth carries the key in the header).
    url = data.next_url ? data.next_url.replace(BASE, '') : null;
  }
  return out;
}

// Stock splits for a symbol (corporate actions). Returns [{ ts, from, to }] where
// `ts` is the execution date (unix seconds) and a 2:1 split is { from: 1, to: 2 }.
export async function splits(symbol) {
  const sym = symbol.toUpperCase();
  const data = await pget(`/v3/reference/splits?ticker=${encodeURIComponent(sym)}&limit=1000&order=asc`, 24 * 60 * 60 * 1000).catch(() => ({ results: [] }));
  return (data.results || [])
    .map((r) => ({ ts: Math.floor(new Date(`${r.execution_date}T00:00:00Z`).getTime() / 1000), from: Number(r.split_from), to: Number(r.split_to) }))
    .filter((s) => s.ts > 0 && s.from > 0 && s.to > 0);
}

// Cash dividends for a symbol. Returns [{ ts, cash }] where `ts` is the
// ex-dividend date (unix seconds) and `cash` is the per-share cash amount.
export async function dividends(symbol) {
  const sym = symbol.toUpperCase();
  const data = await pget(`/v3/reference/dividends?ticker=${encodeURIComponent(sym)}&limit=1000&order=asc`, 24 * 60 * 60 * 1000).catch(() => ({ results: [] }));
  return (data.results || [])
    .map((r) => ({ ts: Math.floor(new Date(`${r.ex_dividend_date}T00:00:00Z`).getTime() / 1000), cash: Number(r.cash_amount) }))
    .filter((d) => d.ts > 0 && d.cash > 0);
}

// ---- spread modelling (same logic as yahoo.js, kept local for independence) ----
function normalizeSpread(price, bid, ask) {
  const b = Number.isFinite(bid) && bid > 0 ? bid : null;
  const a = Number.isFinite(ask) && ask > 0 ? ask : null;
  if (b != null && a != null && a >= b) return { bid: b, ask: a, estimated: false };
  if (!Number.isFinite(price) || price <= 0) return { bid: null, ask: null, estimated: true };
  const half = Math.max(0.01, price * 0.0005);
  return { bid: Math.max(0.01, +(price - half).toFixed(2)), ask: +(price + half).toFixed(2), estimated: true };
}

// ---- exchange mapping (Polygon MIC codes -> friendly, NYSE/NASDAQ families) ----
const EXCHANGES = {
  XNYS: 'NYSE',
  XNAS: 'NASDAQ',
  ARCX: 'NYSE Arca',
  XASE: 'NYSE American',
  BATS: 'Cboe BZX',
};
function exchangeName(mic) {
  return EXCHANGES[mic] || null;
}
function isSupportedExchange(mic) {
  return Boolean(EXCHANGES[mic]);
}

// ---- interval / range mapping ----
const INTERVALS = {
  '1m': [1, 'minute'],
  '2m': [2, 'minute'],
  '5m': [5, 'minute'],
  '10m': [10, 'minute'],
  '15m': [15, 'minute'],
  '30m': [30, 'minute'],
  '60m': [1, 'hour'],
  '1h': [1, 'hour'],
  '90m': [90, 'minute'],
  '1d': [1, 'day'],
  '1wk': [1, 'week'],
  '1mo': [1, 'month'],
};
// Days of history to request per range keyword (with buffer for weekends/warmup).
const RANGE_DAYS = {
  '1d': 4,
  '5d': 8,
  '1mo': 33,
  '3mo': 95,
  '6mo': 190,
  '1y': 370,
  '2y': 735,
  '5y': 1830,
  max: 30 * 365,
};
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// ---- public API ----

// OHLCV bars. Returns { meta, bars: [{ time, open, high, low, close, volume }] }.
export async function chart(symbol, range = '1mo', interval = '1d') {
  const sym = symbol.toUpperCase();
  const [mult, timespan] = INTERVALS[interval] || [1, 'day'];
  const days = RANGE_DAYS[range] ?? 33;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400 * 1000);
  const intraday = timespan === 'minute' || timespan === 'hour';

  const path =
    `/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${mult}/${timespan}/` +
    `${fmtDate(from)}/${fmtDate(to)}?adjusted=true&sort=asc&limit=50000`;
  const data = await pget(path, intraday ? 30_000 : 5 * 60_000);

  const bars = (data.results || [])
    .map((r) => ({ time: Math.floor(r.t / 1000), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v || 0 }))
    .filter((b) => Number.isFinite(b.open) && Number.isFinite(b.close));
  if (!bars.length) throw Object.assign(new Error(`No Polygon bars for ${sym}`), { status: 404 });

  const last = bars[bars.length - 1];
  return {
    meta: {
      symbol: sym,
      currency: 'USD',
      exchange: null,
      regularMarketPrice: last.close,
      previousClose: bars.length > 1 ? bars[bars.length - 2].close : last.open,
      regularMarketTime: last.time,
    },
    bars,
  };
}

// The single-ticker snapshot (real-time price + NBBO) is a higher-tier feature.
// If the plan doesn't allow it we stop calling it so we don't waste the rate limit.
let snapshotOff = false;
async function snapshot(sym) {
  if (snapshotOff) return null;
  try {
    const data = await pget(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}`, 15_000);
    return data.ticker || null;
  } catch (err) {
    if (/\b(401|403)\b|NOT_AUTHORIZED|not authorized/i.test(err.message)) snapshotOff = true;
    return null;
  }
}

// Daily bars via aggregates (available on every plan that serves history).
async function dailyBars(sym, calendarDays) {
  const to = new Date();
  const from = new Date(to.getTime() - calendarDays * 86400 * 1000);
  const data = await pget(
    `/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${fmtDate(from)}/${fmtDate(to)}?adjusted=true&sort=asc&limit=50000`,
    5 * 60_000
  );
  return (data.results || []).filter((r) => Number.isFinite(r.c));
}
async function details(sym) {
  try {
    const data = await pget(`/v3/reference/tickers/${encodeURIComponent(sym)}`, 60 * 60_000);
    return data.results || null;
  } catch {
    return null; // details are optional; don't fail the quote over them
  }
}

// Rich quote. Core fields (price, OHLCV, ranges, moving averages) come from daily
// aggregates so they work on any plan; ticker details add name/market cap/etc;
// the snapshot adds real-time price + NBBO bid/ask when the plan includes it.
export async function quote(symbol) {
  const sym = symbol.toUpperCase();
  const [t, d, daily] = await Promise.all([
    snapshot(sym), // best-effort; returns null if the plan gates it
    details(sym),
    dailyBars(sym, 400).catch(() => []),
  ]);

  const lastBar = daily.length ? daily[daily.length - 1] : null;
  const prevBar = daily.length > 1 ? daily[daily.length - 2] : null;
  const closes = daily.map((b) => b.c);
  const sma = (n) => (closes.length ? closes.slice(-n).reduce((a, b) => a + b, 0) / Math.min(n, closes.length) : null);

  // Real-time price/quote if snapshot is available, else the latest daily bar.
  const rtPrice = t?.lastTrade?.p ?? t?.day?.c ?? null;
  const price = rtPrice ?? (lastBar ? lastBar.c : null);
  const bid = t?.lastQuote?.p ?? null; // Polygon lastQuote: p=bid, P=ask, s=bidSize, S=askSize
  const ask = t?.lastQuote?.P ?? null;
  const sp = normalizeSpread(price, bid, ask);

  const previousClose = t?.prevDay?.c ?? (prevBar ? prevBar.c : lastBar ? lastBar.o : null);
  const change = price != null && previousClose != null ? price - previousClose : null;
  const changePercent = change != null && previousClose ? (change / previousClose) * 100 : null;

  const window52 = closes.slice(-252);
  const fiftyTwoWeekHigh = window52.length ? Math.max(...window52, lastBar ? lastBar.h : -Infinity) : null;
  const fiftyTwoWeekLow = window52.length ? Math.min(...window52, lastBar ? lastBar.l : Infinity) : null;
  const vols = daily.map((b) => b.v).filter((v) => Number.isFinite(v));
  const avgVolume = vols.length ? Math.round(vols.slice(-63).reduce((a, b) => a + b, 0) / Math.min(63, vols.length)) : null;

  const shares = d?.weighted_shares_outstanding ?? d?.share_class_shares_outstanding ?? null;
  const marketCap = d?.market_cap ?? (shares && price ? shares * price : null);

  return {
    symbol: sym,
    name: d?.name || sym,
    exchange: d ? exchangeName(d.primary_exchange) : null,
    currency: (d?.currency_name || 'USD').toUpperCase(),
    price,
    bid: sp.bid,
    ask: sp.ask,
    bidSize: t?.lastQuote?.s != null ? t.lastQuote.s * 100 : null,
    askSize: t?.lastQuote?.S != null ? t.lastQuote.S * 100 : null,
    spread: sp.bid != null && sp.ask != null ? +(sp.ask - sp.bid).toFixed(4) : null,
    spreadEstimated: sp.estimated,
    previousClose,
    change,
    changePercent,
    dayHigh: t?.day?.h ?? (lastBar ? lastBar.h : null),
    dayLow: t?.day?.l ?? (lastBar ? lastBar.l : null),
    open: t?.day?.o ?? (lastBar ? lastBar.o : null),
    volume: t?.day?.v ?? (lastBar ? lastBar.v : null),
    avgVolume,
    marketCap,
    peRatio: null, // needs the financials endpoint (higher tier) — left blank honestly
    forwardPE: null,
    eps: null,
    beta: null,
    dividendYield: null,
    fiftyTwoWeekHigh,
    fiftyTwoWeekLow,
    fiftyDayAverage: sma(50),
    twoHundredDayAverage: sma(200),
    sharesOutstanding: shares,
    sector: d?.sic_description || null,
    industry: d?.sic_description || null,
    website: d?.homepage_url || null,
    employees: d?.total_employees || null,
    description: d?.description || null,
    targetMeanPrice: null,
    recommendation: null,
  };
}

// Last price + bid/ask for portfolio marking and spread-aware fills. Real-time
// from snapshot when the plan allows, else the latest daily close.
export async function lastPrice(symbol) {
  const sym = symbol.toUpperCase();
  let price = null;
  let prev = null;
  let bid = null;
  let ask = null;

  const t = await snapshot(sym);
  if (t) {
    price = t.lastTrade?.p ?? t.day?.c ?? t.min?.c ?? null;
    prev = t.prevDay?.c ?? null;
    bid = t.lastQuote?.p ?? null;
    ask = t.lastQuote?.P ?? null;
  }
  if (price == null) {
    const bars = await dailyBars(sym, 12).catch(() => []);
    if (bars.length) {
      price = bars[bars.length - 1].c;
      prev = prev ?? (bars.length > 1 ? bars[bars.length - 2].c : price);
    }
  }
  const sp = normalizeSpread(price, bid, ask);
  return { symbol: sym, price, previousClose: prev, bid: sp.bid, ask: sp.ask, spreadEstimated: sp.estimated };
}

// Symbol search, filtered to NYSE/NASDAQ equities.
export async function search(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const data = await pget(
    `/v3/reference/tickers?search=${encodeURIComponent(q)}&market=stocks&active=true&limit=15`,
    5 * 60_000
  ).catch(() => ({ results: [] }));
  return (data.results || [])
    .filter((r) => isSupportedExchange(r.primary_exchange) && (!r.type || ['CS', 'ADRC'].includes(r.type)))
    .map((r) => ({
      symbol: r.ticker,
      name: r.name || r.ticker,
      exchange: exchangeName(r.primary_exchange),
      type: 'EQUITY',
    }));
}
