// Autonomous AI Strategist.
//
// Runs entirely on its own — no user interaction. On a timer it continuously:
//   1. EXPLORES the pattern space (a rotating set of scale-free "genes" — MA
//      crosses/states, momentum, dip-buys, fair-value-gaps — across every sector
//      universe) and EXPLOITS what already works by mutating the current best
//      genes (hill-climbing on parameters: MA period, horizon, % move, sector…).
//   2. SCORES each candidate by reward-vs-risk (a Sharpe-like ratio of average
//      forward return to its volatility) over real history.
//   3. VALIDATES candidates out-of-sample: before any pattern can go live it must
//      pass a cost-adjusted WALK-FORWARD test (tune on train, measure on the next
//      unseen window, rolling — with commission/spread/slippage subtracted). The
//      in-sample score is used only to rank what to explore; the OUT-OF-SAMPLE
//      score is what gates promotion, so the roster isn't built on overfitting.
//   4. RECONCILES the live roster: it promotes the top OOS-validated genes into
//      the AI Trader (owner: 'strategist') and demotes ones that fail (re)validation
//      or fall out of the top set — always raising reward while lowering risk.
//   5. TRADES them on the shared paper account via the AI Trader engine.
//
// It only ever touches strategies it owns (owner: 'strategist'); patterns the
// user added by hand in the AI Trader tab are left untouched.

import { simulatePattern } from './backtest.js';
import { walkForward } from './walkforward.js';
import { normalizeScenario } from './scenario.js';
import { TARGET_SECTORS, sectorLabel, sectorTarget, sectorStyle } from './universe.js';
import * as aitrader from './aitrader.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJSON, loadJSON } from './store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'data');
const FILE = join(DATA_DIR, 'strategist.json');

// --- tunables (env-overridable) ------------------------------------------------
const TICK_MS = Number(process.env.STRATEGIST_TICK_MS) || 10000; // one generation + trade tick (matches the 10s data cache)
const LOOKBACK_DAYS = 365; // history each scoring backtest sees
// Require a LOT of occurrences: we specifically want COMMON, frequently-triggering
// patterns that will actually be traded, not rare one-offs.
const MIN_SAMPLE = Number(process.env.STRATEGIST_MIN_SAMPLE) || 40;
const TARGET_ROSTER = Number(process.env.STRATEGIST_ROSTER) || 60; // how many patterns live at once (can be hundreds)
const RETAIN_MARGIN = Number(process.env.STRATEGIST_RETAIN_MARGIN) || 30; // hysteresis: keep a live pattern until it falls this far past the roster
const POOL_MAX = Number(process.env.STRATEGIST_POOL) || 300; // explore hundreds of patterns
const LOG_MAX = 140; // decision-log entries kept
const BATCH_SEEDS = 5; // fresh seed genes tested per generation
const BATCH_MUTANTS = 7; // mutations of current leaders tested per generation
// Minimum reward/risk score to qualify — a real profitability floor (positive
// expectancy per unit of risk), not just "> 0", so only patterns with a genuine
// edge get promoted to live trading.
const MIN_SCORE = Number.isFinite(Number(process.env.STRATEGIST_MIN_SCORE)) ? Number(process.env.STRATEGIST_MIN_SCORE) : 0.03;
// Position size per promoted pattern — small so the shared account's capital
// spreads across the whole (large) roster and many patterns actually deploy.
const STRAT_TRADE = Number(process.env.STRATEGIST_TRADE_USD) || 1200;

// --- out-of-sample validation gate ---------------------------------------------
// A pattern must clear these on UNSEEN, cost-adjusted, walk-forward data before it
// can be promoted (and it is periodically re-checked so a decayed edge is demoted).
const OOS_MIN_TRADES = Number(process.env.STRATEGIST_OOS_MIN_TRADES) || 20; // enough OOS trades to mean something
const OOS_MIN_SCORE = Number.isFinite(Number(process.env.STRATEGIST_OOS_MIN_SCORE)) ? Number(process.env.STRATEGIST_OOS_MIN_SCORE) : 0; // positive cost-adjusted expectancy
const OOS_TRAIN_DAYS = Number(process.env.STRATEGIST_OOS_TRAIN_DAYS) || 365; // walk-forward train window (calendar days)
const OOS_TEST_DAYS = Number(process.env.STRATEGIST_OOS_TEST_DAYS) || 180; // walk-forward test window
const VALIDATE_PER_CYCLE = Number(process.env.STRATEGIST_VALIDATE_PER_CYCLE) || 3; // OOS validations run per tick (cost control)
const REVALIDATE_EVERY = Number(process.env.STRATEGIST_REVALIDATE_EVERY) || 300; // re-check a live gene after this many generations

