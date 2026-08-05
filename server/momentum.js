// Cross-sectional momentum engine.
//
// Unlike the pattern backtester (one stock vs its own past), this ranks the WHOLE
// universe against itself and holds the relative winners — the shape of edge that
// actually has an economic reason to persist (documented across a century of data
// as compensation for crash risk / slow reaction to news).
//
// Design follows the literature (Jegadeesh–Titman, Asness, Barroso–Santa-Clara):
//   - Signal: "12–1" momentum — trailing return over `lookback` bars, SKIPPING the
//     most recent `skip` bars (the skip avoids short-term reversal contaminating
//     the signal).
//   - Cross-sectional rank each rebalance; go long-only the top `topK` names
//     (long-only because a $1k cash account can't short).
//   - Monthly rebalance (~21 trading days), low turnover so costs stay survivable.
//   - Inverse-volatility weighting by default (a simple momentum-crash dampener);
//     equal-weight optional. Optional portfolio vol-targeting scales exposure DOWN
//     to cash when recent strategy vol spikes.
//   - Turnover costs (commission + spread + slippage) charged on every rebalance.
//
// Everything is validated the same honest way as patterns: a walk-forward that
// tunes (lookback, topK) in-sample and measures the choice out-of-sample.

import { sectorSymbols, sectorLabel, TARGET_SECTORS } from './universe.js';
import { DEFAULT_COSTS, roundTripCostPct } from './costs.js';

const DAY = 86400;

export const MOMENTUM_DEFAULTS = Object.freeze({
  lookbackBars: 252, // ~12 months
  skipBars: 21, // ~1 month, the "12–1" skip
  rebalBars: 21, // rebalance monthly
  volWindow: 63, // ~3 months for per-name vol
  topK: 20, // hold the top 20 names
  weighting: 'inversevol', // 'inversevol' | 'equal'
  volTargetAnnual: null, // e.g. 0.15 to scale exposure toward a 15% vol target (else full invested)
  freshnessDays: 7, // ignore a symbol whose latest bar is staler than this at a rebalance
});

// --- small utilities ---------------------------------------------------------
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        out[i] = await fn(items[i]);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function cleanBars(data) {
  const bars = (data && data.bars) || [];
  return bars
    .filter((b) => b && Number.isFinite(b.time) && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.time - b.time);
}

function stdev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1));
}

