// Autonomous AI Strategist.
//
// Runs entirely on its own — no user interaction. On a timer it continuously:
//   1. EXPLORES the pattern space (a rotating set of scale-free "genes" — MA
//      crosses/states, momentum, dip-buys, fair-value-gaps — across every sector
//      universe) and EXPLOITS what already works by mutating the current best
//      genes (hill-climbing on parameters: MA period, horizon, % move, sector…).
//   2. SCORES each candidate by reward-vs-risk (a Sharpe-like ratio of average
//      forward return to its volatility) over real history.
//   3. RECONCILES the live roster: it promotes the top qualifying genes into the
//      AI Trader (owner: 'strategist') and demotes/removes ones that fall out of
//      the top set — so it is always adding, removing and replacing patterns to
//      raise reward while lowering risk.
//   4. TRADES them on the shared paper account via the AI Trader engine.
//
// It only ever touches strategies it owns (owner: 'strategist'); patterns the
// user added by hand in the AI Trader tab are left untouched.

import { runBacktest } from './backtest.js';
import { normalizeScenario } from './scenario.js';
import { SECTORS, sectorLabel } from './universe.js';
import * as aitrader from './aitrader.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'data');
const FILE = join(DATA_DIR, 'strategist.json');

// --- tunables (env-overridable) ------------------------------------------------
const TICK_MS = Number(process.env.STRATEGIST_TICK_MS) || 5000; // one generation + trade tick
const LOOKBACK_DAYS = 365; // history each scoring backtest sees
const MIN_SAMPLE = 15; // ignore patterns with too few occurrences to trust
const TARGET_ROSTER = Number(process.env.STRATEGIST_ROSTER) || 4; // how many live at once
const POOL_MAX = 48; // cap the gene pool so exploration stays bounded
const LOG_MAX = 80; // decision-log entries kept
const BATCH_SEEDS = 3; // fresh seed genes tested per generation
const BATCH_MUTANTS = 4; // mutations of current leaders tested per generation
const MIN_SCORE = 0; // a gene must beat this reward/risk score to qualify

const UNIVERSES = Object.keys(SECTORS); // rotate through every sector

// Scale-free seed patterns (no absolute price/volume thresholds) — the starting
// genome the strategist mutates from. Each is a gene: conditions + horizon.
const SEEDS = [
  { conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'ema', period: 20 }], horizon: 5 },
  { conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'ema', period: 50 }], horizon: 10 },
  { conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'sma', period: 100 }], horizon: 10 },
  { conditions: [{ kind: 'ma_cross', dir: 'above', maType: 'sma', period: 200 }], horizon: 20 },
  { conditions: [{ kind: 'ma_cross', dir: 'below', maType: 'sma', period: 50 }], horizon: 10 },
  { conditions: [{ kind: 'ma_state', dir: 'above', maType: 'sma', period: 200 }], horizon: 20 },
  { conditions: [{ kind: 'fvg', dir: 'bullish', minPct: null }], horizon: 10 },
  { conditions: [{ kind: 'fvg', dir: 'bullish', minPct: 1 }], horizon: 10 },
  { conditions: [{ kind: 'day_change', dir: 'up', pct: 3 }], horizon: 5 },
  { conditions: [{ kind: 'day_change', dir: 'down', pct: 3 }], horizon: 5 },
  { conditions: [{ kind: 'day_change', dir: 'down', pct: 5 }], horizon: 10 },
];

// --- mutation search space -----------------------------------------------------
const MA_PERIODS = [10, 20, 50, 100, 150, 200];
const HORIZONS = [1, 3, 5, 10, 20];
const MOVE_PCTS = [2, 3, 4, 5, 7];
const FVG_MINPCTS = [null, 0.5, 1, 2];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

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
  try {
    state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : fresh();
  } catch {
    state = fresh();
  }
  if (typeof state.enabled !== 'boolean') state.enabled = true;
  if (!state.pool) state.pool = {};
  if (!Array.isArray(state.log)) state.log = [];
  if (typeof state.universeIndex !== 'number') state.universeIndex = 0;
  if (typeof state.generation !== 'number') state.generation = 0;
  return state;
}
function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[strategist] persist failed:', err.message);
  }
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
  if (op === 'horizon') child.horizon = pick(HORIZONS);
  else if (op === 'sector') child.sectorKey = pick(UNIVERSES);
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
const qualifies = (e) => e && e.stats && e.stats.n >= MIN_SAMPLE && e.stats.mean > 0 && e.stats.score > MIN_SCORE;

