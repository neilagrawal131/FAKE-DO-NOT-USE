# Market-microstructure sandbox

A synthetic limit-order-book simulator built to *learn* how markets actually work
at the mechanical level — not to make money. It's the honest on-ramp to the one
kind of intraday trading that has real edge (and is gated behind infrastructure
you don't have): market-making and order-flow.

Run it:

```bash
npm run micro                          # detailed run + the adverse-selection grid
npm run micro -- --informed 0.4 --latency 6
```

## What it models

- **`server/microstructure/orderbook.js`** — a real matching engine with
  **price–time priority** (better prices first; ties broken by who rested first).
  Limit orders, market orders, partial fills, cancels. Prices are integer cents.
- **`server/microstructure/sim.js`** — a market-making simulation:
  - a hidden **fair value** random-walks and occasionally **jumps** (news);
  - a **market-maker (MM)** posts a bid and an ask around its *perceived* fair,
    which lags the true fair by `latency` steps, and skews quotes to mean-revert
    its inventory;
  - **noise traders** send random market orders (the MM's profit source);
  - **informed traders** know the true fair and only trade when the MM's quote is
    stale — lifting a too-cheap ask or hitting a too-rich bid (adverse selection).

## The one lesson

The MM's mark-to-market P&L decomposes **exactly** into:

```
total = spread captured        (edge vs true fair at each fill)
      + inventory P&L          (how held inventory moved vs fair)  ← adverse selection
```

The sandbox sweeps *informed-fraction × latency* and prints the MM's total P&L:

```
  informed\lat          0        1        3        6       12
           5%   +$822.50 +$808.11 +$806.88 +$743.31 +$674.73
          15%   +$690.69 +$652.24 +$551.78 +$457.81 +$213.04
          30%   +$586.87 +$517.04 +$397.98 +$181.38 -$170.12
          50%   +$437.82 +$358.14 +$132.41 -$165.54 -$686.61
```

- **Fast + mostly-uninformed (top-left): prints money.** Spread capture from noise
  dwarfs the small adverse-selection cost.
- **Slow OR heavily-informed (right / bottom): bleeds it back.** Stale quotes get
  picked off by traders who know more than you.

That green top-left corner is where the HFT market-makers live — and it is bought
with **colocation and nanosecond hardware**, not a laptop. This is *why* the earlier
roadmap said retail can't compete on the speed-dependent strategies: you'd be the
slow MM in the bottom-right, systematically adversely selected.

## What this is (and isn't)

- It **is** a correct, self-contained model for understanding order books,
  market-making, adverse selection, inventory risk, and why latency is money.
  It's a genuine portfolio/learning artifact for a quant path.
- It is **not** a trading strategy and makes no market-data calls. The numbers are
  synthetic — the *mechanisms* are what's real.

## Natural next steps (if you want to go further)

- A browser view: watch the order book fill and the MM's inventory/P&L in real time.
- Add a second (competing) market-maker and watch queue position / undercutting.
- Swap synthetic flow for a replay of real trades/quotes (needs L2/MBO data, e.g.
  Databento or Polygon's higher tiers) to study a real book.
- A **structural-flow** backtest (closing-auction imbalance, index rebalance) —
  the most retail-accessible real edge — which needs real event data to be honest.
