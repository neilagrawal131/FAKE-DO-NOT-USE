// Quantitative statistics for backtest returns. Pure functions, no DOM — used by
// the AI Analyst results panel for event statistics and Monte Carlo simulation.
//
// Every input array holds trade returns in PERCENT (3.5 means +3.5%). Metrics
// that depend on the path (drawdown, equity curve) expect the returns in
// chronological order; the "ordered" argument to fullStats carries that copy.

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Sample standard deviation (n-1 denominator). n<2 → 0.
export function stdev(xs) {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1);
  return Math.sqrt(v);
}

// Downside deviation vs a target (default 0): RMS of shortfalls, averaged over
// ALL observations (the standard MAR-based definition used for Sortino).
export function downsideDeviation(xs, target = 0) {
  if (xs.length < 2) return 0;
  let sum = 0;
  for (const r of xs) if (r < target) sum += (r - target) * (r - target);
  return Math.sqrt(sum / xs.length);
}

// Linear-interpolated percentile (p in 0..100).
export function percentile(xs, p) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

// Per-trade Sharpe = mean / stdev (unitless, not annualized — these are
// per-occurrence returns, not a fixed-period series).
export function sharpe(xs) {
  const sd = stdev(xs);
  return sd > 0 ? mean(xs) / sd : 0;
}

// Per-trade Sortino = mean / downside deviation.
export function sortino(xs) {
  const dd = downsideDeviation(xs, 0);
  return dd > 0 ? mean(xs) / dd : 0;
}

// Profit factor = gross gains / gross losses. No losses → Infinity.
export function profitFactor(xs) {
  let g = 0;
  let l = 0;
  for (const r of xs) {
    if (r > 0) g += r;
    else if (r < 0) l -= r;
  }
  if (l === 0) return g > 0 ? Infinity : 0;
  return g / l;
}

// Compound an ordered % return series into an equity curve (starts at 1).
export function equityCurve(orderedRets) {
  const eq = [1];
  for (const r of orderedRets) eq.push(eq[eq.length - 1] * (1 + r / 100));
  return eq;
}

// Max drawdown (%, negative) of the equity curve from ordered % returns.
export function maxDrawdown(orderedRets) {
  const eq = equityCurve(orderedRets);
  let peak = eq[0];
  let mdd = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd * 100;
}

// Total compounded return (%) of a series (order-independent).
export function totalReturn(rets) {
  let eq = 1;
  for (const r of rets) eq *= 1 + r / 100;
  return (eq - 1) * 100;
}

// The full event-statistics bundle for one set of trade returns. Pass `ordered`
// (the same returns in chronological order) so path metrics use the real
// sequence; falls back to input order when omitted.
export function fullStats(rets, ordered) {
  const n = rets.length;
  if (!n) return { n: 0 };
  const m = mean(rets);
  const sd = stdev(rets);
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  const wins = rets.filter((r) => r > 0).length;
  return {
    n,
    mean: m,
    median: median(rets),
    stdev: sd,
    worst: Math.min(...rets),
    best: Math.max(...rets),
    ci95: [m - 1.96 * se, m + 1.96 * se],
    sharpe: sharpe(rets),
    sortino: sortino(rets),
    profitFactor: profitFactor(rets),
    maxDrawdown: maxDrawdown(ordered || rets),
    winRate: (wins / n) * 100,
    totalReturn: totalReturn(ordered || rets),
  };
}

// Monte Carlo bootstrap. Resamples the historical trade returns WITH REPLACEMENT
// to build `runs` alternate sequences of the same edge — each path draws `n`
// trades in a random order and mix, then compounds them. This answers "does the
// strategy survive bad luck?": if the edge is real it stays profitable across the
// vast majority of reshuffled/resampled runs; if it hangs on a few lucky trades,
// the distribution sags below zero.
export function monteCarlo(rets, { runs = 1000, n = rets.length, rng = Math.random } = {}) {
  if (rets.length < 2) return null;
  const len = rets.length;
  const finals = new Array(runs);
  const drawdowns = new Array(runs);
  for (let s = 0; s < runs; s++) {
    const path = new Array(n);
    for (let i = 0; i < n; i++) path[i] = rets[(rng() * len) | 0];
    finals[s] = totalReturn(path);
    drawdowns[s] = maxDrawdown(path);
  }
  finals.sort((a, b) => a - b);
  drawdowns.sort((a, b) => a - b); // most-negative first
  const profitable = finals.filter((f) => f > 0).length;

  // Histogram of final returns for a compact distribution chart. Clip the domain
  // to the 2nd–98th percentile so a few extreme outliers can't collapse the whole
  // distribution into one bar; tail mass piles into the edge bins.
  const lo = percentile(finals, 2);
  const hi = percentile(finals, 98);
  const BINS = 21;
  const width = hi > lo ? (hi - lo) / BINS : 1;
  const counts = new Array(BINS).fill(0);
  for (const f of finals) {
    let b = width > 0 ? Math.floor((f - lo) / width) : 0;
    if (b >= BINS) b = BINS - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }

  return {
    runs,
    n,
    pProfit: (profitable / runs) * 100,
    final: {
      p5: percentile(finals, 5),
      p25: percentile(finals, 25),
      median: percentile(finals, 50),
      p75: percentile(finals, 75),
      p95: percentile(finals, 95),
      min: finals[0],
      max: finals[finals.length - 1],
      mean: mean(finals),
    },
    drawdown: {
      median: percentile(drawdowns, 50),
      badCase: percentile(drawdowns, 5), // 5th percentile = a rough bad-luck drawdown
      worst: drawdowns[0],
    },
    hist: { lo, width, counts },
  };
}
