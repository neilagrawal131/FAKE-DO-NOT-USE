// IbkrBroker — Interactive Brokers implementation of the Broker contract.
//
// STATUS: STUB. Not connected to any account. Every method that would touch the
// broker throws NotImplemented with a pointer to what needs building. This file
// exists to pin down the integration surface so the rest of the system can be
// written against the Broker interface today and the real wiring dropped in
// later. See docs/GOING_LIVE.md (sections 1–2) for the plan.
//
// Recommended path for this Node app: the IBKR **Client Portal Web API**
// (REST + WebSocket) via a locally-running Client Portal Gateway.
//   - Auth:      the Gateway handles login + 2FA; sessions must be kept alive
//                (`/tickle`) and re-authenticated when they drop. Automate and
//                monitor this — a dead session silently stops all trading.
//   - Account:   GET /portfolio/{accountId}/summary, /portfolio/{accountId}/positions
//   - Orders:    POST /iserver/account/{accountId}/orders   (supports a caller
//                `cOID` — use it as the clientOrderId for idempotency)
//                DELETE /iserver/account/{accountId}/order/{orderId}
//                GET  /iserver/account/orders  (statuses)
//   - Fills:     subscribe over the WebSocket for order-status/fill updates;
//                translate each into our ORDER_STATUS transitions.
//
// Validate everything first against an IBKR **paper account** (identical API to
// live). Do not point this at a live account until the Phase 2 go/no-go gate in
// docs/GOING_LIVE.md has passed.

import { Broker } from './broker.js';

function notImplemented(what) {
  const e = new Error(
    `IbkrBroker.${what} is not implemented yet — see server/broker/ibkr.js and docs/GOING_LIVE.md`
  );
  e.code = 'NOT_IMPLEMENTED';
  return e;
}

export class IbkrBroker extends Broker {
  constructor(config = {}) {
    super();
    // No secrets are read here beyond connection config; credentials/session
    // live in the Client Portal Gateway, not in this process.
    this.config = {
      gatewayUrl: config.gatewayUrl || process.env.IBKR_GATEWAY_URL || 'https://localhost:5000/v1/api',
      accountId: config.accountId || process.env.IBKR_ACCOUNT_ID || null,
      paper: config.paper ?? process.env.IBKR_PAPER !== '0', // default to paper — safe
    };
    this.subscribers = new Set();
  }

  get name() {
    return this.config.paper ? 'ibkr-paper' : 'ibkr-live';
  }

  // Establish/verify the gateway session before any trading. Should tickle to
  // keep alive and reject if not authenticated.
  async connect() {
    throw notImplemented('connect()');
  }

  async getAccount() {
    throw notImplemented('getAccount()');
  }

  async getPositions() {
    throw notImplemented('getPositions()');
  }

  // eslint-disable-next-line no-unused-vars
  async placeOrder(request) {
    // Map the validated request to the IBKR order payload (side, qty, orderType
    // MKT/LMT, tif, cOID=clientOrderId), POST it, then track status → fills via
    // the WebSocket. Must be idempotent on clientOrderId.
    throw notImplemented('placeOrder()');
  }

  // eslint-disable-next-line no-unused-vars
  async cancelOrder(clientOrderId) {
    throw notImplemented('cancelOrder()');
  }

  // eslint-disable-next-line no-unused-vars
  async getOrder(clientOrderId) {
    throw notImplemented('getOrder()');
  }

  async getOpenOrders() {
    throw notImplemented('getOpenOrders()');
  }

  // Register a callback; real implementation feeds it from the order/fill
  // WebSocket. Returns an unsubscribe function to match the contract.
  streamFills(cb) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
}
