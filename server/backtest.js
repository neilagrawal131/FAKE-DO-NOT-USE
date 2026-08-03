// Scenario backtester. Given a structured scenario, it scans every stock in the
// sector universe over the lookback window, finds days where all conditions
// fire, then measures what the stock did over several forward horizons — and
// aggregates that into "rose X% of the time by Y / fell ...".

import { sectorSymbols, sectorLabel } from './universe.js';
import { describeScenario } from './scenario.js';

// Pick an upstream fetch range big enough for the lookback + MA warmup + horizon.
export function fetchRange(lookbackDays) {
  if (lookbackDays <= 400) return '2y';
  if (lookbackDays <= 900) return '5y';
  return 'max';
}

// Intraday fetch range keyword scaled to the requested window (bounded by what
// the active data source actually serves — see each provider's INTRADAY_MAX_DAYS).
export function intradayRange(lookbackDays) {
  if (lookbackDays <= 30) return '1mo';
  if (lookbackDays <= 90) return '3mo';
  if (lookbackDays <= 182) return '6mo';
  if (lookbackDays <= 365) return '1y';
  if (lookbackDays <= 730) return '2y';
  if (lookbackDays <= 1825) return '5y';
  return 'max';
}

// Simple/exponential moving average aligned to `bars` (null until enough data).
function movingAverage(bars, period, type) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  if (type === 'ema') {
    const k = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += bars[i].close;
    let prev = sum / period;
    out[period - 1] = prev;
    for (let i = period; i < bars.length; i++) {
      prev = bars[i].close * k + prev * (1 - k);
      out[i] = prev;
    }
  } else {
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].close;
      if (i >= period) sum -= bars[i - period].close;
      if (i >= period - 1) out[i] = sum / period;
    }
  }
  return out;
}

// Concurrency-limited map so we don't hammer the data source.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Evaluate every condition at bar index i for one symbol's series.
function conditionsMet(conditions, bars, maCache, i) {
  if (i < 1) return false;
  for (const c of conditions) {
    if (c.kind === 'ma_cross' || c.kind === 'ma_state') {
      const ma = maCache.get(maKey(c));
      const cur = ma[i];
      const prev = ma[i - 1];
      if (cur == null) return false;
      if (c.kind === 'ma_cross') {
        if (prev == null) return false;
        if (c.dir === 'above' && !(bars[i].close > cur && bars[i - 1].close <= prev)) return false;
        if (c.dir === 'below' && !(bars[i].close < cur && bars[i - 1].close >= prev)) return false;
      } else {
        if (c.dir === 'above' && !(bars[i].close > cur)) return false;
        if (c.dir === 'below' && !(bars[i].close < cur)) return false;
      }
    } else if (c.kind === 'volume') {
      const v = bars[i].volume || 0;
      if (c.op === '>' && !(v > c.value)) return false;
      if (c.op === '<' && !(v < c.value)) return false;
    } else if (c.kind === 'day_change') {
      const chg = ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100;
      if (c.dir === 'up' && !(chg >= c.pct)) return false;
      if (c.dir === 'down' && !(chg <= -c.pct)) return false;
    } else if (c.kind === 'opening_move') {
      // Only the first 30-min bar of each session; its open-to-close move.
      const isFirstOfDay = Math.floor(bars[i].time / 86400) !== Math.floor(bars[i - 1].time / 86400);
      if (!isFirstOfDay) return false;
      const o = bars[i].open;
      if (!(o > 0)) return false;
      const move = ((bars[i].close - o) / o) * 100;
      if (c.dir === 'up' && !(move >= c.pct)) return false;
      if (c.dir === 'down' && !(move <= -c.pct)) return false;
    } else if (c.kind === 'fvg') {
      // 3-candle imbalance: bullish = today's low above the high 2 bars back;
      // bearish = today's high below the low 2 bars back.
      if (i < 2) return false;
      let gap;
      if (c.dir === 'bullish') {
        gap = bars[i].low - bars[i - 2].high;
      } else {
        gap = bars[i - 2].low - bars[i].high;
      }
      if (!(gap > 0)) return false;
      if (c.minPct != null && !((gap / bars[i].close) * 100 >= c.minPct)) return false;
    }
  }
  return true;
}

function maKey(c) {
  return `${c.maType}:${c.period}`;
}

