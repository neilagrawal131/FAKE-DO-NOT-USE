import './loadenv.js'; // must be first — populates process.env from .env
import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yahooProvider from './yahoo.js';
import * as mockProvider from './mock.js';
import * as polygonProvider from '../market_data/polygon.js';
import * as portfolio from './portfolio.js';
import { aggregateBars } from './aggregate.js';
import { parseScenario, normalizeScenario, setIntradayMaxDays } from './scenario.js';
import { runBacktest, fetchRange, intradayRange } from './backtest.js';
import { walkForward } from './walkforward.js';
import { runMomentum } from './momentum.js';
import { sectorList } from './universe.js';
import * as aitrader from './aitrader.js';
import * as strategist from './strategist.js';
import { withDatabase, dbStats, dbBackend, getSplits, getDividends, getEarnings } from './marketdb.js';
import * as scheduler from './scheduler.js';
import { scoreImportance, importanceRank, mockNews } from './news.js';
import { getBroker } from './broker/index.js';

// Choose the market-data source:
//   - polygon  (default when POLYGON_API_KEY is set) — real quotes + deep history
//   - yahoo    (default otherwise) — free, no key, ~15-min delayed
//   - mock     — offline synthetic demo
const HAS_POLYGON = Boolean(process.env.POLYGON_API_KEY);
const SOURCE = (process.env.DATA_SOURCE || (HAS_POLYGON ? 'polygon' : 'yahoo')).toLowerCase();

// If a Polygon call fails (rate limit, plan limit, network), transparently fall
// back to Yahoo for that call so the frontend never breaks. A circuit breaker
// stops hammering Polygon after a rate-limit (429): the first 429 opens the
// circuit for a cooldown, during which every call goes straight to Yahoo (no more
// per-request 429 spam and no wasted latency). After the cooldown it retries
// Polygon; if it's still limited the circuit re-opens.
const POLYGON_COOLDOWN_MS = Number(process.env.POLYGON_COOLDOWN_MS) || 60_000;
function withFallback(primary, backup) {
  let coolUntil = 0;
  const wrap = (name) => async (...args) => {
    if (Date.now() < coolUntil) return backup[name](...args); // circuit open → Yahoo
    try {
      return await primary[name](...args);
    } catch (err) {
      const rateLimited = /rate limit|\b429\b/i.test(err.message || '');
      if (rateLimited) {
        if (Date.now() >= coolUntil) {
          console.warn(`[polygon] rate limited — pausing Polygon for ${POLYGON_COOLDOWN_MS / 1000}s, serving from Yahoo`);
        }
        coolUntil = Date.now() + POLYGON_COOLDOWN_MS;
      } else {
        console.warn(`[polygon] ${name} failed (${err.message}); using Yahoo`);
      }
      return backup[name](...args);
    }
  };
  return {
    chart: wrap('chart'),
    quote: wrap('quote'),
    lastPrice: wrap('lastPrice'),
    search: wrap('search'),
    INTRADAY_MAX_DAYS: primary.INTRADAY_MAX_DAYS ?? backup.INTRADAY_MAX_DAYS,
  };
}

// Global rate cap: pull any given piece of market data from the upstream
// provider at most once every MARKET_CACHE_MS (default 10s). This bounds how hard
// the whole platform (the autonomous Strategist's continuous backtests, portfolio
// marking, the UI) hits Polygon — no matter how often those callers ask, each
// distinct request is served from this cache for the window. In-flight requests
// are shared so bursts collapse to one call; errors are not cached.
const MARKET_CACHE_MS = Number(process.env.MARKET_CACHE_MS) || 10_000;
// Daily/weekly/monthly bars only change once per trading day, so cache them far
// longer than live quotes — this is the single biggest cut to provider load
// (the Strategist backtests hundreds of symbols on daily bars).
const DAILY_CACHE_MS = Number(process.env.DAILY_CACHE_MS) || 30 * 60_000;
const DAILY_INTERVALS = new Set(['1d', '1wk', '1mo']);
function cachedProvider(p, ttlMs) {
  const store = new Map(); // key -> { promise, expires }
  const ttlFor = (name, args) => (name === 'chart' && DAILY_INTERVALS.has(String(args[2])) ? DAILY_CACHE_MS : ttlMs);
  const memo = (name) => (...args) => {
    const key = `${name}|${args.join('|')}`;
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expires > now) return hit.promise;
    const promise = Promise.resolve().then(() => p[name](...args));
    store.set(key, { promise, expires: now + ttlFor(name, args) });
    promise.catch(() => {
      const h = store.get(key);
      if (h && h.promise === promise) store.delete(key); // don't cache failures
    });
    return promise;
  };
  return {
    chart: memo('chart'),
    quote: memo('quote'),
    lastPrice: memo('lastPrice'),
    search: memo('search'),
    INTRADAY_MAX_DAYS: p.INTRADAY_MAX_DAYS,
  };
}

