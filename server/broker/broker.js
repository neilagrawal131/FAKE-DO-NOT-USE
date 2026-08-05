// Broker abstraction — the seam between a trading decision and the money.
//
// Every execution path (manual trade, AI Trader, autonomous Strategist) should
// eventually go through a `Broker` rather than touching the ledger directly, so
// that swapping the paper account for a real brokerage (IBKR) is a one-line
// change and every safety property — idempotency, an order state machine,
// reconciliation, a risk gate — lives in one place.
//
// This file defines the contract: the order shape, the lifecycle state machine,
// the abstract `Broker` base class, and shared helpers (id generation, request
// validation). Implementations live alongside: paper.js (working) and
// ibkr.js (stub). See docs/GOING_LIVE.md for the rollout plan.

// --- enums ------------------------------------------------------------------

export const SIDE = Object.freeze({ BUY: 'buy', SELL: 'sell' });

export const ORDER_TYPE = Object.freeze({ MARKET: 'MKT', LIMIT: 'LMT' });

// Time in force. DAY = expires at close; GTC = rest until filled/cancelled;
// IOC = fill what you can immediately, cancel the rest.
export const TIF = Object.freeze({ DAY: 'DAY', GTC: 'GTC', IOC: 'IOC' });

export const ORDER_STATUS = Object.freeze({
  PENDING_NEW: 'pending_new', // created locally, not yet sent to the broker
  SUBMITTED: 'submitted', // sent, awaiting broker acknowledgement
  ACKNOWLEDGED: 'acknowledged', // broker accepted; working / resting (unfilled)
  PARTIALLY_FILLED: 'partially_filled',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
});

// A status is terminal when no further transitions are possible.
const TERMINAL = new Set([ORDER_STATUS.FILLED, ORDER_STATUS.CANCELLED, ORDER_STATUS.REJECTED]);
export function isTerminal(status) {
  return TERMINAL.has(status);
}

// Allowed lifecycle transitions. Reject anything not listed — an illegal
// transition is a bug (or a desync) and must never be silently applied.
const TRANSITIONS = Object.freeze({
  [ORDER_STATUS.PENDING_NEW]: [ORDER_STATUS.SUBMITTED, ORDER_STATUS.REJECTED],
  [ORDER_STATUS.SUBMITTED]: [
    ORDER_STATUS.ACKNOWLEDGED,
    ORDER_STATUS.PARTIALLY_FILLED,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.REJECTED,
    ORDER_STATUS.CANCELLED,
  ],
  [ORDER_STATUS.ACKNOWLEDGED]: [
    ORDER_STATUS.PARTIALLY_FILLED,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.REJECTED,
  ],
  [ORDER_STATUS.PARTIALLY_FILLED]: [
    ORDER_STATUS.PARTIALLY_FILLED,
    ORDER_STATUS.FILLED,
    ORDER_STATUS.CANCELLED,
  ],
  [ORDER_STATUS.FILLED]: [],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.REJECTED]: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

// Apply a status transition to an order in place, stamping updatedTs. Throws on
// an illegal transition so callers can't corrupt the lifecycle.
export function applyTransition(order, to, nowTs, extra = {}) {
  if (order.status !== to && !canTransition(order.status, to)) {
    throw new Error(`Illegal order transition ${order.status} -> ${to} (${order.clientOrderId})`);
  }
  order.status = to;
  order.updatedTs = nowTs;
  Object.assign(order, extra);
  return order;
}

// --- ids & validation -------------------------------------------------------

let seq = 0;
// A client order id is the idempotency key: retrying a submit with the same id
// must never create a second order. Callers may supply their own; this generates
// a unique one when they don't.
export function newClientOrderId(prefix = 'ord') {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

// Normalize + validate an order request. Returns a clean request object or
// throws a 400-style error. Keep this strict — it is the first line of defense.
export function validateOrderRequest(req = {}) {
  const out = {
    clientOrderId: req.clientOrderId || newClientOrderId(),
    symbol: String(req.symbol || '').trim().toUpperCase(),
    side: req.side,
    qty: Number(req.qty),
    type: req.type || ORDER_TYPE.MARKET,
    limitPrice: req.limitPrice != null ? Number(req.limitPrice) : null,
    tif: req.tif || TIF.DAY,
    source: req.source || 'api',
    strategyId: req.strategyId ?? null,
    strategyName: req.strategyName ?? null,
  };
  if (!out.symbol) throw badRequest('symbol is required');
  if (out.side !== SIDE.BUY && out.side !== SIDE.SELL) throw badRequest('side must be buy or sell');
  if (!Number.isFinite(out.qty) || out.qty <= 0) throw badRequest('qty must be positive');
  if (out.type !== ORDER_TYPE.MARKET && out.type !== ORDER_TYPE.LIMIT) throw badRequest('type must be MKT or LMT');
  if (out.type === ORDER_TYPE.LIMIT && !(out.limitPrice > 0)) throw badRequest('limit orders need a positive limitPrice');
  if (!Object.values(TIF).includes(out.tif)) throw badRequest(`tif must be one of ${Object.values(TIF).join(', ')}`);
  return out;
}

export function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// Build the canonical order record from a validated request.
export function newOrder(req, nowTs) {
  return {
    clientOrderId: req.clientOrderId,
    brokerOrderId: null, // assigned by the venue on acknowledgement
    symbol: req.symbol,
    side: req.side,
    qty: req.qty,
    type: req.type,
    limitPrice: req.limitPrice,
    tif: req.tif,
    status: ORDER_STATUS.PENDING_NEW,
    filledQty: 0,
    avgFillPrice: null,
    fills: [], // { qty, price, ts }
    reason: null, // rejection / cancel reason
    source: req.source,
    strategyId: req.strategyId,
    strategyName: req.strategyName,
    createdTs: nowTs,
    updatedTs: nowTs,
  };
}

// Record a (possibly partial) fill on an order and advance its status.
export function recordFill(order, qty, price, nowTs) {
  order.fills.push({ qty, price, ts: nowTs });
  const prevValue = (order.avgFillPrice || 0) * order.filledQty;
  order.filledQty += qty;
  order.avgFillPrice = order.filledQty > 0 ? (prevValue + qty * price) / order.filledQty : price;
  const done = order.filledQty >= order.qty - 1e-9;
  applyTransition(order, done ? ORDER_STATUS.FILLED : ORDER_STATUS.PARTIALLY_FILLED, nowTs);
  return order;
}

// The abstract contract every broker implements. Methods throw until overridden
// so an incomplete implementation fails loudly rather than silently no-op'ing.
export class Broker {
  get name() {
    return 'abstract';
  }

  // eslint-disable-next-line no-unused-vars
  async getAccount() {
    throw new Error('getAccount() not implemented');
  }

  async getPositions() {
    throw new Error('getPositions() not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async placeOrder(request) {
    throw new Error('placeOrder() not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async cancelOrder(clientOrderId) {
    throw new Error('cancelOrder() not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async getOrder(clientOrderId) {
    throw new Error('getOrder() not implemented');
  }

  async getOpenOrders() {
    throw new Error('getOpenOrders() not implemented');
  }

  // Subscribe to fill/lifecycle events. Returns an unsubscribe function.
  // eslint-disable-next-line no-unused-vars
  streamFills(cb) {
    throw new Error('streamFills() not implemented');
  }
}
