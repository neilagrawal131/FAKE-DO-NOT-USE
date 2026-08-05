// Broker factory. Chooses the execution venue from configuration and returns a
// single shared instance. Everything downstream depends only on the Broker
// contract (broker.js), so going live is a matter of BROKER=ibkr + credentials —
// not a rewrite.
//
//   BROKER=paper (default) — the paper ledger (portfolio.js)
//   BROKER=ibkr            — Interactive Brokers (currently a stub)

import * as portfolio from '../portfolio.js';
import { PaperBroker } from './paper.js';
import { IbkrBroker } from './ibkr.js';

export * from './broker.js';
export { PaperBroker } from './paper.js';
export { IbkrBroker } from './ibkr.js';

let instance = null;

// Create (once) and return the configured broker. `priceProvider` supplies live
// quotes for fills — pass the same provider the rest of the app marks prices
// with, so signal price and fill price come from one source.
export function getBroker({ priceProvider } = {}) {
  if (instance) return instance;
  const kind = (process.env.BROKER || 'paper').toLowerCase();
  if (kind === 'ibkr') {
    instance = new IbkrBroker();
  } else {
    instance = new PaperBroker({ portfolio, priceProvider });
  }
  return instance;
}

// Test/reset hook — drops the cached singleton so a fresh instance is built.
export function _resetBrokerForTest() {
  instance = null;
}
