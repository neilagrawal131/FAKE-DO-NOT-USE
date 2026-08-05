// Realistic trading-cost model. A backtest with zero costs is a fantasy — at the
// small position sizes this platform uses, costs can equal or exceed the raw
// edge, so every honest evaluation must subtract them.
//
// Costs are expressed as ROUND-TRIP basis points of notional (1 bp = 0.01%),
// applied once per trade (a full entry + exit):
//   - commission — broker fee both sides (IBKR on liquid names is a few bp)
//   - spread     — you buy at the ask and sell at the bid; the gap is a loss
//   - slippage   — the price drifts against you between decision and fill
//
// Defaults are tuned for liquid large-caps. Wider (small-cap / illiquid) names
// cost more; a future refinement can scale the spread by the symbol's real
// average bid/ask. Override any component via env for scenario analysis.

export const DEFAULT_COSTS = Object.freeze({
  commissionBps: Number(process.env.COST_COMMISSION_BPS ?? 1), // ~$0.005/sh, round trip
  spreadBps: Number(process.env.COST_SPREAD_BPS ?? 4), // full spread on a liquid name
  slippageBps: Number(process.env.COST_SLIPPAGE_BPS ?? 3), // modest market impact
});

// Total round-trip cost as a PERCENT of the trade (so it can be subtracted
// directly from a trade's percent return). 8 bp -> 0.08%.
export function roundTripCostPct(costs = DEFAULT_COSTS) {
  return (costs.commissionBps + costs.spreadBps + costs.slippageBps) / 100;
}

// Net a gross percent return for one trade after round-trip costs.
export function applyCost(grossPct, costs = DEFAULT_COSTS) {
  return grossPct - roundTripCostPct(costs);
}