let yahoo; // the active provider (name kept for minimal churn)
let upstreamProvider = null; // raw upstream (before DB/cache) — used by the nightly top-up
if (SOURCE === 'mock') {
  yahoo = mockProvider;
} else {
  upstreamProvider = SOURCE === 'polygon' ? withFallback(polygonProvider, yahooProvider) : yahooProvider;
  // Chain: upstream API -> our database (persist every bar) -> 10s in-memory cache.
  // Backtests read from the database; the upstream is hit only to fill gaps.
  yahoo = cachedProvider(withDatabase(upstreamProvider), MARKET_CACHE_MS);
}

// Tell the parser how far back intraday analysis can go for this data source.
setIntradayMaxDays(yahoo.INTRADAY_MAX_DAYS ?? 30);

// Broker abstraction (Phase 0 scaffold — see docs/GOING_LIVE.md). Defaults to the
// paper ledger; BROKER=ibkr selects the (stubbed) Interactive Brokers venue. Live
// execution still routes through portfolio.js for now; this exposes the broker
// contract read-only so it can be built out and observed without disruption.
const broker = getBroker({ priceProvider: yahoo });

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const PORT = process.env.PORT || 3000;

console.log(
  `[data] source = ${
    SOURCE === 'mock'
      ? 'mock (synthetic)'
      : SOURCE === 'polygon'
        ? 'polygon (real quotes + deep history, Yahoo fallback)'
        : 'yahoo (free, ~15-min delayed)'
  }`
);

app.use(express.json());

// --- tiny async wrapper so route errors flow to the handler below -------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Each timeframe key = the span ONE candle represents. `interval`/`range` are
// what we fetch upstream; `agg` (optional) resamples finer native bars into the
// requested bucket when the feed has no native interval for it.
const TIMEFRAMES = {
  '1m': { interval: '1m', range: '1d' },
  '5m': { interval: '5m', range: '5d' },
  '10m': { interval: '5m', range: '1mo', agg: { seconds: 600 } },
  '30m': { interval: '30m', range: '1mo' },
  '1h': { interval: '60m', range: '3mo' },
  '3h': { interval: '60m', range: '6mo', agg: { seconds: 3 * 3600 } },
  '1D': { interval: '1d', range: '2y' },
  '1W': { interval: '1wk', range: '5y' },
  '1Mo': { interval: '1mo', range: 'max' },
  '6Mo': { interval: '1mo', range: 'max', agg: { calendar: 'halfyear' } },
  '1Y': { interval: '1mo', range: 'max', agg: { calendar: 'year' } },
  '5Y': { interval: '1mo', range: 'max', agg: { calendar: 'fiveyear' } },
};

// --- market data --------------------------------------------------------------
app.get(
  '/api/search',
  wrap(async (req, res) => {
    res.json(await yahoo.search(req.query.q || ''));
  })
);

app.get(
  '/api/quote/:symbol',
  wrap(async (req, res) => {
    res.json(await yahoo.quote(req.params.symbol));
  })
);

app.get(
  '/api/chart/:symbol',
  wrap(async (req, res) => {
    const key = req.query.tf || '1D';
    const tf = TIMEFRAMES[key];
    if (!tf) return res.status(400).json({ error: `Unknown timeframe "${key}"` });
    const data = await yahoo.chart(req.params.symbol, tf.range, tf.interval);
    const bars = tf.agg ? aggregateBars(data.bars, tf.agg) : data.bars;
    res.json({ meta: data.meta, bars, timeframe: key });
  })
);

// --- portfolio / paper trading ------------------------------------------------
async function priceMap(symbols) {
  const out = {};
  const results = await Promise.allSettled(symbols.map((s) => yahoo.lastPrice(s)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[symbols[i].toUpperCase()] = r.value;
  });
  return out;
}

app.get(
  '/api/portfolio',
  wrap(async (req, res) => {
    // Read-only snapshot: the AI Trader engine runs on its own background timer
    // (see startEngine below), so this just marks held positions to cached prices
    // and returns instantly instead of re-running the whole engine per request.
    const symbols = portfolio.heldSymbols();
    const marks = symbols.length ? await priceMap(symbols) : {};
    res.json(portfolio.summarize(marks));
  })
);

