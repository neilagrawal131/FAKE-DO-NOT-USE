import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yahooProvider from './yahoo.js';
import * as mockProvider from './mock.js';
import * as portfolio from './portfolio.js';

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

// Map a user-facing timeframe to Yahoo range+interval.
const TIMEFRAMES = {
  '1D': { range: '1d', interval: '1m' },
  '5D': { range: '5d', interval: '5m' },
  '1M': { range: '1mo', interval: '30m' },
  '6M': { range: '6mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1d' },
  '5Y': { range: '5y', interval: '1wk' },
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
    const tf = TIMEFRAMES[req.query.tf] || null;
    const range = tf?.range || req.query.range || '1mo';
    const interval = tf?.interval || req.query.interval || '1d';
    res.json(await yahoo.chart(req.params.symbol, range, interval));
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
  console.log(`\n  Paper Trader running at http://localhost:${PORT}\n`);
});
