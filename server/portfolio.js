// Paper-trading account: cash, positions, realized/unrealized P&L, and an order
// blotter. Persisted to a JSON file so restarts keep the account. Single-account
// by design — this is a personal simulator, not a multi-tenant broker.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJSON, loadJSON } from './store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(root, 'data');
const FILE = join(DATA_DIR, 'portfolio.json');

const STARTING_CASH = 100_000;

// US equities settle T+1 (one business day) since May 2024. In a cash account,
// only SETTLED cash may fund a new purchase: buying with unsettled sale proceeds
// and then selling that position before the original sale settles is a Good Faith
// Violation. We model this so the simulator behaves like a real cash account.
const SETTLE_BUSINESS_DAYS = Number(process.env.SETTLE_BUSINESS_DAYS ?? 1);

function fresh() {
  return {
    cash: STARTING_CASH,
    startingCash: STARTING_CASH,
    positions: {}, // symbol -> { shares, avgCost }
    orders: [], // { id, ts, side, symbol, shares, price, amount }
    realizedPnL: 0,
    // Sale proceeds awaiting settlement: { amount, symbol, tradeDate, settlesOn }.
    // Included in `cash` but excluded from settled (tradable) cash until settlesOn.
    pendingSettlements: [],
  };
}

let state = null;

function load() {
  if (state) return state;
  state = loadJSON(FILE, fresh);
  if (!Array.isArray(state.pendingSettlements)) state.pendingSettlements = []; // migrate older files
  return state;
}

// --- cash settlement (T+1) --------------------------------------------------
// Total sale proceeds that have not yet settled.
function unsettledTotal(s) {
  return (s.pendingSettlements || []).reduce((a, p) => a + p.amount, 0);
}

// Drop settlement entries whose settlement date has arrived. Their cash was
// already in `s.cash`; maturing just moves it from unsettled to settled.
function settleMatured() {
  const s = load();
  if (!s.pendingSettlements || !s.pendingSettlements.length) return;
  const today = marketDay();
  const before = s.pendingSettlements.length;
  s.pendingSettlements = s.pendingSettlements.filter((p) => p.settlesOn > today);
  if (s.pendingSettlements.length !== before) persist();
}

// Settled (immediately tradable) cash = total cash minus unsettled proceeds.
export function settledCash() {
  const s = load();
  settleMatured();
  return s.cash - unsettledTotal(s);
}

// The date `n` business days after a calendar date (YYYY-MM-DD), skipping
// weekends. NOTE: market holidays are not modeled here — a real broker returns
// the authoritative settlement date on the fill; this is a close approximation
// for the simulator.
function nextBusinessDay(dateStr, n = 1) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d.toISOString().slice(0, 10);
}

function persist() {
  saveJSON(FILE, state);
}

let orderSeq = 0;
function nextOrderId() {
  orderSeq += 1;
  return `${load().orders.length + 1}-${orderSeq}`;
}

export function getState() {
  return load();
}

export function reset() {
  // Loud, timestamped log so an unexpected reset is traceable to an actual
  // reset() call (vs. a process restart loading fresh state).
  console.warn(`[portfolio] RESET to $${STARTING_CASH} at ${new Date().toISOString()}`);
  state = fresh();
  persist();
  return state;
}

// Execute a market order at the supplied (live) price. `ts` is passed in by the
// caller so this module stays free of wall-clock reads.
export function trade({ side, symbol, shares, price, ts, bid = null, ask = null, spreadEstimated = false, source = 'you', strategyId = null, strategyName = null }) {
  const s = load();
  symbol = symbol.toUpperCase();
  shares = Number(shares);
  price = Number(price);

  if (!['buy', 'sell'].includes(side)) throw badRequest('side must be buy or sell');
  if (!Number.isFinite(shares) || shares <= 0) throw badRequest('shares must be positive');
  if (!Number.isFinite(price) || price <= 0) throw badRequest('invalid price');

  const amount = shares * price;

  if (side === 'buy') {
    // Cash-account rule: only settled cash can fund a purchase. Unsettled sale
    // proceeds are off-limits until they settle (T+1).
    const avail = settledCash();
    if (amount > avail + 1e-6) {
      const unsettled = unsettledTotal(s);
      throw badRequest(
        `Insufficient settled cash: need $${amount.toFixed(2)}, have $${avail.toFixed(2)} settled` +
          (unsettled > 1e-6 ? ` ($${unsettled.toFixed(2)} unsettled from recent sales)` : '')
      );
    }
    s.cash -= amount;
    const pos = s.positions[symbol] || { shares: 0, avgCost: 0 };
    const totalCost = pos.avgCost * pos.shares + amount;
    pos.shares += shares;
    pos.avgCost = pos.shares > 0 ? totalCost / pos.shares : 0;
    s.positions[symbol] = pos;
  } else {
    const pos = s.positions[symbol];
    if (!pos || pos.shares < shares - 1e-9) {
      throw badRequest(
        `Cannot sell ${shares} ${symbol}: you hold ${pos ? pos.shares : 0}`
      );
    }
    s.cash += amount;
    s.realizedPnL += (price - pos.avgCost) * shares;
    pos.shares -= shares;
    if (pos.shares <= 1e-9) delete s.positions[symbol];
    else s.positions[symbol] = pos;
    // Proceeds are unsettled until T+1 — they count toward equity but cannot fund
    // a new buy until they settle.
    const tradeDate = marketDay();
    s.pendingSettlements.push({
      amount,
      symbol,
      tradeDate,
      settlesOn: nextBusinessDay(tradeDate, SETTLE_BUSINESS_DAYS),
    });
  }

  const order = {
    id: nextOrderId(),
    ts,
    side,
    symbol,
    shares,
    price,
    amount,
    bid,
    ask,
    spreadEstimated,
    source,
    strategyId,
    strategyName,
  };
  s.orders.unshift(order);
  if (s.orders.length > 500) s.orders.length = 500;
  persist();
  return order;
}

