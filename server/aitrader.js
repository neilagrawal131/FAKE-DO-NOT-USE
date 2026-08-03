// Algorithmic trader that runs on the SAME paper account as the manual Trade
// tab. It holds a list of user-approved "patterns" (scenarios promoted from the
// AI Analyst) and, going forward from when each pattern was added, places real
// orders on the shared portfolio: a buy when a pattern triggers, and a sell when
// the pattern's forward horizon elapses. Because it executes on the shared
// account, its trades show up in the Trade tab's positions, cash, P&L and order
// history automatically (tagged source: 'ai').
//
// It keeps its own ledger only for dedup (execute each signal once) and for the
// AI Trader tab's pattern-level stats.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSignals, liveTriggers } from './backtest.js';
import { describeScenario } from './scenario.js';
import { sectorLabel, symbolSector, sectorTarget, SECTOR_TARGETS } from './universe.js';
import * as portfolio from './portfolio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'data');
const FILE = join(DATA_DIR, 'aitrader.json');

const DEFAULT_TRADE = 5_000; // dollars committed per signal
const MAX_SIGNALS_PER_STRATEGY = 60;

let state = null;
let seq = 0;

function load() {
  if (state) return state;
  try {
    state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
  } catch {
    state = {};
  }
  if (!Array.isArray(state.strategies)) state.strategies = [];
  if (!state.entries) state.entries = {}; // signalId -> shares (executed buys)
  if (!state.exits) state.exits = {}; // signalId -> true (executed sells)
  if (!state.trades) state.trades = {}; // signalId -> trade record (AI ledger)
  return state;
}
function persist() {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[aitrader] persist failed:', err.message);
  }
}