// --- entry filter & exit rules (shared by live trading and pattern scoring) ----
// Enter LOWER: only take a signal on a pullback (price in the lower part of its
// recent range) and never when it's stretched far above its short MA.
export const ENTRY = {
  maPeriod: Number(process.env.ENTRY_MA_PERIOD) || 20,
  rangeLookback: Number(process.env.ENTRY_RANGE_LOOKBACK) || 20,
  dipMax: Number(process.env.ENTRY_DIP_MAX) || 0.5, // must sit in the lower 50% of the range
  extAbove: Number(process.env.ENTRY_EXT_ABOVE) || 0.08, // skip if > 8% above the short MA
};
// Sell HIGHER: profit target, or a trailing stop once in profit, or a stop-loss,
// or the pattern's time horizon as a backstop — whichever comes first.
export const EXIT = {
  targetPct: Number(process.env.EXIT_TARGET_PCT) || 0.08,
  stopPct: Number(process.env.EXIT_STOP_PCT) || 0.05,
  trailPct: Number(process.env.EXIT_TRAIL_PCT) || 0.03,
  trailArm: Number(process.env.EXIT_TRAIL_ARM) || 0.04, // arm the trail after +4% at peak
};

// Is bar i a good (low) entry: a pullback within range, not extended above the MA?
function entryOk(bars, i, shortMA) {
  if (i < ENTRY.rangeLookback) return true;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = i - ENTRY.rangeLookback + 1; k <= i; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }
  const span = hi - lo;
  const pos = span > 0 ? (bars[i].close - lo) / span : 0;
  if (pos > ENTRY.dipMax) return false; // upper part of the range — not a dip
  const ma = shortMA[i];
  if (ma != null && bars[i].close > ma * (1 + ENTRY.extAbove)) return false; // extended
  return true;
}

// Simulate the target/trailing/stop/time exit from an entry bar, returning the
// realized % return (uses intrabar high/low, stop checked first = conservative).
function simulateExit(bars, entryIdx, horizon) {
  const entry = bars[entryIdx].close;
  const maxJ = Math.min(bars.length - 1, entryIdx + Math.max(1, horizon));
  let peak = entry;
  for (let j = entryIdx + 1; j <= maxJ; j++) {
    const b = bars[j];
    if (b.low <= entry * (1 - EXIT.stopPct)) return ((entry * (1 - EXIT.stopPct) - entry) / entry) * 100;
    if (b.high >= entry * (1 + EXIT.targetPct)) return ((entry * (1 + EXIT.targetPct) - entry) / entry) * 100;
    if (b.high > peak) peak = b.high;
    if (peak >= entry * (1 + EXIT.trailArm) && b.close <= peak * (1 - EXIT.trailPct)) return ((b.close - entry) / entry) * 100;
  }
  return ((bars[maxJ].close - entry) / entry) * 100; // time backstop
}

// Score a pattern the way it actually TRADES: only dip entries, exited by the
// target/trailing/stop/time rules. Returns realized returns + coverage.
export async function simulatePattern(scenario, provider) {
  const symbols = scenario.symbol ? [scenario.symbol] : sectorSymbols(scenario.sectorKey);
  const intraday = scenario.timeframe === 'intraday';
  const interval = intraday ? '30m' : '1d';
  const range = intraday ? intradayRange(scenario.lookbackDays) : fetchRange(scenario.lookbackDays);
  const cutoff = Math.floor(Date.now() / 1000) - scenario.lookbackDays * 86400;
  const H = scenario.primaryHorizon;
  const maDefs = scenario.conditions
    .filter((c) => c.kind === 'ma_cross' || c.kind === 'ma_state')
    .map((c) => ({ key: maKey(c), period: c.period, type: c.maType }));

  const per = await mapLimit(symbols, 6, async (sym) => {
    const bars = cleanBars(await provider.chart(sym, range, interval));
    if (bars.length < 30) return null;
    const maCache = new Map();
    for (const d of maDefs) if (!maCache.has(d.key)) maCache.set(d.key, movingAverage(bars, d.period, d.type));
    const shortMA = movingAverage(bars, ENTRY.maPeriod, 'sma');
    const rets = [];
    for (let i = 1; i < bars.length - 1; i++) {
      if (bars[i].time < cutoff) continue;
      if (!conditionsMet(scenario.conditions, bars, maCache, i)) continue;
      if (!entryOk(bars, i, shortMA)) continue;
      rets.push(simulateExit(bars, i, H));
    }
    return rets;
  });
  const withData = per.filter(Boolean);
  return { returns: withData.flat(), symbolsWithData: withData.length };
}