const UNIVERSES = TARGET_SECTORS; // rotate through every sector that has a diversification target

// Seed patterns — deliberately COMMON, frequently-triggering, and (importantly)
// defined as STATES/recent-events so the live entry the AI Trader takes matches
// what was backtested, keeping the measured edge honest. No rare one-bar crosses.
const SEEDS = [
  // Trend regimes — very common; backtest = state = live entry (consistent P&L).
  { conditions: [{ kind: 'ma_state', dir: 'above', maType: 'ema', period: 20 }], horizon: 5 },
  { conditions: [{ kind: 'ma_state', dir: 'above', maType: 'sma', period: 50 }], horizon: 10 },
  { conditions: [{ kind: 'ma_state', dir: 'above', maType: 'sma', period: 100 }], horizon: 10 },
  { conditions: [{ kind: 'ma_state', dir: 'above', maType: 'sma', period: 200 }], horizon: 20 },
  { conditions: [{ kind: 'ma_state', dir: 'above', maType: 'ema', period: 50 }], horizon: 10 },
  { conditions: [{ kind: 'ma_state', dir: 'below', maType: 'sma', period: 50 }], horizon: 10 },
  { conditions: [{ kind: 'ma_state', dir: 'below', maType: 'sma', period: 200 }], horizon: 20 },
  // Common momentum / dips — small daily moves happen constantly.
  { conditions: [{ kind: 'day_change', dir: 'up', pct: 1 }], horizon: 5 },
  { conditions: [{ kind: 'day_change', dir: 'up', pct: 2 }], horizon: 5 },
  { conditions: [{ kind: 'day_change', dir: 'down', pct: 1 }], horizon: 5 },
  { conditions: [{ kind: 'day_change', dir: 'down', pct: 2 }], horizon: 10 },
  // Fair-value gaps — moderately common; live entry requires a recent one.
  { conditions: [{ kind: 'fvg', dir: 'bullish', minPct: null }], horizon: 10 },
  { conditions: [{ kind: 'fvg', dir: 'bearish', minPct: null }], horizon: 10 },
];

// --- mutation search space -----------------------------------------------------
const MA_PERIODS = [10, 20, 30, 50, 100, 150, 200];
const MOVE_PCTS = [0.5, 1, 1.5, 2, 3]; // small (common) moves
const FVG_MINPCTS = [null, 0.25, 0.5, 1];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// Horizon comes from the sector's trading style: short for volatile sectors
// (trade the swings), long for stable sectors (hold long-term).
const pickHorizon = (sec) => pick(sectorStyle(sec).horizons);

// --- state ---------------------------------------------------------------------
let state = null;
let running = false;
let timer = null;
let provider = null;
let seq = 0;

function fresh() {
  return { enabled: true, generation: 0, lastCycle: 0, universeIndex: 0, pool: {}, log: [] };
}
function load() {
  if (state) return state;
  state = loadJSON(FILE, fresh) || fresh();
  if (typeof state.enabled !== 'boolean') state.enabled = true;
  if (!state.pool) state.pool = {};
  if (!Array.isArray(state.log)) state.log = [];
  if (typeof state.universeIndex !== 'number') state.universeIndex = 0;
  if (typeof state.generation !== 'number') state.generation = 0;
  return state;
}
function persist() {
  saveJSON(FILE, state);
}
function logEvent(type, label, detail) {
  const s = load();
  s.log.unshift({ ts: Math.floor(Date.now() / 1000), gen: s.generation, type, label, detail });
  if (s.log.length > LOG_MAX) s.log.length = LOG_MAX;
}

