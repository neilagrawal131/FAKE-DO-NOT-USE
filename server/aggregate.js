// Resamples OHLCV bars into larger candles. Used for intervals the upstream
// feed doesn't offer natively (10m, 3h, 6mo, 1y, 5y): we fetch the nearest finer
// native interval and bucket it here so one candle = exactly the requested span.
//
// agg is one of:
//   { seconds: N }        — fixed-width time buckets (intraday multiples)
//   { calendar: 'unit' }  — calendar buckets: 'halfyear' | 'year' | 'fiveyear'

export function aggregateBars(bars, agg) {
  if (!agg || bars.length === 0) return bars;

  const keyFn = agg.seconds
    ? (b) => Math.floor(b.time / agg.seconds) * agg.seconds
    : (b) => calendarKey(b.time, agg.calendar);

  const groups = new Map();
  for (const b of bars) {
    const k = keyFn(b);
    let g = groups.get(k);
    if (!g) {
      g = [];
      groups.set(k, g);
    }
    g.push(b);
  }

  const out = [];
  for (const [k, gb] of groups) {
    const first = gb[0];
    const last = gb[gb.length - 1];
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const b of gb) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume || 0;
    }
    out.push({
      // Intraday buckets are anchored to the bucket start; calendar buckets use
      // the first constituent bar's timestamp. Both are unique and ascending.
      time: agg.seconds ? Number(k) : first.time,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function calendarKey(unixSec, unit) {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0-11
  if (unit === 'halfyear') return `${y}-${Math.floor(m / 6)}`;
  if (unit === 'fiveyear') return `${Math.floor(y / 5)}`;
  return `${y}`; // year
}
