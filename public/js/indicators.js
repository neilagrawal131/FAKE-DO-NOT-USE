// Pure technical-indicator math. Each function takes bars
// [{ time, open, high, low, close, volume }] and returns
// [{ time, value }] arrays aligned for Lightweight Charts line series.

// Exponential Moving Average, seeded with an SMA over the first `period` closes
// (the conventional approach). Bars before the seed are omitted.
export function ema(bars, period) {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = 0;

  // seed with SMA of first `period` closes
  let sum = 0;
  for (let i = 0; i < period; i++) sum += bars[i].close;
  prev = sum / period;
  out.push({ time: bars[period - 1].time, value: prev });

  for (let i = period; i < bars.length; i++) {
    prev = bars[i].close * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

// Simple Moving Average.
export function sma(bars, period) {
  if (bars.length < period) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= period) sum -= bars[i - period].close;
    if (i >= period - 1) out.push({ time: bars[i].time, value: sum / period });
  }
  return out;
}

// Volume-Weighted Average Price.
// For intraday data VWAP resets each trading day (standard behaviour). For
// multi-day/daily data it becomes an anchored VWAP over the whole range, which
// is the sensible generalisation.
export function vwap(bars, { intraday = true } = {}) {
  const out = [];
  let cumPV = 0;
  let cumV = 0;
  let currentDay = null;

  for (const b of bars) {
    if (intraday) {
      const day = dayKey(b.time);
      if (day !== currentDay) {
        currentDay = day;
        cumPV = 0;
        cumV = 0;
      }
    }
    const typical = (b.high + b.low + b.close) / 3;
    const vol = b.volume || 0;
    cumPV += typical * vol;
    cumV += vol;
    if (cumV > 0) out.push({ time: b.time, value: cumPV / cumV });
  }
  return out;
}

function dayKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}