// Credit cash to the account (e.g. a dividend paid while holding a position).
// Recorded in the blotter as a 'dividend' entry and counted as realized gains.
export function credit({ symbol, amount, ts, note = 'dividend' }) {
  const s = load();
  amount = Number(amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  s.cash += amount;
  s.realizedPnL += amount;
  const order = { id: nextOrderId(), ts, side: 'dividend', symbol: (symbol || '').toUpperCase(), shares: null, price: null, amount, note, source: 'div' };
  s.orders.unshift(order);
  if (s.orders.length > 500) s.orders.length = 500;
  persist();
  return order;
}

// Build a marked-to-market view given a { symbol -> {price, previousClose} } map.
export function summarize(priceMap = {}) {
  const s = load();
  settleMatured(); // mature any proceeds that have settled since the last view
  const positions = Object.entries(s.positions).map(([symbol, pos]) => {
    const mark = priceMap[symbol]?.price ?? null;
    const prevClose = priceMap[symbol]?.previousClose ?? null;
    const marketValue = mark != null ? mark * pos.shares : null;
    const costBasis = pos.avgCost * pos.shares;
    const unrealized = marketValue != null ? marketValue - costBasis : null;
    const unrealizedPct = costBasis > 0 && unrealized != null ? (unrealized / costBasis) * 100 : null;
    const dayChange =
      mark != null && prevClose != null ? (mark - prevClose) * pos.shares : null;
    return {
      symbol,
      shares: pos.shares,
      avgCost: pos.avgCost,
      price: mark,
      marketValue,
      costBasis,
      unrealized,
      unrealizedPct,
      dayChange,
    };
  });

  const positionsValue = positions.reduce((a, p) => a + (p.marketValue ?? p.costBasis), 0);
  const equity = s.cash + positionsValue;
  const totalUnrealized = positions.reduce((a, p) => a + (p.unrealized ?? 0), 0);

  // True daily change: today's equity vs. the account's equity at the start of
  // the trading day — so it includes realized gains and dividends booked today,
  // not just open positions drifting since their previous close.
  const marked = Object.keys(priceMap).length > 0 || positions.length === 0;
  const day = marketDay();
  if (marked && (!s.dayAnchor || s.dayAnchor.date !== day)) {
    s.dayAnchor = { date: day, equity };
    persist();
  }
  const anchorEquity = s.dayAnchor ? s.dayAnchor.equity : equity;
  const dayChange = equity - anchorEquity;

  const unsettled = unsettledTotal(s);
  return {
    cash: s.cash,
    settledCash: s.cash - unsettled, // cash available to place a new buy
    unsettledCash: unsettled, // sale proceeds still settling (T+1)
    settlements: s.pendingSettlements.map((p) => ({ amount: p.amount, symbol: p.symbol, settlesOn: p.settlesOn })),
    startingCash: s.startingCash,
    positionsValue,
    equity,
    realizedPnL: s.realizedPnL,
    unrealizedPnL: totalUnrealized,
    totalPnL: equity - s.startingCash,
    totalReturnPct: ((equity - s.startingCash) / s.startingCash) * 100,
    dayChange,
    dayStartEquity: anchorEquity,
    positions,
    orders: s.orders.slice(0, 100),
  };
}

// Current trading day in US Eastern time (the day the "today" change resets on).
function marketDay() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Symbols currently held — used by the API to fetch live marks.
export function heldSymbols() {
  return Object.keys(load().positions);
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}