// --- genes ---------------------------------------------------------------------
function geneKey(gene) {
  return JSON.stringify({
    sec: gene.sectorKey,
    h: gene.horizon,
    c: gene.conditions.map((c) => ({ ...c })),
  });
}
function geneLabel(gene) {
  const c = gene.conditions[0] || {};
  let trig = 'pattern';
  if (c.kind === 'ma_cross') trig = `${c.period}-day ${c.maType.toUpperCase()} cross ${c.dir === 'above' ? '↑' : '↓'}`;
  else if (c.kind === 'ma_state') trig = `${c.dir} ${c.period}-day ${c.maType.toUpperCase()}`;
  else if (c.kind === 'day_change') trig = `${c.dir === 'up' ? '+' : '−'}${c.pct}% day`;
  else if (c.kind === 'fvg') trig = `${c.dir} FVG${c.minPct != null ? ` ≥${c.minPct}%` : ''}`;
  return `${trig} · ${sectorLabel(gene.sectorKey)} · ${gene.horizon}d`;
}
function geneScenario(gene) {
  return normalizeScenario({
    sectorKey: gene.sectorKey,
    lookbackDays: LOOKBACK_DAYS,
    timeframe: 'daily',
    primaryHorizon: gene.horizon,
    horizons: [1, 5, 10, 20, gene.horizon],
    conditions: gene.conditions.map((c) => ({ ...c })),
  });
}

// A signature that matches aitrader.signatureOf so we can map genes <-> the
// strategies we've promoted into the AI Trader.
function scenarioSig(sc) {
  return JSON.stringify({
    sym: sc.symbol || null,
    sec: sc.sectorKey || null,
    tf: sc.timeframe || 'daily',
    ph: sc.primaryHorizon,
    c: (sc.conditions || []).map((c) => ({ ...c })),
  });
}

// Produce a mutated child of a gene: exactly one heritable change.
function mutate(gene) {
  const child = { sectorKey: gene.sectorKey, horizon: gene.horizon, conditions: gene.conditions.map((c) => ({ ...c })) };
  const c = child.conditions[0];
  const ops = ['horizon', 'sector'];
  if (c.kind === 'ma_cross' || c.kind === 'ma_state') ops.push('period', 'dir', 'maType');
  if (c.kind === 'day_change') ops.push('pct', 'dir');
  if (c.kind === 'fvg') ops.push('minPct', 'dir');
  const op = pick(ops);
  if (op === 'horizon') child.horizon = pickHorizon(child.sectorKey);
  else if (op === 'sector') { child.sectorKey = pick(UNIVERSES); child.horizon = pickHorizon(child.sectorKey); } // re-fit horizon to the new sector's style
  else if (op === 'period') c.period = pick(MA_PERIODS);
  else if (op === 'maType') c.maType = c.maType === 'ema' ? 'sma' : 'ema';
  else if (op === 'pct') c.pct = pick(MOVE_PCTS);
  else if (op === 'minPct') c.minPct = pick(FVG_MINPCTS);
  else if (op === 'dir') {
    if (c.kind === 'day_change') c.dir = c.dir === 'up' ? 'down' : 'up';
    else if (c.kind === 'fvg') c.dir = c.dir === 'bullish' ? 'bearish' : 'bullish';
    else c.dir = c.dir === 'above' ? 'below' : 'above';
  }
  return child;
}

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
const scoreOf = (e) => (e && e.stats ? e.stats.score : -Infinity);
const oosScoreOf = (e) => (e && e.oos ? e.oos.score : -Infinity);
// In-sample qualification — used only to decide what is worth exploring and
// validating, NOT what goes live.
const qualifiesInSample = (e) => e && e.stats && e.stats.n >= MIN_SAMPLE && e.stats.mean > 0 && e.stats.score > MIN_SCORE;
// Live qualification — the real gate: it must also have passed the cost-adjusted
// out-of-sample walk-forward test.
const qualifiesLive = (e) =>
  qualifiesInSample(e) && e.oos && e.oos.n >= OOS_MIN_TRADES && e.oos.mean > 0 && e.oos.score > OOS_MIN_SCORE;

async function scoreGene(gene) {
  const scenario = geneScenario(gene);
  // Score the pattern the way it actually trades: dip entries + target/trailing/
  // stop/time exits, so the reward/risk ranking reflects real execution.
  const { returns, symbolsWithData } = await simulatePattern(scenario, provider);
  return { stats: summarize(returns), scenario, symbolsScanned: symbolsWithData };
}