function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n}`;
}
function shortName(sc) {
  const scope = sc.symbol || sectorLabel(sc.sectorKey);
  const unit = sc.timeframe === 'intraday' ? 'bar' : 'day';
  const c = sc.conditions[0];
  let trig = 'pattern';
  if (c) {
    if (c.kind === 'ma_cross') trig = `${c.dir === 'above' ? '↑' : '↓'} ${c.period}-${unit} ${c.maType.toUpperCase()} cross`;
    else if (c.kind === 'ma_state') trig = `${c.dir} ${c.period}-${unit} ${c.maType.toUpperCase()}`;
    else if (c.kind === 'volume') trig = `vol ${c.op} ${compact(c.value)}`;
    else if (c.kind === 'day_change') trig = `${c.dir} ${c.pct}% move`;
    else if (c.kind === 'opening_move') trig = `open ${c.dir === 'up' ? '+' : '-'}${c.pct}%`;
    else if (c.kind === 'fvg') trig = `${c.dir} FVG`;
  }
  const more = sc.conditions.length > 1 ? ` +${sc.conditions.length - 1}` : '';
  return `${scope} · ${trig}${more}`;
}
function fmtTime(t, intraday) {
  const d = new Date(t * 1000);
  return intraday ? d.toISOString().slice(0, 16).replace('T', ' ') : d.toISOString().slice(0, 10);
}
function sigId(strategyId, symbol, time) {
  return `${strategyId}|${symbol}|${time}`;
}

// ---- strategy CRUD ----
// A stable signature so we don't add the same pattern twice.
function signatureOf(sc) {
  return JSON.stringify({
    sym: sc.symbol || null,
    sec: sc.sectorKey || null,
    tf: sc.timeframe || 'daily',
    ph: sc.primaryHorizon,
    c: (sc.conditions || []).map((c) => ({ ...c })),
  });
}
export function hasStrategy(scenario) {
  const s = load();
  const sig = signatureOf(scenario);
  return s.strategies.some((x) => signatureOf(x.scenario) === sig);
}

// Lightweight list of strategies (used by the autonomous Strategist to manage
// only the patterns it owns).
export function strategies() {
  return load().strategies.map((x) => ({ id: x.id, name: x.name, owner: x.owner || 'user', scenario: x.scenario, enabled: x.enabled }));
}

// Returns true if added, false if an identical pattern already exists.
// `liveEntry` patterns also open a position immediately whenever the pattern is
// triggering on the current bar (used by the autonomous Strategist so it trades
// as soon as a pattern is live, instead of waiting for a brand-new trigger bar).
export function addStrategy(scenario, name, owner = 'user', liveEntry = false, tradeAmount = DEFAULT_TRADE) {
  const s = load();
  if (hasStrategy(scenario)) return false;
  seq += 1;
  s.strategies.push({
    id: `s${Date.now()}${seq}`,
    name: name || shortName(scenario),
    scenario,
    enabled: true,
    owner,
    liveEntry,
    tradeAmount: tradeAmount || DEFAULT_TRADE,
    createdAt: Math.floor(Date.now() / 1000),
  });
  persist();
  return true;
}
export function setEnabled(id, enabled) {
  const s = load();
  const st = s.strategies.find((x) => x.id === id);
  if (st) st.enabled = enabled;
  persist();
}
// Removing a pattern liquidates its open positions on the shared account. Its
// CLOSED trades are kept (as history) so realized P&L survives the autonomous
// Strategist constantly promoting/replacing patterns; only leftover pending
// entry markers for this strategy are cleared. The ledger is pruned separately.
export async function removeStrategy(id, provider, opts = {}) {
  const s = load();
  await liquidateStrategy(id, provider);
  s.strategies = s.strategies.filter((x) => x.id !== id);
  if (opts.purge) {
    // Hard removal (manual "remove"): drop this pattern's trades entirely.
    for (const [sid, t] of Object.entries(s.trades)) {
      if (t.strategyId === id) delete s.trades[sid];
    }
  }
  pruneLedger();
  persist();
}

// Keep the ledger bounded: retain all open trades plus the most recent closed
// ones. Prunes matching entry/exit markers too.
function pruneLedger() {
  const s = load();
  const closed = Object.values(s.trades).filter((t) => t.status === 'closed').sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0));
  const KEEP = 600;
  for (const t of closed.slice(KEEP)) {
    delete s.trades[t.id];
    delete s.entries[t.id];
    delete s.exits[t.id];
  }
}
export async function reset(provider) {
  const s = load();
  for (const st of s.strategies) await liquidateStrategy(st.id, provider);
  state = { strategies: [], entries: {}, exits: {}, trades: {} };
  persist();
}

async function liquidateStrategy(id, provider) {
  const s = load();
  for (const t of Object.values(s.trades)) {
    if (t.strategyId !== id || t.status !== 'open') continue;
    let price = t.entryPrice;
    try {
      price = (await provider.lastPrice(t.symbol)).price || price;
    } catch {
      /* use entry as fallback */
    }
    sellOut(t, price, Math.floor(Date.now() / 1000));
  }
}

function sellOut(trade, price, ts) {
  const s = load();
  try {
    portfolio.trade({ side: 'sell', symbol: trade.symbol, shares: trade.shares, price, ts, source: 'ai', strategyId: trade.strategyId, strategyName: trade.strategyName });
  } catch {
    /* shares may already be gone; still close the AI record */
  }
  s.exits[trade.id] = true;
  trade.status = 'closed';
  trade.exitTime = ts;
  trade.exitDate = fmtTime(ts, trade.intraday);
  trade.exitPrice = price;
  trade.pnl = (price - trade.entryPrice) * trade.shares;
  trade.pnlPct = ((price - trade.entryPrice) / trade.entryPrice) * 100;
}

// ---- the engine: execute pending entries/exits on the shared account ----
// Guarded so overlapping callers (background loop, strategist, manual actions)
// can't run the heavy scan concurrently and pile up provider requests.
let evaluating = false;
export async function evaluate(provider) {
  if (evaluating) return;
  evaluating = true;
  try {
    await runEvaluate(provider);
  } finally {
    evaluating = false;
  }
}

async function runEvaluate(provider) {
  const s = load();
  const hasEnabled = s.strategies.some((x) => x.enabled);
  const hasOpen = Object.values(s.trades).some((t) => t.status === 'open');
  if (!hasEnabled && !hasOpen) return;

  const openStratIds = new Set(Object.values(s.trades).filter((t) => t.status === 'open').map((t) => t.strategyId));
  // Historical forward-only scan is only for NON-live-entry (user-added) patterns.
  // Live-entry (Strategist) patterns enter via the live pass and exit on their
  // wall-clock horizon, so we skip the expensive per-strategy history scan for
  // them — essential now that the roster can be dozens/hundreds of patterns.
  const scan = s.strategies.filter((x) => !x.liveEntry && (x.enabled || openStratIds.has(x.id)));

  // ---- diversification budget ------------------------------------------------
  // Keep the AI's deployed capital within the target weight for each sector. We
  // measure current exposure at market value, attribute every held symbol to one
  // canonical sector, and only allow a buy up to (target% x equity) for its
  // sector — sizing the order down to whatever room is left.
  const acct = portfolio.getState();
  const heldSyms = Object.keys(acct.positions);
  const priceOf = {};
  await Promise.all(
    heldSyms.map(async (sym) => {
      try {
        priceOf[sym] = (await provider.lastPrice(sym)).price || acct.positions[sym].avgCost;
      } catch {
        priceOf[sym] = acct.positions[sym].avgCost;
      }
    })
  );
  let equity = acct.cash;
  const exposure = {}; // sectorKey -> market value currently held
  for (const [sym, pos] of Object.entries(acct.positions)) {
    const mv = pos.shares * (priceOf[sym] || pos.avgCost);
    equity += mv;
    const sec = symbolSector(sym);
    if (sec) exposure[sec] = (exposure[sec] || 0) + mv;
  }
  // Shares of `symbol` we may buy at `price` without breaching its sector cap.
  const fitShares = (symbol, price, desiredAmount) => {
    const sec = symbolSector(symbol);
    const target = sec ? sectorTarget(sec) : null;
    if (target == null) return Math.floor(desiredAmount / price); // no target: cash-limited only
    const room = target * equity - (exposure[sec] || 0);
    if (room <= 0) return 0;
    return Math.floor(Math.min(desiredAmount, room) / price);
  };
  const noteBuy = (symbol, shares, price) => {
    const sec = symbolSector(symbol);
    if (sec) exposure[sec] = (exposure[sec] || 0) + shares * price;
  };

  // Collect forward-only signals per scanned strategy, and index them by id so
  // exits can be looked up as new horizon bars appear.
  const sigByStrat = {};
  const sigIndex = {};
  for (const strat of scan) {
    let sig = [];
    try {
      sig = await collectSignals(strat.scenario, provider);
    } catch {
      sig = [];
    }
    const activatedAt = strat.createdAt || 0;
    const filtered = sig.filter((g) => g.time >= activatedAt);
    sigByStrat[strat.id] = filtered;
    for (const g of filtered) sigIndex[sigId(strat.id, g.symbol, g.time)] = g;
  }

  const openTrades = () => Object.values(s.trades).filter((t) => t.status === 'open');

  // Close any open position whose forward-horizon bar exists and is at/before
  // `uptoTime` (used inline so cash frees up chronologically within one pass).
  const closeMatured = (uptoTime) => {
    for (const t of openTrades()) {
      const g = sigIndex[t.id];
      const exitTime = g ? g.exitTime : t.exitDueTime;
      const exitPrice = g ? g.exitPrice : t.exitDuePrice;
      if (exitPrice != null && exitTime != null && exitTime <= uptoTime) sellOut(t, exitPrice, exitTime);
    }
  };

  // Single chronological pass: entry candidates (enabled patterns), oldest-first,
  // closing matured positions before each so buying power recycles like real life.
  const candidates = [];
  for (const strat of s.strategies.filter((x) => x.enabled && !x.liveEntry)) {
    const intraday = strat.scenario.timeframe === 'intraday';
    for (const g of (sigByStrat[strat.id] || []).slice(-MAX_SIGNALS_PER_STRATEGY)) {
      const id = sigId(strat.id, g.symbol, g.time);
      if (s.entries[id]) continue;
      candidates.push({ id, strat, g, intraday });
    }
  }
  candidates.sort((a, b) => a.g.time - b.g.time);

  for (const { id, strat, g, intraday } of candidates) {
    closeMatured(g.time);
    const price = g.entryPrice;
    if (!(price > 0)) continue;
    if (openTrades().some((t) => t.strategyId === strat.id && t.symbol === g.symbol)) continue;
    const shares = fitShares(g.symbol, price, strat.tradeAmount || DEFAULT_TRADE);
    if (shares < 1) continue; // sector already at its target weight — stay diversified
    try {
      portfolio.trade({ side: 'buy', symbol: g.symbol, shares, price, ts: g.time, source: 'ai', strategyId: strat.id, strategyName: strat.name });
    } catch {
      continue; // insufficient cash — leave unmarked so it can retry later
    }
    noteBuy(g.symbol, shares, price);
    s.entries[id] = shares;
    s.trades[id] = {
      id, strategyId: strat.id, strategyName: strat.name, symbol: g.symbol, shares,
      entryTime: g.time, entryDate: fmtTime(g.time, intraday), entryPrice: price,
      exitDueTime: g.exitTime, exitDuePrice: g.exitPrice,
      exitTime: null, exitDate: null, exitPrice: null, status: 'open', pnl: null, pnlPct: null, intraday,
    };
  }

  // Final sweep: close anything whose horizon bar now exists (up to now).
  closeMatured(Math.floor(Date.now() / 1000));

  // ---- live-entry pass (Strategist patterns) --------------------------------
  // Open a position NOW, at the current price, for any live-entry pattern that is
  // triggering on its most recent bar and has no open position for that symbol.
  const liveStrats = s.strategies.filter((x) => x.enabled && x.liveEntry);
  for (const strat of liveStrats) {
    let triggers = [];
    try {
      triggers = await liveTriggers(strat.scenario, provider);
    } catch {
      triggers = [];
    }
    const intraday = strat.scenario.timeframe === 'intraday';
    for (const t of triggers) {
      const id = sigId(strat.id, t.symbol, `live-${t.barTime}`);
      if (s.entries[id]) continue; // already acted on this exact trigger bar
      if (openTrades().some((o) => o.strategyId === strat.id && o.symbol === t.symbol)) continue;
      const price = t.entryPrice;
      if (!(price > 0)) continue;
      const shares = fitShares(t.symbol, price, strat.tradeAmount || DEFAULT_TRADE);
      if (shares < 1) continue; // sector already at its target weight — stay diversified
      const now = Math.floor(Date.now() / 1000);
      try {
        portfolio.trade({ side: 'buy', symbol: t.symbol, shares, price, ts: now, source: 'ai', strategyId: strat.id, strategyName: strat.name });
      } catch {
        continue; // insufficient cash — retry on a later tick
      }
      noteBuy(t.symbol, shares, price);
      s.entries[id] = shares;
      s.trades[id] = {
        id, strategyId: strat.id, strategyName: strat.name, symbol: t.symbol, shares,
        entryTime: now, entryDate: fmtTime(now, intraday), entryPrice: price,
        exitDueTime: t.exitDueTime, exitDuePrice: null, live: true,
        exitTime: null, exitDate: null, exitPrice: null, status: 'open', pnl: null, pnlPct: null, intraday,
      };
    }
  }

  // Close live positions whose forward horizon has elapsed (wall clock), at the
  // current market price.
  const nowTs = Math.floor(Date.now() / 1000);
  const dueLive = openTrades().filter((t) => t.live && t.exitDueTime != null && t.exitDueTime <= nowTs);
  for (const t of dueLive) {
    let price = t.entryPrice;
    try {
      price = (await provider.lastPrice(t.symbol)).price || price;
    } catch {
      /* fall back to entry price */
    }
    sellOut(t, price, nowTs);
  }

  persist();
}

// ---- read model for the AI Trader tab ----
export async function view(provider) {
  const s = load();
  const trades = Object.values(s.trades);

  // Mark open AI trades to current price.
  const openSymbols = [...new Set(trades.filter((t) => t.status === 'open').map((t) => t.symbol))];
  const priceMap = {};
  await Promise.all(
    openSymbols.map(async (sym) => {
      try {
        priceMap[sym] = (await provider.lastPrice(sym)).price;
      } catch {
        /* leave undefined */
      }
    })
  );
  for (const t of trades) {
    if (t.status === 'open') {
      const cur = priceMap[t.symbol] ?? t.entryPrice;
      t.currentPrice = cur;
      t.pnl = (cur - t.entryPrice) * t.shares;
      t.pnlPct = ((cur - t.entryPrice) / t.entryPrice) * 100;
    }
  }

  const perStrategy = {};
  for (const strat of s.strategies) {
    const ts = trades.filter((t) => t.strategyId === strat.id);
    const cl = ts.filter((t) => t.status === 'closed');
    const wins = cl.filter((t) => t.pnl > 0).length;
    perStrategy[strat.id] = {
      trades: ts.length,
      closed: cl.length,
      open: ts.length - cl.length,
      winRate: cl.length ? (wins / cl.length) * 100 : null,
      pnl: ts.reduce((a, t) => a + (t.pnl || 0), 0),
    };
  }

  const closed = trades.filter((t) => t.status === 'closed');
  const aiRealized = closed.reduce((a, t) => a + (t.pnl || 0), 0);
  const openPnl = trades.filter((t) => t.status === 'open').reduce((a, t) => a + (t.pnl || 0), 0);

  const sorted = trades.sort((a, b) => (b.entryTime || 0) - (a.entryTime || 0));

  // ---- portfolio diversification: current sector weights vs targets ----------
  const acct = portfolio.getState();
  const heldPrice = {};
  await Promise.all(
    Object.keys(acct.positions).map(async (sym) => {
      if (priceMap[sym] != null) { heldPrice[sym] = priceMap[sym]; return; }
      try { heldPrice[sym] = (await provider.lastPrice(sym)).price || acct.positions[sym].avgCost; }
      catch { heldPrice[sym] = acct.positions[sym].avgCost; }
    })
  );
  let equity = acct.cash;
  const secMV = {};
  for (const [sym, pos] of Object.entries(acct.positions)) {
    const mv = pos.shares * (heldPrice[sym] || pos.avgCost);
    equity += mv;
    const sec = symbolSector(sym) || 'other';
    secMV[sec] = (secMV[sec] || 0) + mv;
  }
  const allocation = Object.entries(SECTOR_TARGETS).map(([key, target]) => ({
    sector: key,
    label: sectorLabel(key),
    target: +(target * 100).toFixed(1),
    value: secMV[key] || 0,
    pct: equity > 0 ? +(((secMV[key] || 0) / equity) * 100).toFixed(1) : 0,
  }));
  const investedValue = allocation.reduce((a, x) => a + x.value, 0) + (secMV.other || 0);
  const diversification = {
    equity,
    cashPct: equity > 0 ? +((acct.cash / equity) * 100).toFixed(1) : 0,
    investedPct: equity > 0 ? +((investedValue / equity) * 100).toFixed(1) : 0,
    sectors: allocation,
  };

  return {
    ai: {
      totalTrades: trades.length,
      openTrades: trades.filter((t) => t.status === 'open').length,
      closedTrades: closed.length,
      realizedPnL: aiRealized,
      openPnL: openPnl,
    },
    diversification,
    strategies: s.strategies.map((strat) => ({
      id: strat.id,
      name: strat.name,
      enabled: strat.enabled,
      tradeAmount: strat.tradeAmount || DEFAULT_TRADE,
      since: strat.createdAt || null,
      interpretation: describeScenario(strat.scenario),
      stats: perStrategy[strat.id] || { trades: 0, closed: 0, open: 0, winRate: null, pnl: 0 },
    })),
    trades: sorted.slice(0, 300),
  };
}