// Rightmost bar index with time <= t (binary search); -1 if none.
function lastIdxAtOrBefore(bars, t) {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function universeSymbols(key) {
  if (!key || key === 'all') {
    const set = new Set();
    for (const sec of TARGET_SECTORS) for (const s of sectorSymbols(sec)) set.add(s);
    return [...set];
  }
  return sectorSymbols(key);
}

export function universeLabel(key) {
  return !key || key === 'all' ? 'All sectors (broad liquid universe)' : sectorLabel(key);
}

// Load daily bars once for the whole universe.
export async function loadMomentumUniverse(symbols, provider) {
  const per = await mapLimit(symbols, 6, async (sym) => {
    const bars = cleanBars(await provider.chart(sym, 'max', '1d'));
    if (bars.length < 120) return null;
    return { sym, bars };
  });
  const series = per.filter(Boolean);
  // Master clock = the longest series' timeline (liquid US names share the NYSE
  // calendar, so this is a good rebalance clock).
  let clock = [];
  for (const s of series) if (s.bars.length > clock.length) clock = s.bars;
  return { series, clock: clock.map((b) => b.time), symbolsRequested: symbols.length, symbolsWithData: series.length };
}

// Momentum signal + trailing vol for one symbol at bar index i.
function signalAt(bars, i, p) {
  const need = p.skipBars + p.lookbackBars;
  if (i < need) return null;
  const endC = bars[i - p.skipBars].close; // skip the most recent bars
  const startC = bars[i - p.skipBars - p.lookbackBars].close;
  if (!(startC > 0) || !(endC > 0)) return null;
  const mom = endC / startC - 1;
  // Trailing daily vol over volWindow ending at i.
  const rets = [];
  for (let k = Math.max(1, i - p.volWindow + 1); k <= i; k++) {
    const r = bars[k].close / bars[k - 1].close - 1;
    if (Number.isFinite(r)) rets.push(r);
  }
  return { mom, vol: stdev(rets) };
}

// Core simulation: run the momentum portfolio over rebalance dates in [from, to).
// Returns per-period NET returns (percent) plus diagnostics. Pure over `loaded`.
export function simulateMomentum(loaded, params, range = {}) {
  const p = { ...MOMENTUM_DEFAULTS, ...params };
  const from = range.from ?? -Infinity;
  const to = range.to ?? Infinity;
  const oneWayCost = roundTripCostPct(params.costs || DEFAULT_COSTS) / 2 / 100; // fraction, per side
  const clock = loaded.clock;
  const freshness = p.freshnessDays * DAY;

  const periods = [];
  let prevW = new Map(); // symbol -> weight held going into this rebalance
  let start = p.lookbackBars + p.skipBars + 5;

  for (let r = start; r + p.rebalBars < clock.length; r += p.rebalBars) {
    const tR = clock[r];
    const tNext = clock[r + p.rebalBars];

    // Rank candidates by momentum at tR.
    const cands = [];
    for (const s of loaded.series) {
      const i = lastIdxAtOrBefore(s.bars, tR);
      if (i < 0 || tR - s.bars[i].time > freshness) continue;
      const sig = signalAt(s.bars, i, p);
      if (!sig || !Number.isFinite(sig.mom)) continue;
      const j = lastIdxAtOrBefore(s.bars, tNext);
      if (j <= i) continue;
      const fwd = s.bars[j].close / s.bars[i].close - 1; // forward return over the hold
      if (!Number.isFinite(fwd)) continue;
      cands.push({ sym: s.sym, mom: sig.mom, vol: sig.vol, fwd });
    }
    if (cands.length < Math.max(5, Math.min(p.topK, 5))) {
      prevW = new Map();
      continue;
    }

    cands.sort((a, b) => b.mom - a.mom);
    const picks = cands.slice(0, Math.min(p.topK, cands.length));

    // Weights: inverse-vol (crash dampener) or equal.
    const w = new Map();
    if (p.weighting === 'equal') {
      for (const c of picks) w.set(c.sym, 1 / picks.length);
    } else {
      let tot = 0;
      for (const c of picks) tot += 1 / Math.max(c.vol, 1e-4);
      for (const c of picks) w.set(c.sym, 1 / Math.max(c.vol, 1e-4) / tot);
    }

    // Optional portfolio vol-targeting: scale exposure DOWN toward a target using
    // recent realized strategy vol (long-only, so never above 100%).
    let exposure = 1;
    if (p.volTargetAnnual && periods.length >= 6) {
      const recent = periods.slice(-6).map((x) => x.grossRet / 100);
      const annVol = stdev(recent) * Math.sqrt(12);
      if (annVol > 0) exposure = Math.min(1, p.volTargetAnnual / annVol);
    }

    // Gross period return = exposure-weighted forward returns (rest in cash @ 0).
    let gross = 0;
    for (const c of picks) gross += w.get(c.sym) * c.fwd;
    gross *= exposure;

    // Turnover cost: sum |w_new*exposure - w_prev| across the union of names.
    const syms = new Set([...w.keys(), ...prevW.keys()]);
    let turnover = 0;
    for (const sym of syms) turnover += Math.abs((w.get(sym) || 0) * exposure - (prevW.get(sym) || 0));
    const cost = turnover * oneWayCost;
    const net = gross - cost;

    if (tR >= from && tR < to) {
      periods.push({
        time: tR,
        n: picks.length,
        exposure,
        turnover,
        grossRet: gross * 100,
        ret: net * 100, // NET percent — what the client's stats run on
      });
    }
    // Carry forward the *effective* weights (post-exposure) for next turnover calc.
    prevW = new Map();
    for (const c of picks) prevW.set(c.sym, w.get(c.sym) * exposure);
  }

  return { periods, latest: latestHoldings(loaded, p) };
}

// The portfolio the strategy would hold RIGHT NOW (for display).
function latestHoldings(loaded, p) {
  const clock = loaded.clock;
  if (!clock.length) return [];
  const tR = clock[clock.length - 1];
  const cands = [];
  for (const s of loaded.series) {
    const i = lastIdxAtOrBefore(s.bars, tR);
    if (i < 0) continue;
    const sig = signalAt(s.bars, i, p);
    if (!sig || !Number.isFinite(sig.mom)) continue;
    cands.push({ sym: s.sym, mom: sig.mom, vol: sig.vol });
  }
  cands.sort((a, b) => b.mom - a.mom);
  const picks = cands.slice(0, Math.min(p.topK, cands.length));
  let tot = 0;
  for (const c of picks) tot += 1 / Math.max(c.vol, 1e-4);
  return picks.map((c) => ({
    symbol: c.sym,
    momentum: +(c.mom * 100).toFixed(1),
    weight: p.weighting === 'equal' ? +(100 / picks.length).toFixed(1) : +((100 / Math.max(c.vol, 1e-4)) / tot).toFixed(1),
  }));
}

// Annualized summary from a monthly (per-period) NET return series in percent.
function annualize(periodsPerYear, retsPct) {
  const n = retsPct.length;
  if (!n) return { n: 0 };
  let eq = 1;
  const curve = [1];
  for (const r of retsPct) {
    eq *= 1 + r / 100;
    curve.push(eq);
  }
  const totalReturn = (eq - 1) * 100;
  const annReturn = (Math.pow(eq, periodsPerYear / n) - 1) * 100;
  const vol = stdev(retsPct.map((r) => r / 100));
  const annVol = vol * Math.sqrt(periodsPerYear) * 100;
  const annSharpe = annVol > 0 ? annReturn / annVol : 0;
  let peak = curve[0];
  let mdd = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return { n, totalReturn, annReturn, annVol, annSharpe, maxDrawdown: mdd * 100, equity: curve };
}

// Full-history (in-sample) backtest.
export function momentumBacktest(loaded, params) {
  const sim = simulateMomentum(loaded, params);
  const rets = sim.periods.map((x) => x.ret);
  const ppy = Math.round(252 / (params.rebalBars || MOMENTUM_DEFAULTS.rebalBars));
  return {
    periods: sim.periods,
    monthlyReturns: rets,
    summary: annualize(ppy, rets),
    latest: sim.latest,
    periodsPerYear: ppy,
  };
}

// Walk-forward validation: tune (lookback, topK) in-sample on each train window,
// measure that choice on the next unseen window. Concatenated test returns are the
// out-of-sample track record.
export function momentumWalkForward(loaded, cfg = {}) {
  const base = { ...MOMENTUM_DEFAULTS, ...cfg };
  const lookbacks = cfg.lookbacks || [126, 189, 252];
  const topKs = cfg.topKs || [10, 20, 30];
  const ppy = Math.round(252 / base.rebalBars);
  const grid = [];
  for (const lb of lookbacks) for (const k of topKs) grid.push({ ...base, lookbackBars: lb, topK: k });

  const clock = loaded.clock;
  if (clock.length < 400) return { error: 'insufficient_history', oosReturns: [], folds: [] };
  const tMin = clock[0];
  const tMax = clock[clock.length - 1];
  const trainSec = (cfg.trainDays || 730) * DAY; // ~3y train
  const testSec = (cfg.testDays || 365) * DAY; // ~1y test

  const folds = [];
  const oos = [];
  let trainStart = tMin;
  let guard = 0;
  while (trainStart + trainSec + testSec <= tMax + DAY && guard < 100) {
    guard++;
    const trainFrom = trainStart;
    const trainTo = trainStart + trainSec;
    const testTo = trainTo + testSec;

    // Tune: best in-sample Sharpe (annualized) on the train window.
    let best = null;
    for (const g of grid) {
      const rets = simulateMomentum(loaded, g, { from: trainFrom, to: trainTo }).periods.map((x) => x.ret);
      if (rets.length < 6) continue;
      const s = annualize(ppy, rets);
      if (!best || s.annSharpe > best.sharpe) best = { params: g, sharpe: s.annSharpe, annReturn: s.annReturn };
    }
    if (best) {
      const testRets = simulateMomentum(loaded, best.params, { from: trainTo, to: testTo }).periods;
      folds.push({
        trainFrom,
        trainTo,
        testTo,
        lookbackBars: best.params.lookbackBars,
        topK: best.params.topK,
        trainSharpe: best.sharpe,
        nTest: testRets.length,
        oosMean: testRets.length ? testRets.reduce((a, b) => a + b.ret, 0) / testRets.length : null,
      });
      for (const pd of testRets) oos.push(pd.ret);
    }
    trainStart += testSec;
  }

  return {
    grid: { lookbacks, topKs },
    trainDays: cfg.trainDays || 730,
    testDays: cfg.testDays || 365,
    folds,
    oosReturns: oos,
    summary: annualize(ppy, oos),
    periodsPerYear: ppy,
  };
}

// Top-level: load once, run in-sample backtest + out-of-sample walk-forward.
export async function runMomentum(provider, cfg = {}) {
  const params = { ...MOMENTUM_DEFAULTS, ...cfg };
  const key = cfg.universe || 'all';
  const symbols = universeSymbols(key);
  const loaded = await loadMomentumUniverse(symbols, provider);
  if (loaded.series.length < 10) {
    return { error: 'insufficient_universe', universe: { key, label: universeLabel(key), symbolsRequested: symbols.length, symbolsWithData: loaded.series.length } };
  }
  const direct = momentumBacktest(loaded, params);
  const wf = momentumWalkForward(loaded, params);
  return {
    config: {
      universe: key,
      lookbackBars: params.lookbackBars,
      skipBars: params.skipBars,
      rebalBars: params.rebalBars,
      topK: params.topK,
      weighting: params.weighting,
      volTargetAnnual: params.volTargetAnnual,
    },
    costs: params.costs || DEFAULT_COSTS,
    universe: { key, label: universeLabel(key), symbolsRequested: symbols.length, symbolsWithData: loaded.series.length },
    span: { from: loaded.clock[0] || null, to: loaded.clock[loaded.clock.length - 1] || null },
    direct,
    walkforward: wf,
  };
}
