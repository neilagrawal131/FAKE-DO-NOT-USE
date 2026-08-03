// AI Strategist: backtests a library of scale-free market patterns across a
// chosen universe, scores each by reward vs risk (a Sharpe-like ratio of average
// forward return to its volatility), ranks them, and auto-applies the best ones
// to the paper portfolio by promoting them into the AI Trader.

import { runBacktest } from './backtest.js';
import { normalizeScenario } from './scenario.js';
import { sectorLabel } from './universe.js';
import * as aitrader from './aitrader.js';

const LOOKBACK_DAYS = 365; // 1 year of daily history for the scoring backtests
const MIN_SAMPLE = 15; // ignore patterns with too few occurrences to trust

// Scale-free patterns (no absolute price/volume thresholds) so they compare
// fairly across a whole universe.
const TEMPLATES = [
  { label: '20-day EMA cross ↑', horizon: 5, conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'ema', period: 20 }] },
  { label: '50-day EMA cross ↑', horizon: 10, conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'ema', period: 50 }] },
  { label: '100-day SMA cross ↑', horizon: 10, conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'sma', period: 100 }] },
  { label: '200-day SMA cross ↑', horizon: 20, conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'sma', period: 200 }] },
  { label: '50-day SMA cross ↓ (mean-revert)', horizon: 10, conditions: [{ kind: 'ma_cross', dir: 'below', maType: 'sma', period: 50 }] },
  { label: 'Trend: above 200-day SMA', horizon: 20, conditions: [{ kind: 'ma_state', dir: 'above', maType: 'sma', period: 200 }] },
  { label: 'Bullish fair value gap', horizon: 10, conditions: [{ kind: 'fvg', dir: 'bullish', minPct: null }] },
  { label: 'Bullish FVG ≥ 1%', horizon: 10, conditions: [{ kind: 'fvg', dir: 'bullish', minPct: 1 }] },
  { label: 'Bearish fair value gap', horizon: 10, conditions: [{ kind: 'fvg', dir: 'bearish', minPct: null }] },
  { label: 'Momentum: +3% day', horizon: 5, conditions: [{ kind: 'day_change', dir: 'up', pct: 3 }] },
  { label: 'Dip buy: −3% day', horizon: 5, conditions: [{ kind: 'day_change', dir: 'down', pct: 3 }] },
  { label: 'Dip buy: −5% day', horizon: 10, conditions: [{ kind: 'day_change', dir: 'down', pct: 5 }] },
];

function summarize(rets) {
  const n = rets.length;
  if (!n) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const ups = rets.filter((r) => r > 0);
  const downs = rets.filter((r) => r < 0);
  return {
    n,
    mean,
    std,
    winRate: (ups.length / n) * 100,
    avgWin: ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : 0,
    avgLoss: downs.length ? downs.reduce((a, b) => a + b, 0) / downs.length : 0,
    worst: Math.min(...rets),
    best: Math.max(...rets),
    // Reward per unit of risk (+ downside guard so tiny-variance flukes don't win).
    score: mean / (std + 1),
  };
}

export async function run(provider, { sectorKey = 'market', topK = 3 } = {}) {
  const results = [];
  for (const tpl of TEMPLATES) {
    const scenario = normalizeScenario({
      sectorKey,
      lookbackDays: LOOKBACK_DAYS,
      timeframe: 'daily',
      primaryHorizon: tpl.horizon,
      horizons: [1, 5, 10, 20, tpl.horizon],
      conditions: tpl.conditions,
    });
    let res;
    try {
      res = await runBacktest(scenario, provider);
    } catch {
      continue;
    }
    const rets = res.events.map((e) => e.returns[tpl.horizon]).filter((r) => r != null);
    results.push({
      label: tpl.label,
      horizon: tpl.horizon,
      scenario,
      universe: res.universe.label,
      symbolsScanned: res.universe.symbolsWithData,
      stats: summarize(rets),
      applied: false,
      alreadyActive: aitrader.hasStrategy(scenario),
    });
  }

  const scoreOf = (r) => (r.stats ? r.stats.score : -Infinity);
  results.sort((a, b) => scoreOf(b) - scoreOf(a));

  // Qualify on sample size + positive expectancy, then auto-apply the best.
  const qualified = results.filter((r) => r.stats && r.stats.n >= MIN_SAMPLE && r.stats.mean > 0);
  const applied = [];
  for (const r of qualified) {
    if (applied.length >= topK) break;
    if (r.alreadyActive) continue;
    const added = aitrader.addStrategy(r.scenario, `Auto: ${r.label} · ${r.universe}`);
    if (added) {
      r.applied = true;
      applied.push(r.label);
    }
  }

  return {
    sectorKey,
    universe: sectorLabel(sectorKey),
    topK,
    minSample: MIN_SAMPLE,
    tested: results.length,
    qualified: qualified.length,
    appliedCount: applied.length,
    results: results.map((r) => ({
      label: r.label,
      horizon: r.horizon,
      universe: r.universe,
      symbolsScanned: r.symbolsScanned,
      stats: r.stats,
      applied: r.applied,
      alreadyActive: r.alreadyActive,
    })),
  };
}
