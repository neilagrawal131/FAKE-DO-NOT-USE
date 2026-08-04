// Overnight scheduler: once a day (after the US close) refresh the recent end of
// every symbol's history in our market database, so the store stays current
// without anyone re-running the backfill. Fetches straight from the upstream API
// (bypassing the read cache) and upserts the fresh bars.
//
// Runs inside the server process, so it only fires while the server is up — if
// you'd rather drive it from cron, run `npm run backfill` (or hit
// POST /api/marketdb/topup) on your own schedule instead.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertBars, dbStats, reconcileSplits } from './marketdb.js';
import { TARGET_SECTORS, sectorSymbols } from './universe.js';
import { saveJSON, loadJSON } from './store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = join(root, 'data', 'scheduler.json');

const TOPUP_HOUR = Number(process.env.MARKETDB_TOPUP_HOUR ?? 5); // UTC hour to run (default ~overnight US)
const TOPUP_RPM = Number(process.env.MARKETDB_TOPUP_RPM || 5); // requests/min (free tier = 5)
// Recent windows to refresh per symbol: latest daily bars + latest 30-min bars.
const WINDOWS = [
  ['1mo', '1d'],
  ['5d', '30m'],
];

let provider = null;
let splitsFn = null;
let running = false;
let timer = null;
let lastDay = null;
let lastResult = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

export function start(activeProvider, fetchSplits = null) {
  provider = activeProvider;
  splitsFn = fetchSplits;
  const st = loadJSON(STATE_FILE, () => ({})) || {};
  lastDay = st.lastTopUp || null;
  lastResult = st.lastResult || null;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 15 * 60 * 1000); // check every 15 min
  if (timer.unref) timer.unref();
  tick(); // also catch up if we boot after the hour and haven't run today
  console.log(`[scheduler] nightly DB top-up armed for ~${String(TOPUP_HOUR).padStart(2, '0')}:00 UTC`);
}

function tick() {
  if (!provider) return;
  const now = new Date();
  const day = today();
  if (now.getUTCHours() >= TOPUP_HOUR && lastDay !== day) {
    lastDay = day;
    topUp('scheduled');
  }
}

async function topUp(trigger = 'manual') {
  if (running || !provider) return lastResult;
  running = true;
  const startedAt = today();
  const symbols = [...new Set(TARGET_SECTORS.flatMap((k) => sectorSymbols(k)))];
  const delay = Math.max(0, Math.ceil(60000 / Math.max(1, TOPUP_RPM)));
  let refreshed = 0;
  let errors = 0;
  let splitsApplied = 0;
  console.log(`[scheduler] ${trigger} top-up starting · ${symbols.length} symbols`);
  for (const sym of symbols) {
    // Corporate actions first: back-adjust stored bars for any new split BEFORE
    // we refetch the recent window (which arrives already split-adjusted).
    if (splitsFn) {
      try {
        const applied = reconcileSplits(sym, await splitsFn(sym));
        if (applied.length) {
          splitsApplied += applied.length;
          console.log(`[scheduler] ${sym}: adjusted history for ${applied.length} split(s)`);
        }
      } catch {
        /* splits are best-effort */
      }
      await sleep(delay);
    }
    for (const [range, interval] of WINDOWS) {
      try {
        const data = await provider.chart(sym, range, interval);
        if (data && data.bars && data.bars.length) {
          upsertBars(sym, interval, data.bars);
          refreshed++;
        }
      } catch {
        errors++;
      }
      await sleep(delay);
    }
  }
  running = false;
  const s = dbStats();
  lastResult = { day: startedAt, trigger, symbols: symbols.length, refreshed, errors, splitsApplied, bars: s.bars, at: Math.floor(Date.now() / 1000) };
  saveJSON(STATE_FILE, { lastTopUp: lastDay, lastResult });
  console.log(`[scheduler] top-up done · ${refreshed} series · ${splitsApplied} split adjustments · ${errors} errors · db ${s.bars.toLocaleString()} bars`);
  return lastResult;
}

// Trigger a top-up immediately (manual / API), off the request path.
export function runNow() {
  if (running) return { started: false, running: true, last: lastResult };
  topUp('manual').catch((e) => console.warn('[scheduler] top-up error:', e.message));
  return { started: true, running: true, last: lastResult };
}

export function status() {
  return { hourUTC: TOPUP_HOUR, rpm: TOPUP_RPM, running, lastTopUpDay: lastDay, last: lastResult };
}
