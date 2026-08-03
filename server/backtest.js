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

// "Is this pattern actionable right now?" — for each symbol, finds the most
// recent trigger within its holding window (the last `primaryHorizon` bars, so a
// trade opened at that trigger would still be open) and, if found, returns a live
// entry at the CURRENT price with a forward exit scheduled `primaryHorizon` bars
// ahead. Used by the autonomous Strategist to open real positions as soon as a
// promoted pattern is active — without replaying old, already-closed history.
export async function liveTriggers(scenario, provider) {
  const symbols = scenario.symbol ? [scenario.symbol] : sectorSymbols(scenario.sectorKey);
  const intraday = scenario.timeframe === 'intraday';
  const interval = intraday ? '30m' : '1d';
  const range = intraday ? intradayRange(scenario.lookbackDays) : fetchRange(scenario.lookbackDays);
  const barSeconds = intraday ? 1800 : 86400;
  const H = scenario.primaryHorizon;
  const FRESH = Math.min(Math.max(H, 1), 20); // how recent a trigger still counts as "live"

  const maDefs = scenario.conditions
    .filter((c) => c.kind === 'ma_cross' || c.kind === 'ma_state')
    .map((c) => ({ key: maKey(c), period: c.period, type: c.maType }));

  const per = await mapLimit(symbols, 6, async (sym) => {
    const data = await provider.chart(sym, range, interval);
    const bars = cleanBars(data);
    if (bars.length < 30) return null;
    const maCache = new Map();
    for (const d of maDefs) if (!maCache.has(d.key)) maCache.set(d.key, movingAverage(bars, d.period, d.type));
    const last = bars.length - 1;
    // Most recent bar (within the fresh window) where the pattern fired.
    let trigIdx = -1;
    for (let i = last; i >= 1 && last - i <= FRESH; i--) {
      if (conditionsMet(scenario.conditions, bars, maCache, i)) { trigIdx = i; break; }
    }
    if (trigIdx === -1) return null;
    return {
      symbol: sym,
      barTime: bars[trigIdx].time, // dedup key: this specific trigger
      entryPrice: bars[last].close, // enter at the current price
      // Hold horizon bars forward from the latest bar; closed at market later.
      exitDueTime: bars[last].time + H * barSeconds,
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
