// Run the cross-sectional momentum backtest headless, against whatever data
// source is configured (Polygon for real data). Bars are served through the local
// SQLite database, so the FIRST run fetches + persists history (slow on a free
// Polygon plan — ~1 request/symbol, ~5/min) and every run after is instant.
//
//   npm run momentum                                  # broad universe, defaults
//   npm run momentum -- --universe technology         # one sector (20 names)
//   npm run momentum -- --topK 15 --weighting equal --lookback 126
//   npm run momentum -- --rpm 100                      # paid Polygon tier: go fast
//   npm run momentum -- --source yahoo                 # DEEP history (decades, free)
//
// Flags: --universe <all|sectorKey>  --topK <n>  --weighting <inversevol|equal>
//        --lookback <bars>  (252≈12mo, 189≈9mo, 126≈6mo)
//        --source <polygon|yahoo|mock>  data source for this run (overrides .env).
//                   Polygon free tier = ~2y history (too short for a walk-forward);
//                   `yahoo` gives decades of free daily bars — use it to validate.
//        --rpm <n>  requests/min cap for the FIRST download (Polygon free tier = 5;
//                   raise it on a paid plan). Cached symbols are never throttled.
import '../server/loadenv.js';
import { withDatabase } from '../server/marketdb.js';
import * as polygon from '../market_data/polygon.js';
import * as yahoo from '../server/yahoo.js';
import * as mock from '../server/mock.js';
import { runMomentum } from '../server/momentum.js';

function flag(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const key = process.env.POLYGON_API_KEY;
// --source overrides DATA_SOURCE for this run. Use `yahoo` for DEEP history:
// Polygon's free tier only serves ~2 years (too short for a walk-forward), while
// Yahoo returns decades of free daily bars — enough to test across market regimes.
const source = flag('source', process.env.DATA_SOURCE || (key ? 'polygon' : 'yahoo')).toLowerCase();
const upstream = source === 'mock' ? mock : source === 'polygon' ? polygon : yahoo;
// Mock bypasses the DB; real sources go through it so history persists locally.
// The source label makes the DB cache per-source, so switching source re-fetches.
const provider = source === 'mock' ? mock : withDatabase(upstream, { source });

// Rate cap for the first download. Mock/Yahoo don't need it; default to the
// Polygon free-tier limit (5/min) so the first run doesn't 429 itself to death.
const rpm = source === 'polygon' ? Number(flag('rpm', 5)) : 0;

const config = {
  universe: flag('universe', 'all'),
  topK: Number(flag('topK', 20)),
  weighting: flag('weighting', 'inversevol'),
  lookbackBars: Number(flag('lookback', 252)),
  rpm,
  onSkip: (sym, why) => console.log(`  · skipped ${sym}: ${why}`),
};

const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);

console.log(`Data source: ${source}${source !== 'polygon' ? '  (⚠ not real Polygon data — results are illustrative)' : ''}`);
console.log(`Config: universe=${config.universe} topK=${config.topK} weighting=${config.weighting} lookback=${config.lookbackBars} bars${rpm ? ` · ${rpm} req/min cap` : ''}`);
if (rpm && rpm <= 5) console.log(`First run downloads each new symbol at ~${rpm}/min (free-tier safe) and persists it locally; later runs read from the DB instantly. Pass --rpm 100 on a paid plan.`);
console.log('Loading universe history…\n');

const res = await runMomentum(provider, config);
if (res.error) {
  if (res.error === 'insufficient_universe') {
    console.error(`\nFailed: only ${res.universe.symbolsWithData}/${res.universe.symbolsRequested} symbols loaded — not enough to backtest.`);
    console.error('Likely Polygon rate-limiting on a free plan. Re-run to let the local DB keep filling, lower the rate with a smaller universe, or use --rpm on a paid plan.');
  } else {
    console.error(`Failed: ${res.error}`, res.universe || '');
  }
  process.exit(1);
}

const is = res.direct.summary;
const oos = res.walkforward && !res.walkforward.error ? res.walkforward.summary : null;

console.log(`Universe: ${res.universe.symbolsWithData}/${res.universe.symbolsRequested} — ${res.universe.label}`);
console.log(`History:  ${res.span.from ? new Date(res.span.from * 1000).toISOString().slice(0, 10) : '?'} → ${res.span.to ? new Date(res.span.to * 1000).toISOString().slice(0, 10) : '?'}\n`);

console.log('IN-SAMPLE (full history — optimistic, not the verdict):');
console.log(`  return/yr ${pct(is.annReturn)} · Sharpe ${is.annSharpe.toFixed(2)} · vol ${is.annVol.toFixed(1)}% · maxDD ${is.maxDrawdown.toFixed(1)}% · ${is.n} months\n`);

if (oos && oos.n >= 6) {
  const verdict =
    oos.annReturn > 0 && oos.annSharpe >= 0.5 ? 'EDGE SURVIVES out-of-sample'
      : oos.annReturn > 0 ? 'WEAK / unproven out-of-sample'
        : 'NO EDGE survives costs + out-of-sample';
  console.log('OUT-OF-SAMPLE (walk-forward, cost-adjusted — the number that matters):');
  console.log(`  return/yr ${pct(oos.annReturn)} · Sharpe ${oos.annSharpe.toFixed(2)} · maxDD ${oos.maxDrawdown.toFixed(1)}% · ${oos.n} months over ${res.walkforward.folds.length} windows`);
  console.log(`  → ${verdict}\n`);
} else {
  const years = res.span.from && res.span.to ? ((res.span.to - res.span.from) / (365 * 86400)).toFixed(1) : '?';
  console.log(`OUT-OF-SAMPLE: inconclusive — only ~${years}y of history (a walk-forward needs ~3y+).`);
  if (source === 'polygon') {
    console.log("Polygon's free tier caps history at ~2 years. For a real out-of-sample test, re-run with deep, free history:");
    console.log('  npm run momentum -- --universe technology --source yahoo\n');
  } else {
    console.log('Widen the history or universe and re-run.\n');
  }
}

console.log('Portfolio it would hold now (top by momentum):');
console.log('  ' + (res.direct.latest || []).slice(0, 20).map((h) => `${h.symbol} ${h.weight}%`).join('  '));
process.exit(0);