async function scoreGene(gene) {
  const scenario = geneScenario(gene);
  const res = await runBacktest(scenario, provider);
  const rets = res.events.map((ev) => ev.returns[gene.horizon]).filter((r) => r != null);
  return { stats: summarize(rets), scenario, symbolsScanned: res.universe.symbolsWithData };
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
    explore.push({ sectorKey: universe, horizon: seed.horizon, conditions: seed.conditions.map((c) => ({ ...c })) });
  }

  // EXPLOIT: mutate the current best pool genes (hill-climbing).
  const leaders = Object.values(s.pool)
    .filter((e) => e.stats)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, 8)
    .map((e) => e.gene);
  const exploit = [];
  for (let i = 0; i < BATCH_MUTANTS; i++) {
    const base = leaders.length ? pick(leaders) : pick(SEEDS.map((seed) => ({ sectorKey: universe, ...seed })));
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
    const wasQualified = prev && qualifies(prev);
    s.pool[k] = {
      gene,
      key: k,
      label: geneLabel(gene),
      stats: scored.stats,
      scenario: scored.scenario,
      symbolsScanned: scored.symbolsScanned,
      evals: (prev ? prev.evals : 0) + 1,
      lastSeen: Math.floor(Date.now() / 1000),
    };
    if (!wasQualified && qualifies(s.pool[k])) {
      discovered++;
      logEvent('discover', s.pool[k].label, `score ${scored.stats.score.toFixed(3)}, ${scored.stats.n} occ, mean ${scored.stats.mean.toFixed(2)}%`);
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

  // Desired live set = the top qualifying genes by reward/risk.
  const desired = Object.values(s.pool)
    .filter(qualifies)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, TARGET_ROSTER);
  const desiredSigs = new Map(desired.map((e) => [scenarioSig(e.scenario), e]));

  const owned = ownedStrategies();
  const ownedSigs = new Map(owned.map((st) => [scenarioSig(st.scenario), st]));

  // DEMOTE / REMOVE: any owned pattern no longer in the desired set.
  for (const st of owned) {
    const sig = scenarioSig(st.scenario);
    if (!desiredSigs.has(sig)) {
      await aitrader.removeStrategy(st.id, provider);
      logEvent('demote', st.name.replace(/^Auto: /, ''), 'fell out of the top reward/risk set — removed & positions liquidated');
    }
  }

  // PROMOTE / ADD: any desired pattern not already live.
  for (const e of desired) {
    const sig = scenarioSig(e.scenario);
    if (ownedSigs.has(sig)) continue;
    const added = aitrader.addStrategy(e.scenario, `Auto: ${e.label}`, 'strategist', true);
    if (added) logEvent('promote', e.label, `promoted to live trading — score ${e.stats.score.toFixed(3)}, win ${e.stats.winRate.toFixed(0)}%`);
  }
}

// --- the loop ------------------------------------------------------------------
async function cycle() {
  const s = load();
  if (!s.enabled || running || !provider) return;
  running = true;
  try {
    await runGeneration();
    await reconcile();
    await aitrader.evaluate(provider); // execute triggers / close matured positions
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

  // Lead with genes that actually qualify to trade (enough sample + edge), so
  // tiny-sample flukes with a huge score don't dominate the view.
  const leaderboard = Object.values(s.pool)
    .filter((e) => e.stats)
    .sort((a, b) => (qualifies(b) - qualifies(a)) || scoreOf(b) - scoreOf(a))
    .slice(0, 12)
    .map((e) => ({
      label: e.label,
      sector: sectorLabel(e.gene.sectorKey),
      horizon: e.gene.horizon,
      stats: e.stats,
      evals: e.evals,
      qualified: qualifies(e),
      live: activeSigs.has(scenarioSig(e.scenario)),
    }));

  const roster = ownedStrategies().map((st) => {
    const e = Object.values(s.pool).find((p) => scenarioSig(p.scenario) === scenarioSig(st.scenario));
    return {
      id: st.id,
      name: st.name.replace(/^Auto: /, ''),
      enabled: st.enabled,
      stats: e ? e.stats : null,
    };
  });

  return {
    enabled: s.enabled,
    running,
    generation: s.generation,
    lastCycle: s.lastCycle,
    tickMs: TICK_MS,
    poolSize: Object.keys(s.pool).length,
    qualified: Object.values(s.pool).filter(qualifies).length,
    targetRoster: TARGET_ROSTER,
    minSample: MIN_SAMPLE,
    lookbackDays: LOOKBACK_DAYS,
    roster,
    leaderboard,
    log: s.log.slice(0, 40),
  };
}