// Out-of-sample validation of ONE gene: a cost-adjusted walk-forward test holding
// the gene's own horizon fixed (we're validating this exact pattern, not re-tuning
// it). Returns a summary of the unseen, net-of-cost returns (null if none).
async function validateGene(gene) {
  const scenario = geneScenario(gene);
  const wf = await walkForward(scenario, provider, {
    horizons: [gene.horizon],
    trainDays: OOS_TRAIN_DAYS,
    testDays: OOS_TEST_DAYS,
  });
  return summarize((wf && wf.oosReturns) || []);
}

// Validation pass: spend a small, bounded budget each cycle validating (or
// re-validating) in-sample-qualified genes out-of-sample. New candidates are
// validated before stale ones, highest in-sample score first — so promising
// discoveries earn (or fail) their live slot quickly.
async function validationPass() {
  const s = load();
  const candidates = Object.values(s.pool)
    .filter(qualifiesInSample)
    .filter((e) => !e.oos || s.generation - e.oos.gen > REVALIDATE_EVERY)
    .sort((a, b) => Number(!!a.oos) - Number(!!b.oos) || scoreOf(b) - scoreOf(a));

  let done = 0;
  for (const e of candidates) {
    if (done >= VALIDATE_PER_CYCLE) break;
    let oos;
    try {
      oos = await validateGene(e.gene);
    } catch {
      continue; // transient (data) error — retry next cycle, leave unvalidated
    }
    const wasLive = qualifiesLive(e);
    e.oos = oos
      ? { ...oos, gen: s.generation }
      : { n: 0, mean: 0, std: 0, winRate: 0, score: -Infinity, gen: s.generation };
    done += 1;
    const nowLive = qualifiesLive(e);
    if (nowLive && !wasLive) {
      logEvent('validate', e.label, `passed out-of-sample: ${e.oos.mean.toFixed(2)}% mean over ${e.oos.n} unseen trades (score ${e.oos.score.toFixed(3)}, after costs)`);
    } else if (!nowLive && wasLive) {
      logEvent('reject', e.label, `failed re-validation: out-of-sample ${e.oos.mean.toFixed(2)}% over ${e.oos.n} trades — no longer promotable`);
    } else if (!nowLive && !e._loggedFail) {
      e._loggedFail = true;
      logEvent('reject', e.label, oos ? `did not survive out-of-sample: ${e.oos.mean.toFixed(2)}% over ${e.oos.n} trades (after costs)` : 'no out-of-sample trades to validate on');
    }
  }
  return done;
}

