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

async function pget(path, ttlMs = 30_000) {
  const key = apiKey();
  if (!key) throw new Error('POLYGON_API_KEY is not set');
  const cached = cacheGet(path);
  if (cached) return cached;

  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (res.status === 429) throw new Error('Polygon rate limit (429) — upgrade the plan or reduce request rate');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Polygon ${res.status} for ${path}: ${body.slice(0, 140)}`);
  }
  const data = await res.json();
  if (data.status === 'ERROR' || data.status === 'NOT_AUTHORIZED') {
    throw new Error(`Polygon: ${data.error || data.message || data.status}`);
  }
  cacheSet(path, data, ttlMs);
  return data;
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

async function snapshot(sym) {
  const data = await pget(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}`, 15_000);
  return data.ticker || null;
}
async function details(sym) {
  try {
    const data = await pget(`/v3/reference/tickers/${encodeURIComponent(sym)}`, 60 * 60_000);
    return data.results || null;
  } catch {
    return null; // details are optional; don't fail the quote over them
  }
}

// Rich quote + fundamentals (snapshot + ticker details).
export async function quote(symbol) {
  const sym = symbol.toUpperCase();
  const [t, d] = await Promise.all([snapshot(sym).catch(() => null), details(sym)]);

  const price = t?.lastTrade?.p ?? t?.day?.c ?? t?.prevDay?.c ?? null;
  // Polygon lastQuote: p = bid price, P = ask price, s = bid size, S = ask size.
  const sp = normalizeSpread(price, t?.lastQuote?.p, t?.lastQuote?.P);
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
    previousClose: t?.prevDay?.c ?? null,
    change: t?.todaysChange ?? null,
    changePercent: t?.todaysChangePerc ?? null,
    dayHigh: t?.day?.h ?? null,
    dayLow: t?.day?.l ?? null,
    open: t?.day?.o ?? null,
    volume: t?.day?.v ?? null,
    avgVolume: null,
    marketCap,
    peRatio: null,
    forwardPE: null,
    eps: null,
    beta: null,
    dividendYield: null,
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    fiftyDayAverage: null,
    twoHundredDayAverage: null,
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

// Last price + live bid/ask for portfolio marking and spread-aware fills.
export async function lastPrice(symbol) {
  const sym = symbol.toUpperCase();
  let price = null;
  let prev = null;
  let bid = null;
  let ask = null;

  try {
    const t = await snapshot(sym);
    if (t) {
      price = t.lastTrade?.p ?? t.day?.c ?? t.min?.c ?? null;
      prev = t.prevDay?.c ?? null;
      bid = t.lastQuote?.p ?? null;
      ask = t.lastQuote?.P ?? null;
    }
  } catch {
    /* fall through to prev-close */
  }
  if (price == null) {
    const pc = await pget(`/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true`, 15_000).catch(() => null);
    const r = pc?.results?.[0];
    if (r) {
      price = r.c;
      prev = prev ?? r.c;
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