// Defend against malformed provider output: drop null/invalid bars (a single bad
// element would otherwise crash every scan with "reading 'time' of null"), and
// guarantee bars are in ascending time order.
function cleanBars(data) {
  const bars = (data && data.bars) || [];
  return bars
    .filter((b) => b && Number.isFinite(b.time) && Number.isFinite(b.close) && Number.isFinite(b.open))
    .sort((a, b) => a.time - b.time);
}

export async function runBacktest(scenario, provider) {
  const symbols = scenario.symbol ? [scenario.symbol] : sectorSymbols(scenario.sectorKey);
  const intraday = scenario.timeframe === 'intraday';
  const interval = intraday ? '30m' : '1d';
  const range = intraday ? intradayRange(scenario.lookbackDays) : fetchRange(scenario.lookbackDays);
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - scenario.lookbackDays * 86400;
  const maxHorizon = Math.max(...scenario.horizons);

  // Which MA series we need to precompute per symbol.
  const maDefs = scenario.conditions
    .filter((c) => c.kind === 'ma_cross' || c.kind === 'ma_state')
    .map((c) => ({ key: maKey(c), period: c.period, type: c.maType }));

  const perSymbol = await mapLimit(symbols, 6, async (sym) => {
    const data = await provider.chart(sym, range, interval);
    const bars = cleanBars(data);
    if (bars.length < 30) return null;

    const maCache = new Map();
    for (const d of maDefs) {
      if (!maCache.has(d.key)) maCache.set(d.key, movingAverage(bars, d.period, d.type));
    }

    const events = [];
    // Scan days inside the lookback window that still have forward data.
    for (let i = 1; i < bars.length - 1; i++) {
      if (bars[i].time < cutoff) continue;
      if (!conditionsMet(scenario.conditions, bars, maCache, i)) continue;
      const rets = {};
      let hasAny = false;
      for (const h of scenario.horizons) {
        const j = i + h;
        if (j < bars.length) {
          rets[h] = ((bars[j].close - bars[i].close) / bars[i].close) * 100;
          hasAny = true;
        }
      }
      if (!hasAny) continue;
      events.push({
        id: `${sym}-${bars[i].time}`,
        symbol: sym,
        time: bars[i].time,
        date: intraday
          ? new Date(bars[i].time * 1000).toISOString().slice(0, 16).replace('T', ' ')
          : new Date(bars[i].time * 1000).toISOString().slice(0, 10),
        entry: bars[i].close,
        returns: rets,
      });
    }
    return { symbol: sym, events, ok: true };
  });

  const withData = perSymbol.filter(Boolean);
  const allEvents = withData.flatMap((s) => s.events);

  // Return the full occurrence list (most recent first) so the client can render
  // every one, chart it, and recompute stats live when the user removes some.
  const MAX_EVENTS = 4000;
  const sorted = [...allEvents].sort((a, b) => b.time - a.time);
  const events = sorted.slice(0, MAX_EVENTS);

  return {
    scenario,
    interpretation: describeScenario(scenario),
    universe: {
      sectorKey: scenario.sectorKey,
      symbol: scenario.symbol || null,
      label: scenario.symbol ? scenario.symbol : sectorLabel(scenario.sectorKey),
      symbolsRequested: symbols.length,
      symbolsWithData: withData.length,
      symbols,
    },
    triggers: allEvents.length,
    primaryHorizon: scenario.primaryHorizon,
    horizons: scenario.horizons,
    events,
    truncated: allEvents.length > MAX_EVENTS,
    lookbackDays: scenario.lookbackDays,
  };
}

// Is the pattern "active" on the latest bar — the condition the trader should
// act on now? Moving-average conditions are treated as the REGIME they identify
// (an "MA cross ↑" pattern is actionable while price is above that MA, not only
// on the single cross bar — otherwise rare crosses almost never coincide with
// "now" and the trader sits idle). Event conditions (a % move, a fair-value gap,
// an opening move) must have actually occurred within the recent `fresh` window.
function activeNow(conditions, bars, maCache, last, fresh) {
  for (const c of conditions) {
    if (c.kind === 'ma_cross' || c.kind === 'ma_state') {
      const ma = maCache.get(maKey(c));
      const cur = ma[last];
      if (cur == null) return false;
      if (c.dir === 'above' && !(bars[last].close > cur)) return false;
      if (c.dir === 'below' && !(bars[last].close < cur)) return false;
    } else {
      let hit = false;
      for (let i = last; i >= 1 && last - i <= fresh; i--) {
        if (conditionsMet([c], bars, maCache, i)) { hit = true; break; }
      }
      if (!hit) return false;
    }
  }
  return true;
}