// --- one generation: explore + exploit + score + prune -------------------------
async function runGeneration() {
  const s = load();
  const universe = UNIVERSES[s.universeIndex % UNIVERSES.length];
  s.universeIndex = (s.universeIndex + 1) % UNIVERSES.length;

  // EXPLORE: a rotating slice of seed genes, aimed at the current universe.
  const seedStart = (s.generation * BATCH_SEEDS) % SEEDS.length;
  const explore = [];
  for (let i = 0; i < BATCH_SEEDS; i++) {
    const seed = SEEDS[(seedStart + i) % SEEDS.length];
    // Horizon comes from the sector's style (short = volatile, long = stable),
    // not the seed's default.
    explore.push({ sectorKey: universe, horizon: pickHorizon(universe), conditions: seed.conditions.map((c) => ({ ...c })) });
  }

  // EXPLOIT: mutate the current best pool genes (hill-climbing).
  const leaders = Object.values(s.pool)
    .filter((e) => e.stats)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, 8)
    .map((e) => e.gene);
  const exploit = [];
  for (let i = 0; i < BATCH_MUTANTS; i++) {
    const base = leaders.length
      ? pick(leaders)
      : { sectorKey: universe, horizon: pickHorizon(universe), conditions: pick(SEEDS).conditions.map((c) => ({ ...c })) };
    exploit.push(mutate(base));
  }

  // Score the batch, deduped by gene key.
  const batch = [];
  const seen = new Set();
  for (const g of [...explore, ...exploit]) {
    const k = geneKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    batch.push(g);
  }

  let discovered = 0;
  for (const gene of batch) {
    const k = geneKey(gene);
    let scored;
    try {
      scored = await scoreGene(gene);
    } catch {
      continue;
    }
    const prev = s.pool[k];
    const wasQualified = prev && qualifiesInSample(prev);
    s.pool[k] = {
      gene,
      key: k,
      label: geneLabel(gene),
      stats: scored.stats,
      scenario: scored.scenario,
      symbolsScanned: scored.symbolsScanned,
      // Re-scored in-sample stats can change → its OOS verdict may be stale.
      // Preserve any prior OOS result; the validation pass refreshes it.
      oos: prev ? prev.oos : null,
      evals: (prev ? prev.evals : 0) + 1,
      lastSeen: Math.floor(Date.now() / 1000),
    };
    if (!wasQualified && qualifiesInSample(s.pool[k])) {
      discovered++;
      logEvent('discover', s.pool[k].label, `in-sample score ${scored.stats.score.toFixed(3)}, ${scored.stats.n} occ, mean ${scored.stats.mean.toFixed(2)}% — queued for out-of-sample validation`);
    }
  }

  // PRUNE: keep the pool bounded — drop the weakest genes once over capacity,
  // but never drop one that's currently promoted (part of the live roster).
  const activeKeys = ownedKeySet();
  const entries = Object.values(s.pool).sort((a, b) => scoreOf(b) - scoreOf(a));
  if (entries.length > POOL_MAX) {
    for (const e of entries.slice(POOL_MAX)) {
      if (activeKeys.has(e.key)) continue;
      delete s.pool[e.key];
    }
  }

  s.generation++;
  s.lastCycle = Math.floor(Date.now() / 1000);
  return discovered;
}

// --- roster reconciliation: add / remove / replace -----------------------------
// Map each strategist-owned AI Trader strategy back to its gene key.
function ownedStrategies() {
  return aitrader.strategies().filter((x) => x.owner === 'strategist');
}
function ownedKeySet() {
  const s = load();
  const bySig = new Map();
  for (const [k, e] of Object.entries(s.pool)) bySig.set(scenarioSig(e.scenario), k);
  const set = new Set();
  for (const st of ownedStrategies()) {
    const k = bySig.get(scenarioSig(st.scenario));
    if (k) set.add(k);
  }
  return set;
}

async function reconcile() {
  const s = load();

  // Allocate roster slots PER SECTOR in proportion to the sector's diversification
  // target, so every sector is represented and capital spreads to match the target
  // weights — instead of a few high-scoring sectors monopolizing the whole roster.
  // Only OUT-OF-SAMPLE-validated genes are eligible for the live roster, and they
  // are ranked by their out-of-sample (cost-adjusted) score — not the in-sample one.
  const perSector = {};
  for (const e of Object.values(s.pool)) {
    if (!qualifiesLive(e)) continue;
    const sec = e.gene.sectorKey;
    (perSector[sec] || (perSector[sec] = [])).push(e);
  }
  const desired = [];
  const keepSigs = new Set();
  for (const sec of UNIVERSES) {
    const slots = Math.max(1, Math.round(TARGET_ROSTER * (sectorTarget(sec) || 0)));
    const ranked = (perSector[sec] || []).sort((a, b) => oosScoreOf(b) - oosScoreOf(a));
    for (const e of ranked.slice(0, slots)) desired.push(e);
    // Hysteresis: keep a live pattern until it drops out of a wider per-sector band.
    const retain = slots + Math.max(2, Math.round(slots * 0.4));
    for (const e of ranked.slice(0, retain)) keepSigs.add(scenarioSig(e.scenario));
  }

  let owned = ownedStrategies();

  // DEMOTE: owned patterns that dropped out of the retention band. Their open
  // positions RIDE to their scheduled horizon exit (not liquidated) — replacing a
  // pattern must never dump fresh positions at ~the entry price.
  for (const st of owned) {
    if (!keepSigs.has(scenarioSig(st.scenario))) {
      await aitrader.removeStrategy(st.id, provider, { keepPositions: true });
      logEvent('demote', st.name.replace(/^Auto: /, ''), 'rotated out of the top set — open positions ride to their horizon');
    }
  }

  // PROMOTE: the per-sector desired patterns that aren't live yet.
  owned = ownedStrategies();
  const liveSigs = new Set(owned.map((st) => scenarioSig(st.scenario)));
  for (const e of desired) {
    if (liveSigs.has(scenarioSig(e.scenario))) continue;
    // Size by the OUT-OF-SAMPLE score (the validated edge), not the in-sample one.
    const added = aitrader.addStrategy(e.scenario, `Auto: ${e.label}`, 'strategist', true, STRAT_TRADE, e.oos.score);
    if (added) logEvent('promote', e.label, `promoted (${sectorLabel(e.gene.sectorKey)}) — out-of-sample ${e.oos.mean.toFixed(2)}% mean over ${e.oos.n} unseen trades, score ${e.oos.score.toFixed(3)}`);
  }
}

