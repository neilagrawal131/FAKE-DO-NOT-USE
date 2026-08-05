// PaperBroker — the Broker contract implemented on top of the existing paper
// ledger (portfolio.js). It is a thin layer: the ledger stays the single source
// of truth for cash/positions (including T+1 settlement), while the broker adds
// the order lifecycle, idempotency, an audit trail and a fill event stream that
// a real brokerage integration will also provide.
//
// Fills model a marketable order against the current quote: a market buy fills
// at the ask, a market sell at the bid; a limit order fills only when it is
// marketable (buy ask <= limit, sell bid >= limit), otherwise it rests as a
// working order until `tryFillResting()` re-checks it. Paper assumes infinite
// liquidity, so fills are always full size (a real venue may fill partially —
// the state machine already supports PARTIALLY_FILLED for that day).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJSON, loadJSON } from '../store.js';
import {
  Broker,
  ORDER_STATUS,
  ORDER_TYPE,
  SIDE,
  TIF,
  applyTransition,
  isTerminal,
  newOrder,
  recordFill,
  validateOrderRequest,
} from './broker.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = join(root, 'data', 'broker-orders.json');

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export class PaperBroker extends Broker {
  // `portfolio` is the ledger module; `priceProvider` supplies live quotes
  // ({ price, bid, ask }) so fills use a real marketable price, not a caller-
  // supplied one.
  constructor({ portfolio, priceProvider }) {
    super();
    if (!portfolio) throw new Error('PaperBroker requires a portfolio ledger');
    this.portfolio = portfolio;
    this.priceProvider = priceProvider || null;
    this.subscribers = new Set();
    // clientOrderId -> order. Persisted for crash recovery / audit.
    this.orders = loadJSON(FILE, () => ({ orders: {} })).orders || {};
  }

  get name() {
    return 'paper';
  }

  _persist() {
    saveJSON(FILE, { orders: this.orders });
  }

  _emit(order) {
    for (const cb of this.subscribers) {
      try {
        cb(order);
      } catch {
        /* a bad subscriber must not break execution */
      }
    }
  }

  async _quote(symbol) {
    if (!this.priceProvider) return null;
    try {
      const q = await this.priceProvider.lastPrice(symbol);
      return q && q.price > 0 ? q : null;
    } catch {
      return null;
    }
  }

  // The marketable fill price for an order given a quote, or null if the order
  // is a limit that isn't marketable right now (so it should rest).
  _fillPrice(order, quote) {
    const ask = quote.ask > 0 ? quote.ask : quote.price;
    const bid = quote.bid > 0 ? quote.bid : quote.price;
    if (order.type === ORDER_TYPE.MARKET) {
      return order.side === SIDE.BUY ? ask : bid;
    }
    // LIMIT: only fill when marketable, at the limit price (price improvement to
    // the touch is possible at a real venue; the limit is the conservative fill).
    if (order.side === SIDE.BUY) return ask <= order.limitPrice ? order.limitPrice : null;
    return bid >= order.limitPrice ? order.limitPrice : null;
  }

  // Route a fill through the ledger. Returns true on success; on a ledger
  // rejection (e.g. insufficient settled cash) marks the order rejected.
  _executeFill(order, price, ts) {
    try {
      this.portfolio.trade({
        side: order.side,
        symbol: order.symbol,
        shares: order.qty - order.filledQty,
        price,
        ts,
        source: order.source,
        strategyId: order.strategyId,
        strategyName: order.strategyName,
      });
    } catch (e) {
      applyTransition(order, ORDER_STATUS.REJECTED, ts, { reason: e.message });
      return false;
    }
    recordFill(order, order.qty - order.filledQty, price, ts);
    return true;
  }

  async placeOrder(request) {
    const req = validateOrderRequest(request);
    const ts = nowSec();

    // Idempotency: a repeat of a known client order id returns the existing
    // order untouched — never a second position.
    const existing = this.orders[req.clientOrderId];
    if (existing) return existing;

    const order = newOrder(req, ts);
    this.orders[order.clientOrderId] = order;
    // pending_new -> submitted -> acknowledged (paper acknowledges instantly).
    order.brokerOrderId = `paper-${order.clientOrderId}`;
    applyTransition(order, ORDER_STATUS.SUBMITTED, ts);
    applyTransition(order, ORDER_STATUS.ACKNOWLEDGED, ts);

    const quote = await this._quote(order.symbol);
    if (!quote) {
      // No price → can't fill. Market orders reject; limits rest (unpriced).
      if (order.type === ORDER_TYPE.MARKET) {
        applyTransition(order, ORDER_STATUS.REJECTED, ts, { reason: 'no market price available' });
      }
      this._persist();
      this._emit(order);
      return order;
    }

    const fillPrice = this._fillPrice(order, quote);
    if (fillPrice == null) {
      // Not marketable — leave it working. IOC would cancel instead.
      if (order.tif === TIF.IOC) {
        applyTransition(order, ORDER_STATUS.CANCELLED, ts, { reason: 'IOC: not marketable' });
      }
      this._persist();
      this._emit(order);
      return order;
    }

    this._executeFill(order, fillPrice, ts);
    this._persist();
    this._emit(order);
    return order;
  }

  // Re-check resting (working) limit orders against current quotes and fill any
  // that have become marketable. A real broker does this continuously; call this
  // on a timer if/when resting limit orders are used.
  async tryFillResting() {
    const filled = [];
    for (const order of Object.values(this.orders)) {
      if (order.status !== ORDER_STATUS.ACKNOWLEDGED || order.type !== ORDER_TYPE.LIMIT) continue;
      const quote = await this._quote(order.symbol);
      if (!quote) continue;
      const price = this._fillPrice(order, quote);
      if (price == null) continue;
      const ts = nowSec();
      if (this._executeFill(order, price, ts)) filled.push(order);
      this._emit(order);
    }
    if (filled.length) this._persist();
    return filled;
  }

  async cancelOrder(clientOrderId) {
    const order = this.orders[clientOrderId];
    if (!order) throw new Error(`Unknown order ${clientOrderId}`);
    if (isTerminal(order.status)) return order; // nothing to cancel
    applyTransition(order, ORDER_STATUS.CANCELLED, nowSec(), { reason: 'cancelled by user' });
    this._persist();
    this._emit(order);
    return order;
  }

  async getOrder(clientOrderId) {
    return this.orders[clientOrderId] || null;
  }

  async getOpenOrders() {
    return Object.values(this.orders).filter((o) => !isTerminal(o.status));
  }

  // Full audit trail (most recent first).
  async getAllOrders(limit = 200) {
    return Object.values(this.orders)
      .sort((a, b) => b.createdTs - a.createdTs)
      .slice(0, limit);
  }

  // Account snapshot. In paper mode the ledger is the source of truth; a real
  // broker would return the venue's account and reconciliation would compare.
  async getAccount() {
    const s = this.portfolio.summarize({});
    return {
      backend: this.name,
      cash: s.cash,
      settledCash: s.settledCash,
      unsettledCash: s.unsettledCash,
      buyingPower: s.settledCash, // cash account: only settled cash is buying power
      equity: s.equity,
      positionsValue: s.positionsValue,
    };
  }

  async getPositions() {
    const st = this.portfolio.getState();
    return Object.entries(st.positions).map(([symbol, p]) => ({
      symbol,
      qty: p.shares,
      avgCost: p.avgCost,
    }));
  }

  streamFills(cb) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
}