// "Is this pattern actionable right now?" — for each symbol, returns a live entry
// at the CURRENT price (with a forward exit `primaryHorizon` bars ahead) when the
// pattern is active on the latest bar per `activeNow` above. Used by the
// autonomous Strategist to deploy capital into the regime a promoted pattern
// identifies, rather than waiting for a rare trigger bar to coincide with today.
export async function liveTriggers(scenario, provider) {
  const symbols = scenario.symbol ? [scenario.symbol] : sectorSymbols(scenario.sectorKey);
  const intraday = scenario.timeframe === 'intraday';
  const interval = intraday ? '30m' : '1d';
  const range = intraday ? intradayRange(scenario.lookbackDays) : fetchRange(scenario.lookbackDays);
  const barSeconds = intraday ? 1800 : 86400;
  const H = scenario.primaryHorizon;
  const FRESH = Math.min(Math.max(H, 1), 20); // how recent an event trigger still counts as "live"

  const maDefs = scenario.conditions
    .filter((c) => c.kind === 'ma_cross' || c.kind === 'ma_state')
    .map((c) => ({ key: maKey(c), period: c.period, type: c.maType }));

  const per = await mapLimit(symbols, 6, async (sym) => {
    const data = await provider.chart(sym, range, interval);
    const bars = cleanBars(data);
    if (bars.length < 30) return null;
    const maCache = new Map();
    for (const d of maDefs) if (!maCache.has(d.key)) maCache.set(d.key, movingAverage(bars, d.period, d.type));
    const shortMA = movingAverage(bars, ENTRY.maPeriod, 'sma');
    const last = bars.length - 1;
    if (!activeNow(scenario.conditions, bars, maCache, last, FRESH)) return null;
    if (!entryOk(bars, last, shortMA)) return null; // only enter on a pullback, never extended
    return {
      symbol: sym,
      barTime: bars[last].time, // dedup key: re-enter only when a new bar forms
      entryPrice: bars[last].close, // reference current price
      // How long to hold, in seconds. The caller schedules the exit as
      // entryTime + holdSeconds so the position is genuinely held for the horizon
      // (never off a stale last-bar timestamp that could already be in the past).
      holdSeconds: H * barSeconds,
    };
  });
  return per.filter(Boolean);
}

// Lower-level scanner used by the AI Trader: returns one signal per trigger with
// the entry (trigger bar) and the exit `primaryHorizon` bars later.
export async function collectSignals(scenario, provider) {
  const symbols = scenario.symbol ? [scenario.symbol] : sectorSymbols(scenario.sectorKey);
  const intraday = scenario.timeframe === 'intraday';
  const interval = intraday ? '30m' : '1d';
  const range = intraday ? intradayRange(scenario.lookbackDays) : fetchRange(scenario.lookbackDays);
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - scenario.lookbackDays * 86400;
  const H = scenario.primaryHorizon;

  const maDefs = scenario.conditions
    .filter((c) => c.kind === 'ma_cross' || c.kind === 'ma_state')
    .map((c) => ({ key: maKey(c), period: c.period, type: c.maType }));

  const per = await mapLimit(symbols, 6, async (sym) => {
    const data = await provider.chart(sym, range, interval);
    const bars = cleanBars(data);
    if (bars.length < 30) return [];
    const maCache = new Map();
    for (const d of maDefs) if (!maCache.has(d.key)) maCache.set(d.key, movingAverage(bars, d.period, d.type));

    const out = [];
    for (let i = 1; i < bars.length - 1; i++) {
      if (bars[i].time < cutoff) continue;
      if (!conditionsMet(scenario.conditions, bars, maCache, i)) continue;
      const j = i + H;
      out.push({
        symbol: sym,
        time: bars[i].time,
        entryPrice: bars[i].close,
        exitTime: j < bars.length ? bars[j].time : null,
        exitPrice: j < bars.length ? bars[j].close : null,
      });
    }
    return out;
  });
  return per.flat();
}