// --- the loop ------------------------------------------------------------------
async function cycle() {
  const s = load();
  if (!s.enabled || running || !provider) return;
  running = true;
  try {
    await runGeneration();
    await validationPass(); // gate: prove (or disprove) candidates out-of-sample
    await reconcile();
    // Trading itself is executed by the dedicated AI Trader engine loop (see
    // server/index.js startEngine), so we only discover + reconcile the roster here.
    persist();
  } catch (err) {
    console.error('[strategist] cycle error:', err.message);
  } finally {
    running = false;
  }
}

export function start(activeProvider) {
  provider = activeProvider;
  load();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { cycle(); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[strategist] autonomous engine started (tick ${TICK_MS}ms, roster ${TARGET_ROSTER})`);
}

export function setEnabled(enabled) {
  const s = load();
  s.enabled = Boolean(enabled);
  logEvent(s.enabled ? 'resume' : 'pause', 'Strategist', s.enabled ? 'autonomous trading resumed' : 'autonomous trading paused');
  persist();
  return s.enabled;
}

// Force a single generation immediately (used by the manual "run now" control).
export async function forceCycle() {
  await cycle();
  return getState();
}

// --- read model for the UI -----------------------------------------------------
export function getState() {
  const s = load();
  const activeSigs = new Set(ownedStrategies().map((st) => scenarioSig(st.scenario)));

  // Lead with genes that have passed out-of-sample validation, then in-sample
  // qualifiers, so proven patterns and tiny-sample flukes don't get confused.
  const leaderboard = Object.values(s.pool)
    .filter((e) => e.stats)
    .sort((a, b) => (qualifiesLive(b) - qualifiesLive(a)) || (qualifiesInSample(b) - qualifiesInSample(a)) || scoreOf(b) - scoreOf(a))
    .slice(0, 40)
    .map((e) => ({
      label: e.label,
      sector: sectorLabel(e.gene.sectorKey),
      horizon: e.gene.horizon,
      stats: e.stats,
      oos: e.oos || null, // out-of-sample verdict (null until validated)
      evals: e.evals,
      qualified: qualifiesInSample(e),
      oosValidated: !!e.oos,
      oosPassed: qualifiesLive(e),
      live: activeSigs.has(scenarioSig(e.scenario)),
    }));

  const roster = ownedStrategies().map((st) => {
    const e = Object.values(s.pool).find((p) => scenarioSig(p.scenario) === scenarioSig(st.scenario));
    return {
      id: st.id,
      name: st.name.replace(/^Auto: /, ''),
      enabled: st.enabled,
      stats: e ? e.stats : null,
      oos: e ? e.oos || null : null,
    };
  });

  return {
    enabled: s.enabled,
    running,
    generation: s.generation,
    lastCycle: s.lastCycle,
    tickMs: TICK_MS,
    poolSize: Object.keys(s.pool).length,
    qualified: Object.values(s.pool).filter(qualifiesInSample).length,
    qualifiedLive: Object.values(s.pool).filter(qualifiesLive).length,
    validated: Object.values(s.pool).filter((e) => e.oos).length,
    targetRoster: TARGET_ROSTER,
    minSample: MIN_SAMPLE,
    lookbackDays: LOOKBACK_DAYS,
    roster,
    leaderboard,
    log: s.log.slice(0, 40),
  };
}
