// Algorithmic paper trader. It holds a list of user-approved "patterns"
// (scenarios promoted from the AI Analyst) and trades ONLY those, on its own
// $100,000 paper account — kept separate from the manual Trade account so its
// performance is measured cleanly. The trade log is a deterministic function of
// the enabled patterns + current market data, so we recompute it on read; only
// the patterns themselves are persisted.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSignals } from './backtest.js';
import { describeScenario } from './scenario.js';
import { sectorLabel } from './universe.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'data');
const FILE = join(DATA_DIR, 'aitrader.json');

const START_CASH = 100_000;
const DEFAULT_TRADE = 5_000; // dollars committed per signal
const MAX_SIGNALS_PER_STRATEGY = 60;
const MAX_TRADES = 400;

let state = null;
let seq = 0;

function load() {
  if (state) return state;
  try {
    state = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { strategies: [] };
  } catch {
    state = { strategies: [] };
  }
  if (!Array.isArray(state.strategies)) state.strategies = [];
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

// Short human label for a pattern card.
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
    else if (c.kind === 'fvg') trig = `${c.dir} FVG`;
  }
  const more = sc.conditions.length > 1 ? ` +${sc.conditions.length - 1}` : '';
  return `${scope} · ${trig}${more}`;
}

function fmtTime(t, intraday) {
  const d = new Date(t * 1000);
  return intraday ? d.toISOString().slice(0, 16).replace('T', ' ') : d.toISOString().slice(0, 10);
}

// ---- strategy CRUD ----
export function addStrategy(scenario, name) {
  const s = load();
  seq += 1;
  s.strategies.push({
    id: `s${Date.now()}${seq}`,
    name: name || shortName(scenario),
    scenario,
    enabled: true,
    tradeAmount: DEFAULT_TRADE,
    createdAt: Math.floor(Date.now() / 1000),
  });
  persist();
}
export function removeStrategy(id) {
  const s = load();
  s.strategies = s.strategies.filter((x) => x.id !== id);
  persist();
}
export function setEnabled(id, enabled) {
  const s = load();
  const st = s.strategies.find((x) => x.id === id);
  if (st) st.enabled = enabled;
  persist();
}
export function reset() {
  state = { strategies: [] };
  persist();
}

// ---- simulation ----
export async function simulate(provider) {
  const s = load();
  const enabled = s.strategies.filter((x) => x.enabled);

  // Gather signals from every enabled pattern. The trader only acts on triggers
  // that occur AFTER the pattern was added — it never back-trades history.
  let signals = [];
  for (const strat of enabled) {
    let sig = [];
    try {
      sig = await collectSignals(strat.scenario, provider);
    } catch {
      sig = [];
    }
    const activatedAt = strat.createdAt || 0;
    sig = sig.filter((g) => g.time >= activatedAt);
    sig.sort((a, b) => a.time - b.time);
    const intraday = strat.scenario.timeframe === 'intraday';
    for (const g of sig.slice(-MAX_SIGNALS_PER_STRATEGY)) {
      signals.push({ ...g, strategyId: strat.id, strategyName: strat.name, tradeAmount: strat.tradeAmount || DEFAULT_TRADE, intraday });
    }
  }
  signals.sort((a, b) => a.time - b.time);

  // Walk the merged signal stream on one shared account.
  let cash = START_CASH;
  const openPos = new Map(); // key strategyId|symbol -> position
  const trades = [];

  const closePosition = (pos, exitTime, exitPrice) => {
    cash += pos.shares * exitPrice;
    pos.trade.status = 'closed';
    pos.trade.exitTime = exitTime;
    pos.trade.exitDate = fmtTime(exitTime, pos.intraday);
    pos.trade.exitPrice = exitPrice;
    pos.trade.pnl = (exitPrice - pos.trade.entryPrice) * pos.shares;
    pos.trade.pnlPct = ((exitPrice - pos.trade.entryPrice) / pos.trade.entryPrice) * 100;
  };

  for (const sig of signals) {
    // Free cash from any positions that have matured by this point in time.
    for (const [k, pos] of openPos) {
      if (pos.exitTime != null && pos.exitTime <= sig.time) {
        closePosition(pos, pos.exitTime, pos.exitPrice);
        openPos.delete(k);
      }
    }
    if (trades.length >= MAX_TRADES) continue;
    const key = `${sig.strategyId}|${sig.symbol}`;
    if (openPos.has(key)) continue; // no pyramiding the same name in one pattern
    const price = sig.entryPrice;
    if (!(price > 0)) continue;
    const shares = Math.max(1, Math.floor(sig.tradeAmount / price));
    const cost = shares * price;
    if (cost > cash) continue; // out of buying power

    cash -= cost;
    const trade = {
      id: `t${sig.strategyId}-${sig.symbol}-${sig.time}`,
      strategyId: sig.strategyId,
      strategyName: sig.strategyName,
      symbol: sig.symbol,
      shares,
      entryTime: sig.time,
      entryDate: fmtTime(sig.time, sig.intraday),
      entryPrice: price,
      exitTime: null,
      exitDate: null,
      exitPrice: null,
      status: 'open',
      pnl: null,
      pnlPct: null,
    };
    trades.push(trade);
    openPos.set(key, { shares, exitTime: sig.exitTime, exitPrice: sig.exitPrice, intraday: sig.intraday, trade });
  }

  // Close everything whose exit already happened; keep genuinely-open positions.
  const stillOpen = [];
  for (const [, pos] of openPos) {
    if (pos.exitTime != null) closePosition(pos, pos.exitTime, pos.exitPrice);
    else stillOpen.push(pos);
  }

  // Mark open positions to the current price.
  const openSymbols = [...new Set(stillOpen.map((p) => p.trade.symbol))];
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
  let openValue = 0;
  for (const pos of stillOpen) {
    const cur = priceMap[pos.trade.symbol] ?? pos.trade.entryPrice;
    pos.trade.currentPrice = cur;
    pos.trade.pnl = (cur - pos.trade.entryPrice) * pos.shares;
    pos.trade.pnlPct = ((cur - pos.trade.entryPrice) / pos.trade.entryPrice) * 100;
    openValue += cur * pos.shares;
  }

  const closed = trades.filter((t) => t.status === 'closed');
  const realized = closed.reduce((a, t) => a + t.pnl, 0);
  const equity = cash + openValue;

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

  trades.sort((a, b) => b.entryTime - a.entryTime);

  return {
    account: {
      startingCash: START_CASH,
      cash,
      openValue,
      equity,
      realizedPnL: realized,
      totalPnL: equity - START_CASH,
      totalReturnPct: ((equity - START_CASH) / START_CASH) * 100,
      openPositions: stillOpen.length,
      totalTrades: trades.length,
      closedTrades: closed.length,
    },
    strategies: s.strategies.map((strat) => ({
      id: strat.id,
      name: strat.name,
      enabled: strat.enabled,
      tradeAmount: strat.tradeAmount || DEFAULT_TRADE,
      since: strat.createdAt || null,
      interpretation: describeScenario(strat.scenario),
      stats: perStrategy[strat.id] || { trades: 0, closed: 0, open: 0, winRate: null, pnl: 0 },
    })),
    trades: trades.slice(0, 300),
  };
}
