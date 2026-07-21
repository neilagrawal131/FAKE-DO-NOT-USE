// Thin, dependency-free client for Yahoo Finance's public endpoints.
//
// Why Yahoo: it exposes real, delayed (~15 min) NYSE/NASDAQ market data with no
// API key required, which makes the simulator runnable out of the box. Some
// endpoints (quote, fundamentals) require a cookie + "crumb" handshake; the
// chart endpoint does not. We cache aggressively and degrade gracefully so the
// core trading loop keeps working even if fundamentals are temporarily blocked.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const BASE = 'https://query1.finance.yahoo.com';
const BASE2 = 'https://query2.finance.yahoo.com';

// ---- tiny in-memory TTL cache -------------------------------------------------
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

// ---- cookie + crumb handshake -------------------------------------------------
let creds = { cookie: null, crumb: null, ts: 0 };
const CREDS_TTL = 30 * 60 * 1000; // refresh every 30 min

async function ensureCredentials(force = false) {
  if (!force && creds.crumb && Date.now() - creds.ts < CREDS_TTL) return creds;

  try {
    // fc.yahoo.com returns 404 but still sets the session cookies we need.
    let cookie = null;
    for (const url of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, Accept: 'text/html' },
          redirect: 'follow',
        });
        const setCookies =
          typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        if (setCookies.length) {
          cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
          break;
        }
      } catch {
        /* try next */
      }
    }

    let crumb = null;
    for (const base of [BASE2, BASE]) {
      try {
        const res = await fetch(`${base}/v1/test/getcrumb`, {
          headers: {
            'User-Agent': UA,
            Accept: 'text/plain',
            ...(cookie ? { Cookie: cookie } : {}),
          },
        });
        const txt = (await res.text()).trim();
        if (txt && !txt.includes('<') && txt.length < 40) {
          crumb = txt;
          break;
        }
      } catch {
        /* try next */
      }
    }

    creds = { cookie, crumb, ts: Date.now() };
  } catch {
    creds = { cookie: null, crumb: null, ts: Date.now() };
  }
  return creds;
}

