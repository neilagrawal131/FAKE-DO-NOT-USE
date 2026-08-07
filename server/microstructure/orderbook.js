// A limit-order-book matching engine with price–time priority — the core of how
// every modern exchange actually works. Prices are integer TICKS (cents) so all
// comparisons are exact. This is a learning model: single venue, no fees/rebates,
// no hidden/iceberg orders, no self-trade prevention.
//
// Price–time priority: better prices match first; at the same price, the order
// that rested earlier (lower sequence number) matches first. Your position in
// that queue is why latency matters — a faster participant gets in front of you.

export class OrderBook {
  constructor() {
    this.bids = []; // resting buys,  sorted best→worst: price DESC, then time ASC
    this.asks = []; // resting sells, sorted best→worst: price ASC,  then time ASC
    this.seq = 0; // global time-priority counter
    this.nextId = 1;
  }

  bestBid() {
    return this.bids.length ? this.bids[0].price : null;
  }
  bestAsk() {
    return this.asks.length ? this.asks[0].price : null;
  }
  mid() {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (b != null && a != null) return (a + b) / 2;
    return a != null ? a : b;
  }
  spread() {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b != null && a != null ? a - b : null;
  }

  // Insert a resting order keeping price–time priority. `isBid` sets the sort
  // direction (bids: higher price better; asks: lower price better).
  _insert(book, order, isBid) {
    let i = 0;
    while (i < book.length) {
      const o = book[i];
      const strictlyBetter = isBid ? o.price > order.price : o.price < order.price;
      if (strictlyBetter || o.price === order.price) {
        i++; // keep existing better/equal (earlier-time) orders ahead of ours
        continue;
      }
      break; // book[i] is worse → our order goes here
    }
    book.splice(i, 0, order);
  }

  // A marketable/limit order: match against the opposite side, then rest any
  // remainder (unless `rest` is false, i.e. a market order). Returns { fills }.
  submit({ side, price, size, agentId, rest = true }) {
    const fills = [];
    let remaining = size;
    const opp = side === 'buy' ? this.asks : this.bids;
    while (remaining > 0 && opp.length) {
      const top = opp[0];
      const crosses = side === 'buy' ? price >= top.price : price <= top.price;
      if (!crosses) break;
      const traded = Math.min(remaining, top.size);
      fills.push({
        price: top.price, // trade executes at the RESTING (maker) price
        size: traded,
        makerId: top.agentId,
        takerId: agentId,
        makerSide: top.side, // the maker's side ('buy' = its bid was hit)
        makerOrderId: top.id,
      });
      top.size -= traded;
      remaining -= traded;
      if (top.size <= 1e-9) opp.shift();
    }
    let restId = null;
    if (rest && remaining > 0 && Number.isFinite(price)) {
      const order = { id: this.nextId++, side, price, size: remaining, agentId, seq: this.seq++ };
      this._insert(side === 'buy' ? this.bids : this.asks, order, side === 'buy');
      restId = order.id;
    }
    return { fills, restId, filled: size - remaining };
  }

  // Convenience: a market order (no resting remainder).
  market(side, size, agentId) {
    return this.submit({ side, price: side === 'buy' ? Infinity : -Infinity, size, agentId, rest: false }).fills;
  }

  // Convenience: a resting limit order.
  limit(side, price, size, agentId) {
    return this.submit({ side, price, size, agentId, rest: true });
  }

  cancel(orderId) {
    for (const book of [this.bids, this.asks]) {
      const i = book.findIndex((o) => o.id === orderId);
      if (i !== -1) {
        book.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  // Cancel every resting order from an agent (a market-maker re-quoting).
  cancelAgent(agentId) {
    this.bids = this.bids.filter((o) => o.agentId !== agentId);
    this.asks = this.asks.filter((o) => o.agentId !== agentId);
  }

  // Aggregated depth for display: [{ price, size }] per side, best first.
  depth(levels = 5) {
    const agg = (book) => {
      const out = [];
      for (const o of book) {
        const last = out[out.length - 1];
        if (last && last.price === o.price) last.size += o.size;
        else out.push({ price: o.price, size: o.size });
        if (out.length > levels && out[out.length - 1].price !== o.price) break;
      }
      return out.slice(0, levels);
    };
    return { bids: agg(this.bids), asks: agg(this.asks) };
  }
}
