import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yahooProvider from './yahoo.js';
import * as mockProvider from './mock.js';
import * as portfolio from './portfolio.js';
import { aggregateBars } from './aggregate.js';

// Choose the market-data source. Default is live Yahoo Finance; set
// DATA_SOURCE=mock for an offline demo with synthetic prices.
const SOURCE = (process.env.DATA_SOURCE || 'yahoo').toLowerCase();
const yahoo = SOURCE === 'mock' ? mockProvider : yahooProvider;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const PORT = process.env.PORT || 3000;

console.log(`[data] source = ${SOURCE === 'mock' ? 'mock (synthetic)' : 'yahoo (live NYSE/NASDAQ)'}`);

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

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => res.json({ source: SOURCE }));

// --- static frontend ----------------------------------------------------------
app.use(express.static(join(root, 'public')));
app.get('*', (req, res) => res.sendFile(join(root, 'public', 'index.html')));

// --- error handler ------------------------------------------------------------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err.message);
  res.status(status).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`\n  Shubh Quant Dashboard running at http://localhost:${PORT}\n`);
});
