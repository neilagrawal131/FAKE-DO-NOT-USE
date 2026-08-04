// Minute-bar backfill: walk the universe, page Polygon's minute aggregates into
// our own market database, and roll them up to 30-minute bars so the intraday
// backtester can scan them straight from the database — no more API calls.
//
// Usage:
//   node scripts/backfill.mjs                       # all target-sector symbols, 2 years of 1-min bars
//   node scripts/backfill.mjs --years 5 --rpm 100   # deeper history, faster (paid Polygon tier)
//   node scripts/backfill.mjs --symbols AAPL,MSFT   # just a couple of symbols
//
// Resumable: chunks already stored are skipped, so you can stop and restart it
// (e.g. run it overnight). Rate-limited to --rpm requests/minute (free tier = 5),
// and it backs off automatically on a 429.

import '../server/loadenv.js';
import * as polygon from '../market_data/polygon.js';
import { getBars, upsertBars, dbStats, dbBackend } from '../server/marketdb.js';
import { aggregateBars } from '../server/aggregate.js';
import { TARGET_SECTORS, sectorSymbols } from '../server/universe.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const years = Number(arg('years', 2));
const rpm = Number(arg('rpm', process.env.MARKETDB_BACKFILL_RPM || 5)); // requests/min (Polygon free tier = 5)
const chunkDays = Number(arg('chunk', 90));
const only = arg('symbols', '');
const delayMs = Math.max(0, Math.ceil(60000 / Math.max(1, rpm)));

if (!process.env.POLYGON_API_KEY) {
  console.error('POLYGON_API_KEY is not set — put it in .env. Aborting.');
  process.exit(1);
}

const symbols = only
  ? only.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  : [...new Set(TARGET_SECTORS.flatMap((k) => sectorSymbols(k)))];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d) => d.toISOString().slice(0, 10);
const DAY = 86400 * 1000;

const now = new Date();
const start = new Date(now.getTime() - years * 365 * DAY);
const startTs = Math.floor(start.getTime() / 1000);
const nowTs = Math.floor(now.getTime() / 1000);

const chunks = [];
for (let t = start.getTime(); t < now.getTime(); t += chunkDays * DAY) {
  chunks.push([new Date(t), new Date(Math.min(now.getTime(), t + chunkDays * DAY))]);
}

console.log(`[backfill] ${symbols.length} symbols · ${years}y · ${chunks.length} chunks each · ${rpm} req/min · ${dbBackend()} db`);
console.log(`[backfill] up to ${symbols.length * chunks.length} requests (~${Math.ceil((symbols.length * chunks.length * delayMs) / 60000)} min at this rate)\n`);

let fetched = 0;
let skipped = 0;
let errors = 0;

for (let si = 0; si < symbols.length; si++) {
  const sym = symbols[si];
  for (const [fromD, toD] of chunks) {
    const fromTs = Math.floor(fromD.getTime() / 1000);
    const toTs = Math.floor(toD.getTime() / 1000);
    if (getBars(sym, '1m', fromTs, toTs).length >= 200) {
      skipped++;
      continue; // already have this chunk — resume past it
    }
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      try {
        const bars = await polygon.barsBetween(sym, fmt(fromD), fmt(toD), { timespan: 'minute' });
        upsertBars(sym, '1m', bars);
        fetched++;
        done = true;
      } catch (e) {
        if (e.status === 429) {
          await sleep(delayMs * (attempt + 2)); // rate-limited — back off and retry
          continue;
        }
        errors++;
        console.warn(`  ! ${sym} ${fmt(fromD)}..${fmt(toD)}: ${e.message}`);
        break;
      }
    }
    await sleep(delayMs);
  }
  // Roll the minute bars up to 30-minute bars so the intraday backtester (which
  // requests 30m) reads deep history straight from our database.
  const all1m = getBars(sym, '1m', startTs, nowTs);
  if (all1m.length) upsertBars(sym, '30m', aggregateBars(all1m, { seconds: 1800 }));
  const st = dbStats();
  console.log(`[${si + 1}/${symbols.length}] ${sym.padEnd(6)} · 1m ${all1m.length.toLocaleString().padStart(9)} · db total ${st.bars.toLocaleString()} bars`);
}

const st = dbStats();
console.log(`\n[backfill] done · fetched ${fetched} chunks · skipped ${skipped} · errors ${errors}`);
console.log(`[backfill] database now holds ${st.bars.toLocaleString()} bars across ${st.symbols} symbols` + (st.from ? ` (${new Date(st.from * 1000).toISOString().slice(0, 10)} → ${new Date(st.to * 1000).toISOString().slice(0, 10)})` : ''));