app.post(
  '/api/trade',
  wrap(async (req, res) => {
    const { side, symbol, shares } = req.body || {};
    if (!symbol || !side || !shares) {
      return res.status(400).json({ error: 'side, symbol and shares are required' });
    }
    // Fetch the live quote and fill in line with the spread: a market BUY pays
    // the ASK, a market SELL receives the BID — never a client-supplied price.
    const q = await yahoo.lastPrice(symbol);
    const fillPrice = side === 'buy' ? q.ask : q.bid;
    if (!fillPrice) {
      return res
        .status(502)
        .json({ error: 'No live bid/ask available to fill this order right now' });
    }
    const order = portfolio.trade({
      side,
      symbol,
      shares,
      price: fillPrice,
      bid: q.bid,
      ask: q.ask,
      spreadEstimated: q.spreadEstimated,
      ts: Math.floor(Date.now() / 1000),
    });
    const marks = await priceMap(portfolio.heldSymbols());
    res.json({ order, portfolio: portfolio.summarize(marks) });
  })
);

app.post(
  '/api/portfolio/reset',
  wrap(async (req, res) => {
    portfolio.reset();
    res.json(portfolio.summarize({}));
  })
);

// --- AI Analyst / scenario backtesting -----------------------------------------
app.get('/api/sectors', (req, res) => res.json(sectorList()));

app.post(
  '/api/analyze',
  wrap(async (req, res) => {
    const { query, scenario: override } = req.body || {};
    let scenario;
    let warnings = [];
    if (override && Array.isArray(override.conditions)) {
      scenario = normalizeScenario(override);
    } else {
      const parsed = parseScenario(query || '');
      scenario = parsed.scenario;
      warnings = parsed.warnings;
    }
    const result = await runBacktest(scenario, yahoo);
    res.json({ ...result, warnings });
  })
);

// Walk-forward / out-of-sample validation with realistic costs. Same scenario
// parsing as /api/analyze; returns raw in-sample vs out-of-sample return arrays
// (client computes the quant panel on both with the shared stats module).
app.post(
  '/api/walkforward',
  wrap(async (req, res) => {
    const { query, scenario: override, config } = req.body || {};
    let scenario;
    if (override && Array.isArray(override.conditions)) {
      scenario = normalizeScenario(override);
    } else {
      scenario = parseScenario(query || '').scenario;
    }
    const result = await walkForward(scenario, yahoo, config || {});
    res.json({ ...result, scenario });
  })
);

// Cross-sectional momentum: in-sample backtest + out-of-sample walk-forward.
app.post(
  '/api/momentum',
  wrap(async (req, res) => {
    const result = await runMomentum(yahoo, (req.body && req.body.config) || {});
    res.json(result);
  })
);

// A daily-bar window around a single occurrence, for the drill-down chart.
app.get(
  '/api/occurrence',
  wrap(async (req, res) => {
    const symbol = String(req.query.symbol || '').toUpperCase();
    const time = Number(req.query.time);
    const horizon = Math.max(1, Number(req.query.horizon) || 10);
    const maPeriod = Number(req.query.maPeriod) || 0;
    const lookbackDays = Number(req.query.lookbackDays) || 180;
    const intraday = req.query.timeframe === 'intraday';
    if (!symbol || !Number.isFinite(time)) {
      return res.status(400).json({ error: 'symbol and time are required' });
    }
    // Fetch the SAME series the backtest used so timestamps line up.
    const data = intraday
      ? await yahoo.chart(symbol, intradayRange(lookbackDays), '30m')
      : await yahoo.chart(symbol, fetchRange(lookbackDays), '1d');
    const bars = data.bars || [];
    if (!bars.length) return res.status(404).json({ error: 'No data for symbol' });

    // Locate the entry bar (exact, else nearest by time).
    let idx = bars.findIndex((b) => b.time === time);
    if (idx === -1) {
      let bestDiff = Infinity;
      bars.forEach((b, i) => {
        const d = Math.abs(b.time - time);
        if (d < bestDiff) {
          bestDiff = d;
          idx = i;
        }
      });
    }
    const leftPad = Math.max(60, maPeriod ? maPeriod + 5 : 0);
    const rightPad = horizon + 15;
    const from = Math.max(0, idx - leftPad);
    const to = Math.min(bars.length, idx + rightPad + 1);
    const window = bars.slice(from, to);
    const exitIdx = idx + horizon;

    res.json({
      symbol,
      bars: window,
      entryTime: bars[idx].time,
      entryPrice: bars[idx].close,
      exitTime: exitIdx < bars.length ? bars[exitIdx].time : null,
      exitPrice: exitIdx < bars.length ? bars[exitIdx].close : null,
      horizon,
    });
  })
);

