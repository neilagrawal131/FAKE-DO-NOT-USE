// Run the cross-sectional momentum backtest headless, against whatever data
// source is configured (Polygon for real data). Bars are served through the local
// SQLite database, so the FIRST run fetches + persists history (slow on a free
// Polygon plan — ~1 request/symbol, ~5/min) and every run after is instant.
//
//   npm run momentum                                  # broad universe, defaults
//   npm run momentum -- --universe technology         # one sector (20 names, fast)
//   npm run momentum -- --topK 15 --weighting equal --lookback 126
//
// Flags: --universe <all|sectorKey>  --topK <n>  --weighting <inversevol|equal>
//        --lookback <bars>  (252≈12mo, 189≈9mo, 126≈6mo)
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
const source = (process.env.DATA_SOURCE || (key ? 'polygon' : 'yahoo')).toLowerCase();
const upstream = source === 'mock' ? mock : source === 'polygon' ? polygon : yahoo;
// Mock bypasses the DB; real sources go through it so history persists locally.
const provider = source === 'mock' ? mock : withDatabase(upstream);

const config = {
  universe: flag('universe', 'all'),
  topK: Number(flag('topK', 20)),
  weighting: flag('weighting', 'inversevol'),
  lookbackBars: Number(flag('lookback', 252)),
};

const pct = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`);

console.log(`Data source: ${source}${source !== 'polygon' ? '  (⚠ not real Polygon data — results are illustrative)' : ''}`);
console.log(`Config: universe=${config.universe} topK=${config.topK} weighting=${config.weighting} lookback=${config.lookbackBars} bars`);
console.log('Loading universe history (first run may take a while on a free plan)…\n');

const res = await runMomentum(provider, config);
if (res.error) {
  console.error(`Failed: ${res.error}`, res.universe || '');
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
  console.log('OUT-OF-SAMPLE: inconclusive — not enough history for a walk-forward here.\n');
}

console.log('Portfolio it would hold now (top by momentum):');
console.log('  ' + (res.direct.latest || []).slice(0, 20).map((h) => `${h.symbol} ${h.weight}%`).join('  '));
process.exit(0);
