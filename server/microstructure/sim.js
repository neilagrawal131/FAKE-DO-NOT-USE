// Market-making simulation on top of the order book. It exists to make ONE idea
// concrete and measurable: a market-maker earns the spread from UNINFORMED flow
// and bleeds it back to INFORMED flow (adverse selection) and to being SLOW.
//
// Setup:
//   - A hidden "fair value" random-walks (and occasionally jumps on "news").
//   - The market-maker (MM) posts a bid and an ask around its PERCEIVED fair,
//     which lags the true fair by `latency` steps — the slower it is, the staler
//     its quotes. It skews quotes to mean-revert its inventory.
//   - NOISE traders send random market orders (the MM's bread and butter).
//   - INFORMED traders know the true fair and only trade when the MM's quote is
//     stale/wrong — lifting a too-cheap ask or hitting a too-rich bid. That is
//     adverse selection: the MM's fills are systematically on the wrong side.
//
// The MM's total mark-to-market P&L decomposes exactly into:
//     total = spread captured (edge vs true fair at each fill)
//           + inventory P&L (how held inventory moved vs fair)  [the adverse part]
// Watch spread-capture stay positive while the inventory term goes deeply negative
// as informed flow or latency rises — that is why HFT is a speed race.

import { OrderBook } from './orderbook.js';

// Deterministic RNG (mulberry32) so runs are reproducible/testable.
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randn(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const SIM_DEFAULTS = Object.freeze({
  steps: 20000,
  seed: 42,
  fair0: 10000, // starting fair value in cents ($100.00)
  fairVol: 2, // per-step fair-value volatility, in cents (~$0.02)
  jumpProb: 0.003, // chance of a "news" jump each step
  jumpSize: 25, // jump magnitude in cents
  halfSpread: 3, // MM quotes ± this many cents around perceived fair (spread = 2×)
  mmSize: 5, // shares the MM shows on each side
  mmLatency: 1, // steps its perceived fair lags the true fair (0 = instant)
  skewCents: 2, // quote skew per share of inventory (mean-reverts inventory)
  invLimit: 200, // stop quoting the side that would grow |inventory| past this
  informedFrac: 0.15, // fraction of order flow that is informed
  informedEdge: 4, // informed act only when the quote is mispriced by > this (cents)
  ordersPerStep: 1, // arrivals per step
});

export function runSim(opts = {}) {
  const p = { ...SIM_DEFAULTS, ...opts };
  const rand = makeRng(p.seed);
  const book = new OrderBook();

  let fair = p.fair0;
  const fairHist = [fair];
  let inv = 0; // MM inventory (shares)
  let cash = 0; // MM cash (cents)
  let spreadCapture = 0; // cents: edge vs true fair at each MM fill
  let mmSells = 0;
  let mmBuys = 0;
  let fillsFromInformed = 0;
  let fillsFromNoise = 0;
  let maxAbsInv = 0;
  const equityCurve = [];

  const applyMmFills = (fills, fromInformed) => {
    for (const f of fills) {
      if (f.makerId !== 'MM') continue;
      if (f.makerSide === 'sell') {
        inv -= f.size;
        cash += f.price * f.size;
        spreadCapture += (f.price - fair) * f.size; // sold above fair = good
        mmSells += 1;
      } else {
        inv += f.size;
        cash -= f.price * f.size;
        spreadCapture += (fair - f.price) * f.size; // bought below fair = good
        mmBuys += 1;
      }
      if (fromInformed) fillsFromInformed += 1;
      else fillsFromNoise += 1;
    }
  };

  for (let t = 0; t < p.steps; t++) {
    // 1) Evolve the true fair value.
    const prevFair = fair;
    fair += randn(rand) * p.fairVol;
    if (rand() < p.jumpProb) fair += (rand() < 0.5 ? -1 : 1) * p.jumpSize;
    fairHist.push(fair);

    void prevFair; // (inventory is marked at the true fair in the total P&L below)

    // 2) MM re-quotes around its PERCEIVED (lagged) fair, skewed by inventory.
    const perceived = fairHist[Math.max(0, fairHist.length - 1 - p.mmLatency)];
    book.cancelAgent('MM');
    const skew = Math.round(inv * (p.skewCents / p.mmSize));
    const bidPx = Math.round(perceived) - p.halfSpread - skew;
    const askPx = Math.round(perceived) + p.halfSpread - skew;
    if (askPx > bidPx) {
      if (inv - p.mmSize > -p.invLimit) book.limit('buy', bidPx, p.mmSize, 'MM'); // don't overbuy
      if (inv + p.mmSize < p.invLimit) book.limit('sell', askPx, p.mmSize, 'MM'); // don't oversell
    }

    // 3) Order flow arrives and trades against the MM's quotes.
    for (let k = 0; k < p.ordersPerStep; k++) {
      const informed = rand() < p.informedFrac;
      if (informed) {
        // Knows true fair; only trades when the quote is stale/mispriced.
        const a = book.bestAsk();
        const b = book.bestBid();
        if (a != null && a < fair - p.informedEdge) {
          applyMmFills(book.market('buy', p.mmSize, 'INF'), true); // lift the too-cheap ask
        } else if (b != null && b > fair + p.informedEdge) {
          applyMmFills(book.market('sell', p.mmSize, 'INF'), true); // hit the too-rich bid
        }
      } else {
        // Uninformed: random side, small size.
        const side = rand() < 0.5 ? 'buy' : 'sell';
        applyMmFills(book.market(side, 1 + Math.floor(rand() * 2), 'NOISE'), false);
      }
    }

    if (Math.abs(inv) > maxAbsInv) maxAbsInv = Math.abs(inv);
    if (t % Math.max(1, Math.floor(p.steps / 400)) === 0) equityCurve.push(+((cash + inv * fair) / 100).toFixed(2));
  }

  const totalPnl = cash + inv * fair;
  return {
    params: p,
    // dollars
    totalPnl: +(totalPnl / 100).toFixed(2),
    spreadCapture: +(spreadCapture / 100).toFixed(2),
    inventoryPnl: +((totalPnl - spreadCapture) / 100).toFixed(2), // the adverse-selection channel
    finalInventory: inv,
    maxAbsInventory: maxAbsInv,
    mmSells,
    mmBuys,
    fillsFromInformed,
    fillsFromNoise,
    totalFills: mmSells + mmBuys,
    equityCurve,
  };
}