// --- AI Trader (algorithmic paper trader, on the shared account) ---------------
// Read-only snapshot of the shared account + AI-specific view. The engine itself
// runs on the background timer (startEngine), so this never blocks the request on
// a full scan. `act` triggers one background (non-blocking) engine run after a
// user action so new trades show up on the next poll.
async function aitraderState({ act = false } = {}) {
  if (act) aitrader.evaluate(yahoo).catch((e) => console.warn('[aitrader] evaluate:', e.message));
  const marks = await priceMap(portfolio.heldSymbols());
  return { account: portfolio.summarize(marks), ...(await aitrader.view(yahoo)) };
}

app.get(
  '/api/aitrader',
  wrap(async (req, res) => {
    res.json(await aitraderState());
  })
);

app.post(
  '/api/aitrader/strategies',
  wrap(async (req, res) => {
    const { scenario, name } = req.body || {};
    if (!scenario || !Array.isArray(scenario.conditions) || scenario.conditions.length === 0) {
      return res.status(400).json({ error: 'A pattern needs at least one trigger condition.' });
    }
    aitrader.addStrategy(normalizeScenario(scenario), name);
    res.json(await aitraderState({ act: true }));
  })
);

app.post(
  '/api/aitrader/strategies/:id/toggle',
  wrap(async (req, res) => {
    aitrader.setEnabled(req.params.id, Boolean(req.body && req.body.enabled));
    res.json(await aitraderState({ act: true }));
  })
);

app.delete(
  '/api/aitrader/strategies/:id',
  wrap(async (req, res) => {
    await aitrader.removeStrategy(req.params.id, yahoo, { purge: true });
    res.json(await aitraderState());
  })
);

app.post(
  '/api/aitrader/reset',
  wrap(async (req, res) => {
    await aitrader.reset(yahoo);
    res.json(await aitraderState());
  })
);

// --- AI Strategist (fully autonomous: discovers, promotes, trades) -------------
// The engine runs on its own timer (see strategist.start below). These endpoints
// are read-only status + an optional pause/resume and "run a generation now".
app.get('/api/strategist', (req, res) => res.json(strategist.getState()));

app.post(
  '/api/strategist/toggle',
  (req, res) => {
    const enabled = strategist.setEnabled(Boolean(req.body && req.body.enabled));
    res.json({ enabled, ...strategist.getState() });
  }
);

app.post(
  '/api/strategist/run',
  wrap(async (req, res) => {
    res.json(await strategist.forceCycle());
  })
);

// Market news for the Trade-page gallery, importance-ranked. Cached briefly so
// the gallery keeps reflecting the newest data without hammering upstream.
let newsCache = { at: 0, data: [] };
app.get(
  '/api/news',
  wrap(async (req, res) => {
    const now = Date.now();
    if (now - newsCache.at < 60_000 && newsCache.data.length) return res.json(newsCache.data);
    let items = [];
    try {
      items = HAS_POLYGON ? await polygonProvider.news(40) : mockNews();
    } catch {
      items = mockNews();
    }
    if (!items || !items.length) items = mockNews();
    const out = items
      .map((a) => ({ ...a, importance: scoreImportance(a) }))
      .sort((a, b) => importanceRank(b.importance) - importanceRank(a.importance) || new Date(b.published || 0) - new Date(a.published || 0))
      .slice(0, 24);
    newsCache = { at: now, data: out };
    res.json(out);
  })
);

// Broker status (read-only). Surfaces the active venue, its account snapshot,
// positions and the order audit trail through the Broker contract.
app.get(
  '/api/broker',
  wrap(async (req, res) => {
    const out = { backend: broker.name };
    try {
      out.account = await broker.getAccount();
      out.positions = await broker.getPositions();
      out.openOrders = await broker.getOpenOrders();
      out.orders = broker.getAllOrders ? await broker.getAllOrders(50) : [];
    } catch (e) {
      // A stubbed venue (e.g. IBKR) throws NOT_IMPLEMENTED — report it rather than 500.
      out.available = false;
      out.note = e.message;
    }
    res.json(out);
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ source: SOURCE }));
// Our market-data database: how many bars we own, across how many symbols.
app.get('/api/marketdb', (req, res) => {
  const s = dbStats();
  res.json({
    ...s,
    fromDate: s.from ? new Date(s.from * 1000).toISOString().slice(0, 10) : null,
    toDate: s.to ? new Date(s.to * 1000).toISOString().slice(0, 10) : null,
    scheduler: scheduler.status(),
  });
});

