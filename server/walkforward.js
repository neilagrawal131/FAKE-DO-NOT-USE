// Walk-forward / out-of-sample validation — the honest test of whether a pattern
// has a real edge or is just overfitting.
//
// The trap: if you pick the pattern (or the parameter) that scored best on a
// slice of history and then report that same slice's performance, you're grading
// your own exam with the answer key open. Anything looks good in-sample.
//
// Walk-forward closes the book: on each TRAIN window we pick the best hold
// horizon (the tuned "parameter") by cost-adjusted return, then measure that
// choice on the FOLLOWING, unseen TEST window. Roll forward and stitch the test
// windows together — that concatenation is the out-of-sample track record: how
// the strategy would actually have done trading forward through time, always
// using only what it could have known at the time. Costs are subtracted from
// every trade. See docs/GOING_LIVE.md §6.

import { loadUniverseSeries, patternTradesInWindow } from './backtest.js';
import { sectorLabel } from './universe.js';
import { DEFAULT_COSTS, roundTripCostPct } from './costs.js';

const DAY = 86400;

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export async function walkForward(scenario, provider, cfg = {}) {
  const costs = cfg.costs || DEFAULT_COSTS;
  const rtCost = roundTripCostPct(costs);
  // Candidate hold horizons — the parameter we "optimize" in-sample each fold.
  const horizons = (cfg.horizons && cfg.horizons.length ? cfg.horizons : scenario.horizons) || [3, 5, 10, 20];
  const minTrainTrades = cfg.minTrainTrades || 20;

  const loaded = await loadUniverseSeries(scenario, provider);
  if (!loaded.series.length) {
    return { error: 'no_data', universe: { symbolsRequested: loaded.symbolsRequested, symbolsWithData: 0 } };
  }

  // Overall time span actually available across the universe.
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const s of loaded.series) {
    if (!s.bars.length) continue;
    tMin = Math.min(tMin, s.bars[0].time);
    tMax = Math.max(tMax, s.bars[s.bars.length - 1].time);
  }

  const scale = loaded.intraday ? DAY / (6.5 * 3600) : 1; // intraday: interpret window "days" as trading days
  const trainDays = cfg.trainDays || 504; // ~2 years of trading days
  const testDays = cfg.testDays || 126; // ~6 months
  const trainSec = trainDays * DAY * scale;
  const testSec = testDays * DAY * scale;

  const folds = [];
  const oos = []; // { time, ret } net of costs, out-of-sample
  const grossOos = []; // { time, ret } pre-cost, out-of-sample
  const inSample = []; // net returns of the SELECTED horizon on its train window

  let trainStart = tMin;
  let guard = 0;
  while (trainStart + trainSec + testSec <= tMax + DAY && guard < 1000) {
    guard += 1;
    const trainFrom = trainStart;
    const trainTo = trainStart + trainSec;
    const testFrom = trainTo;
    const testTo = trainTo + testSec;

    // Optimize: pick the horizon with the best cost-adjusted mean on TRAIN.
    let best = null;
    for (const H of horizons) {
      const tr = patternTradesInWindow(loaded, scenario, H, trainFrom, trainTo).map((t) => t.ret - rtCost);
      if (tr.length < minTrainTrades) continue;
      const score = mean(tr);
      if (!best || score > best.score) best = { horizon: H, score, isReturns: tr };
    }

    if (best) {
      // Evaluate that locked choice on the UNSEEN test window.
      const testTrades = patternTradesInWindow(loaded, scenario, best.horizon, testFrom, testTo);
      const netTest = testTrades.map((t) => ({ time: t.time, ret: t.ret - rtCost }));
      folds.push({
        trainFrom,
        trainTo,
        testFrom,
        testTo,
        horizon: best.horizon,
        trainScore: best.score,
        nTrain: best.isReturns.length,
        nTest: netTest.length,
        oosMean: netTest.length ? mean(netTest.map((t) => t.ret)) : null,
      });
      for (const t of testTrades) grossOos.push({ time: t.time, ret: t.ret });
      for (const t of netTest) oos.push(t);
      for (const r of best.isReturns) inSample.push(r);
    }

    trainStart += testSec; // non-overlapping test windows → clean OOS concatenation
  }

  oos.sort((a, b) => a.time - b.time);
  grossOos.sort((a, b) => a.time - b.time);

  return {
    config: { trainDays, testDays, horizons, minTrainTrades },
    costs,
    roundTripCostPct: rtCost,
    universe: {
      symbol: scenario.symbol || null,
      label: scenario.symbol ? scenario.symbol : sectorLabel(scenario.sectorKey),
      symbolsRequested: loaded.symbolsRequested,
      symbolsWithData: loaded.symbolsWithData,
    },
    span: { from: Number.isFinite(tMin) ? tMin : null, to: Number.isFinite(tMax) ? tMax : null },
    folds,
    // Raw return arrays (chronological) — the client computes the full quant
    // panel (Sharpe/Sortino/Monte Carlo) on these with the same stats module the
    // Analyst uses, so in-sample and out-of-sample are measured identically.
    oosReturns: oos.map((o) => o.ret),
    grossOosReturns: grossOos.map((o) => o.ret),
    isReturns: inSample,
  };
}