async function yfetch(url, { auth = false } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (auth) {
    const c = await ensureCredentials();
    if (c.cookie) headers.Cookie = c.cookie;
  }
  const res = await fetch(url, { headers });
  if (res.status === 401 && auth) {
    // crumb likely stale — refresh once and retry
    await ensureCredentials(true);
    return yfetch(url, { auth: false });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Yahoo ${res.status} for ${url}: ${body.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---- exchange whitelist (NYSE + NASDAQ families only) -------------------------
// Yahoo exchange codes -> friendly names. We only surface US primary listings.
const EXCHANGES = {
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  NAS: 'NASDAQ',
  NYQ: 'NYSE',
  NYS: 'NYSE',
  ASE: 'NYSE American',
  PCX: 'NYSE Arca',
  ARCA: 'NYSE Arca',
};

export function exchangeName(code) {
  return EXCHANGES[code] || null;
}
export function isSupportedExchange(code) {
  return Boolean(EXCHANGES[code]);
}

// ---- public API ---------------------------------------------------------------

// Symbol search, filtered to NYSE/NASDAQ equities.
export async function search(query) {
  const q = (query || '').trim();
  if (!q) return [];
  const key = `search:${q.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${BASE2}/v1/finance/search?q=${encodeURIComponent(
    q
  )}&quotesCount=15&newsCount=0&enableFuzzyQuery=false`;
  const data = await yfetch(url);
  const results = (data.quotes || [])
    .filter((r) => r.quoteType === 'EQUITY' && isSupportedExchange(r.exchange))
    .map((r) => ({
      symbol: r.symbol,
      name: r.shortname || r.longname || r.symbol,
      exchange: exchangeName(r.exchange),
      type: r.quoteType,
    }));
  cacheSet(key, results, 5 * 60 * 1000);
  return results;
}

// Historical / intraday OHLCV bars from the chart endpoint (no auth needed).
// Returns { meta, bars: [{ time, open, high, low, close, volume }] }.
export async function chart(symbol, range = '1mo', interval = '1d') {
  const sym = symbol.toUpperCase();
  const key = `chart:${sym}:${range}:${interval}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${BASE}/v8/finance/chart/${encodeURIComponent(
    sym
  )}?range=${range}&interval=${interval}&includePrePost=false`;
  const data = await yfetch(url);

  const result = data.chart?.result?.[0];
  if (!result) throw Object.assign(new Error(`No chart data for ${sym}`), { status: 404 });

  const meta = result.meta || {};
  if (!isSupportedExchange(meta.exchangeName) && meta.exchangeName) {
    // Yahoo sometimes reports full names here; only hard-block clearly foreign ones.
  }

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    bars.push({
      time: ts[i],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v ?? 0,
    });
  }

  const out = {
    meta: {
      symbol: sym,
      currency: meta.currency,
      exchange: exchangeName(meta.exchangeCode) || meta.fullExchangeName || meta.exchangeName,
      timezone: meta.timezone,
      regularMarketPrice: meta.regularMarketPrice,
      previousClose: meta.chartPreviousClose ?? meta.previousClose,
      regularMarketTime: meta.regularMarketTime,
      gmtoffset: meta.gmtoffset,
    },
    bars,
  };
  // Short TTL for intraday, longer for daily+.
  cacheSet(key, out, interval.includes('m') ? 30 * 1000 : 5 * 60 * 1000);
  return out;
}

// Rich quote + fundamentals via quoteSummary (needs cookie+crumb). Falls back to
// chart-derived basics if the authed endpoint is unavailable.
export async function quote(symbol) {
  const sym = symbol.toUpperCase();
  const key = `quote:${sym}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let summary = null;
  try {
    const c = await ensureCredentials();
    const modules = [
      'price',
      'summaryDetail',
      'defaultKeyStatistics',
      'assetProfile',
      'financialData',
    ].join(',');
    const crumbParam = c.crumb ? `&crumb=${encodeURIComponent(c.crumb)}` : '';
    const url = `${BASE}/v10/finance/quoteSummary/${encodeURIComponent(
      sym
    )}?modules=${modules}${crumbParam}`;
    const data = await yfetch(url, { auth: true });
    summary = data.quoteSummary?.result?.[0] || null;
  } catch {
    summary = null;
  }

  // Always have a price fallback from the chart meta.
  let base;
  try {
    const ch = await chart(sym, '5d', '1d');
    base = ch.meta;
  } catch {
    base = { symbol: sym };
  }

  const price = summary?.price || {};
  const detail = summary?.summaryDetail || {};
  const stats = summary?.defaultKeyStatistics || {};
  const profile = summary?.assetProfile || {};
  const fin = summary?.financialData || {};

  const val = (x) => (x && typeof x === 'object' ? (x.raw ?? null) : (x ?? null));

  const out = {
    symbol: sym,
    name: val(price.longName) || val(price.shortName) || sym,
    exchange: exchangeName(price.exchangeName) || base.exchange || null,
    currency: val(price.currency) || base.currency || 'USD',
    price: val(price.regularMarketPrice) ?? base.regularMarketPrice ?? null,
    previousClose:
      val(price.regularMarketPreviousClose) ?? base.previousClose ?? null,
    change: val(price.regularMarketChange),
    changePercent: val(price.regularMarketChangePercent),
    dayHigh: val(price.regularMarketDayHigh) ?? val(detail.dayHigh),
    dayLow: val(price.regularMarketDayLow) ?? val(detail.dayLow),
    open: val(price.regularMarketOpen) ?? val(detail.open),
    volume: val(price.regularMarketVolume) ?? val(detail.volume),
    avgVolume: val(detail.averageVolume) ?? val(detail.averageDailyVolume10Day),
    marketCap: val(price.marketCap) ?? val(detail.marketCap),
    peRatio: val(detail.trailingPE) ?? val(stats.trailingPE),
    forwardPE: val(detail.forwardPE),
    eps: val(stats.trailingEps),
    beta: val(detail.beta) ?? val(stats.beta),
    dividendYield: val(detail.dividendYield),
    fiftyTwoWeekHigh: val(detail.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: val(detail.fiftyTwoWeekLow),
    fiftyDayAverage: val(detail.fiftyDayAverage),
    twoHundredDayAverage: val(detail.twoHundredDayAverage),
    sharesOutstanding: val(stats.sharesOutstanding),
    sector: profile.sector || null,
    industry: profile.industry || null,
    website: profile.website || null,
    employees: profile.fullTimeEmployees || null,
    description: profile.longBusinessSummary || null,
    targetMeanPrice: val(fin.targetMeanPrice),
    recommendation: fin.recommendationKey || null,
  };

  cacheSet(key, out, 60 * 1000);
  return out;
}

// Lightweight, batchable last-price lookup for portfolio marking.
export async function lastPrice(symbol) {
  const ch = await chart(symbol, '1d', '1m');
  const last = ch.bars.length ? ch.bars[ch.bars.length - 1].close : null;
  return {
    symbol: symbol.toUpperCase(),
    price: ch.meta.regularMarketPrice ?? last,
    previousClose: ch.meta.previousClose ?? null,
  };
}