// Trigger a database top-up now (runs off the request path).
app.post('/api/marketdb/topup', (req, res) => {
  if (SOURCE === 'mock') return res.status(400).json({ error: 'top-up is unavailable in mock mode' });
  res.json(scheduler.runNow());
});

// Recorded stock splits (corporate actions) we hold for a symbol.
app.get('/api/marketdb/splits/:symbol', (req, res) => {
  res.json(
    getSplits(req.params.symbol).map((s) => ({
      date: new Date(s.ts * 1000).toISOString().slice(0, 10),
      ratio: `${s.to}-for-${s.from}`,
      from: s.from,
      to: s.to,
      applied: s.applied,
    }))
  );
});

// Recorded cash dividends we hold for a symbol.
app.get('/api/marketdb/dividends/:symbol', (req, res) => {
  res.json(
    getDividends(req.params.symbol).map((d) => ({
      exDate: new Date(d.ts * 1000).toISOString().slice(0, 10),
      cash: d.cash,
    }))
  );
});

// Recorded earnings announcement dates for a symbol.
app.get('/api/marketdb/earnings/:symbol', (req, res) => {
  res.json(getEarnings(req.params.symbol).map((ts) => new Date(ts * 1000).toISOString().slice(0, 10)));
});

// --- static frontend ----------------------------------------------------------
app.use(express.static(join(root, 'public')));
app.get('*', (req, res) => res.sendFile(join(root, 'public', 'index.html')));

// --- error handler ------------------------------------------------------------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err.message);
  res.status(status).json({ error: err.message || 'Internal error' });
});

// Background AI Trader engine: execute pending entries/exits on the shared
// account on a timer, off the request path. This keeps the AI Trader / portfolio
// pages fast (they only read state) and bounds provider usage to one scan per
// interval regardless of how many clients are polling.
const ENGINE_MS = Number(process.env.AITRADER_TICK_MS) || 10_000;
function startEngine() {
  const tick = () => aitrader.evaluate(yahoo).catch((e) => console.warn('[aitrader] engine:', e.message));
  const t = setInterval(tick, ENGINE_MS);
  if (t.unref) t.unref();
  tick(); // run once at boot so state is warm
}

// Keep an uncaught error from killing the process — a crash + auto-restart is
// what makes the account appear to "reset" (a fresh process reloads state, and a
// crash mid-write used to corrupt it). Log loudly and stay up.
process.on('unhandledRejection', (e) => console.error('[fatal] unhandledRejection:', (e && e.stack) || e));
process.on('uncaughtException', (e) => console.error('[fatal] uncaughtException:', (e && e.stack) || e));

app.listen(PORT, () => {
  console.log(`\n  Shubh Quant Dashboard running at http://localhost:${PORT}\n`);
  // Report exactly what state loaded, so a restart that started fresh is obvious.
  const pf = portfolio.getState();
  const positions = Object.keys(pf.positions || {}).length;
  console.log(
    `[state] loaded account: $${Math.round(pf.cash)} cash · ${positions} positions · ${(pf.orders || []).length} orders` +
      (pf.cash === 100000 && positions === 0 ? '  (fresh account)' : '')
  );
  // Kick off the autonomous AI Strategist: it discovers, promotes, replaces and
  // trades patterns on its own timer, with no user interaction required.
  strategist.start(yahoo);
  // Execute AI Trader orders on a background timer (off the request path).
  startEngine();
  if (SOURCE !== 'mock') {
    const s = dbStats();
    console.log(`[marketdb] ${dbBackend()} backend · ${s.bars.toLocaleString()} bars stored across ${s.symbols} symbols`);
    // Keep the database current: refresh recent bars + apply corporate actions nightly.
    scheduler.start(
      upstreamProvider,
      HAS_POLYGON ? polygonProvider.splits : null,
      HAS_POLYGON ? polygonProvider.dividends : null,
      HAS_POLYGON ? polygonProvider.earnings : null
    );
  }
});
