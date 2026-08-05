# Going Live: Roadmap for Real-Money Trading

This document is the plan for connecting Shubh Quant from a paper simulator to a
real brokerage account. It is deliberately conservative. The single most common
way to lose real money with an automated system is to connect an **unproven,
overfit strategy** to a live account too early. Every phase below exists to stop
that from happening.

> **Status: NOT READY FOR LIVE.** Treat this as a checklist. Do not skip gates.
> Nothing in this repo should touch real money until Phase 3, and only after the
> Phase 2 go/no-go gate passes.

---

## 0. Reality check — why paper ≠ live

The simulator is optimistic in ways that quietly destroy real returns:

| Simulator assumption | Live reality |
|---|---|
| Fills at the close/last price | You get filled at the **bid/ask**, with slippage, often worse on the trades you most want |
| Every order fills fully, instantly | **Partial fills**, requotes, unfilled limit orders, queue position |
| No costs | Commissions, exchange/regulatory fees, spread, borrow costs on shorts |
| Infinite liquidity | **Market impact** — your own order moves thin names |
| Always tradable | Halts, LULD bands, circuit breakers, pre/post-market gaps, earnings gaps |
| State is always correct | Crashes, disconnects, and races desync your view from the broker's |

At the trade sizes this platform targets (~0.08–0.1% of equity per trade),
**commissions and spread can equal or exceed the edge.** Any "profitable"
backtest must be re-run with realistic costs before it means anything.

---

## 1. Broker choice — IBKR vs Webull

**Recommendation: Interactive Brokers (IBKR).**

| | IBKR | Webull |
|---|---|---|
| Official automation API | **Yes** — mature (TWS API, Client Portal Web API, FIX) | Limited; OpenAPI is newer/narrower, region-gated |
| Paper account mirroring live | **Yes**, same API surface | Weaker |
| Asset breadth, fractional, routing control | Broad | Narrower |
| Fit for a programmatic algo | **Strong** | Weak/uncertain |

IBKR gives you a **paper account that uses the identical API as live**, so the
same code path can be validated for months before flipping one flag. That is
exactly the property this roadmap depends on.

**IBKR integration options (this is a Node app):**
- **Client Portal Web API (REST + WebSocket)** — easiest fit for Node/Express.
  Runs against a local "Client Portal Gateway." Downside: session auth requires
  periodic re-authentication (and 2FA), which must be automated/monitored.
- **TWS API / IB Gateway** — richer, but Java/Python-centric. From Node you'd
  bridge (e.g. run a small Python `ib-async` sidecar that exposes an internal
  order API). Use `IBC` to keep IB Gateway logged in and auto-restarted.

> Webull: fine as a *manual* account or a data cross-check, but do not make it
> the execution venue for the autonomous strategist.

---

## 2. Architecture changes

The current execution path (`server/portfolio.js` + `server/aitrader.js`) writes
directly to an internal ledger. Live trading needs a broker between the decision
and the money, plus reconciliation and a hard risk gate.

### 2.1 Broker abstraction layer  — ✅ scaffolded (`server/broker/`)
A `Broker` interface so paper and live share one code path:

```
Broker {
  getAccount()                      // cash, buying power, equity
  getPositions()                    // source of truth = broker, not local
  placeOrder({clientOrderId, symbol, side, qty, type, limitPrice, tif})
  cancelOrder(clientOrderId)
  getOrder(id) / getOpenOrders()
  streamFills(cb)                   // async fills, partials, rejects
}
```
Implemented so far:
- `broker/broker.js` — the contract: order shape, the lifecycle **state machine**
  (`pending_new → submitted → acknowledged → partially_filled → filled |
  cancelled | rejected`, with illegal transitions rejected), **idempotent
  client order ids**, request validation, and the abstract `Broker` base.
- `broker/paper.js` — **PaperBroker** (working): wraps the `portfolio.js` ledger,
  fills marketable orders against the live quote (buy at ask / sell at bid,
  limits rest until marketable), routes fills through the ledger (so T+1
  settlement still applies), persists an order audit trail, and emits fill events.
- `broker/ibkr.js` — **IbkrBroker** (stub): documents the IBKR Client Portal Web
  API integration surface; methods throw `NOT_IMPLEMENTED` until built.
- `broker/index.js` — factory; `BROKER=paper` (default) or `BROKER=ibkr`.
- `GET /api/broker` — read-only view of the active venue, account, positions and
  order audit trail.

Still to do: route the manual trade, AI-Trader and Strategist execution paths
through `Broker` (they still call `portfolio.js` directly), add the reconciliation
loop, and build out `IbkrBroker`.

### 2.2 Order lifecycle as a persisted state machine
`intent → submitted → acknowledged → (partial…) → filled | cancelled | rejected`
- Persist **every** transition to disk/DB (you already have durable JSON + SQLite).
- On restart, rebuild in-flight orders from persisted state — never assume.

### 2.3 Idempotency
- Generate a **client order id** per intent; reuse it on retry so a network
  hiccup never double-submits. This is the number-one cause of accidental
  double positions.

### 2.4 Reconciliation loop
- The **broker is the source of truth.** On startup and on a timer, pull
  positions + cash from the broker and reconcile against local state. Alert and
  halt on any mismatch beyond a tiny tolerance.

### 2.5 Separate decide / gate / execute
`Strategist proposes` → `RiskEngine approves or rejects` → `Executor submits`.
The strategist must not be able to reach the broker except through the gate.

---

## 3. Risk management — the part that actually protects you

Build a `RiskEngine` that runs **before every live order** and **fails closed**
(reject on any doubt). It formalizes the sizing caps that already live informally
in `aitrader.js`.

**Pre-trade checks (hard limits):**
- [x] **Cash-account settlement (T+1)** — only *settled* cash can fund a buy;
      unsettled sale proceeds are excluded from buying power until they settle,
      so the simulator can't do something that would be a Good Faith Violation
      live. Enforced at the `portfolio.trade()` choke point.
- [ ] Max $ per order, max % of equity per order
- [ ] Max position per symbol; max exposure per sector; max gross & net exposure
- [ ] Buying-power / margin check before submit
- [ ] Price collar — reject orders more than X% from last trade (fat-finger guard)
- [ ] Order rate limit (orders/min, cancels/min)
- [ ] Symbol allowlist; block halted / LULD-limited names
- [ ] Reject if market data is stale (no tick in N seconds)

**Account-level circuit breakers:**
- [ ] **Global kill switch** — one flag that cancels all open orders and halts new ones
- [ ] Max **daily loss** → flatten and stop for the day
- [ ] Max **drawdown** from peak → halt and require manual re-enable
- [ ] **Dead-man's switch** — if the strategy heartbeat stops, auto-cancel open orders

**Autonomous-strategist specific:**
- The gene-pool mutation loop promotes/retires patterns on its own. In live mode
  it must **NOT** deploy a newly discovered pattern to real capital automatically.
  New patterns route to paper/canary first and require passing the Phase 2 gate
  (or an explicit human approval) before they can size up live.

---

## 4. Execution quality

- [ ] Use **marketable limit orders**, not market orders (cap slippage)
- [ ] Handle partial fills and requotes explicitly in the state machine
- [ ] Respect market hours, halts, LULD, and the auction periods
- [ ] Model **commissions + fees + spread** in every profitability calc
- [ ] Decide fractional vs whole shares (IBKR supports fractional with limits)
- [ ] Measure realized **slippage** = fill price − signal price, per trade, always

---

## 5. Market data

- Research data (Polygon/Yahoo via `withDatabase`) is fine for backtests but is
  **not** an execution feed. Live signals should use the broker's real-time
  quotes (or a low-latency feed) so the price you signal on is the price you can
  trade on.
- [ ] Subscribe to the required IBKR market-data entitlements (real-time, not delayed)
- [ ] Keep signal-time data and execution-time data consistent (same source/clock)

---

## 6. Validation gates — prove the edge before funding it

This is the go/no-go section. **Do not fund live until all of these pass.**

**Where a real edge might come from.** Single-stock technical patterns on liquid
large-caps are the most arbitraged data that exists — which is why they die
out-of-sample. The durable, retail-accessible edges are **cross-sectional** and
**low-frequency**: momentum (relative strength), value, post-earnings drift. The
**Factor Lab** (`server/momentum.js`, `POST /api/momentum`) is the first of these —
a cross-sectional momentum engine judged by the same walk-forward/OOS gate. At a
$1k account, only the zero-commission + fractional + liquid + monthly-rebalance
shape is viable; the engine is built to that shape.

**6.1 Statistical edge on real data (not mock):**
- [x] **Walk-forward / out-of-sample harness built** (`server/walkforward.js`,
      `server/costs.js`; `POST /api/walkforward`; "Run out-of-sample validation"
      in the AI Analyst). Tunes the hold horizon on each train window, tests it on
      the next unseen window rolling forward, subtracts realistic costs
      (commission + spread + slippage) from every trade, and reports in-sample vs
      out-of-sample side by side with a plain verdict. _Still to do: run it on
      **real** Polygon data (blocked in this environment) — it currently proves
      out on mock, where it correctly finds no edge._
- [x] Judges on the shared quant panel (Sharpe/Sortino/Monte Carlo) computed on
      the **out-of-sample** returns only, with the same stats module the Analyst uses.
- [x] **The autonomous Strategist now promotes on the out-of-sample score.**
      In-sample scoring is used only to rank what to explore; before any pattern
      can go live it must pass a cost-adjusted walk-forward gate (`validationPass`
      in `server/strategist.js`), and it is periodically re-validated so a decayed
      edge is demoted. The roster is ranked/sized by the OOS score, not in-sample.
- [ ] Check **regime** breakdown per pattern — an edge that only exists in one
      regime must be gated to that regime, not run blind.

**6.2 Paper-trade live (same code path, paper account):**
- [ ] Run the full stack against the **IBKR paper account** for an extended period
      (target 3–6 months / a few hundred trades)
- [ ] Compare paper fills vs. expected — measure the slippage/fee drag empirically
- [ ] Confirm reconciliation, restarts, kill switch, and alerts all work under real conditions

**6.3 Canary (micro-size real money):**
- [ ] Fund a **small, isolated** amount you can fully afford to lose
- [ ] One strategy, small universe, tiny size, with a human watching and the kill switch ready
- [ ] Only scale after the canary's realized results match expectations

---

## 7. Operations & infrastructure

- **This container is ephemeral** — the repo is cloned fresh and reclaimed on
  idle. A live trader that dies mid-session leaves **open positions unmanaged.**
  Live must run on a **persistent, monitored host** (VPS/cloud) with auto-restart.
- [ ] Persistent host + process supervisor (systemd/pm2) with restart policy
- [ ] IB Gateway/Client-Portal session kept alive + re-auth automated (`IBC`) and monitored
- [ ] Secrets on the host only — never in git (same discipline as the Polygon key)
- [ ] Structured logging + **full order audit trail**
- [ ] Alerting to your phone (fills, rejects, halts, errors, heartbeat loss)
- [ ] Health checks / heartbeat; NTP time sync; state + DB backups

---

## 8. Compliance, tax, legal (US, personal account)

- [ ] **Pattern Day Trader rule** — a margin account under **$25k** is capped at
      3 day trades per rolling 5 days. The strategist's intraday churn will hit
      this fast; either stay ≥ $25k, throttle day trades, or trade cash-account style.
- [ ] **Wash-sale** rules affect tax on repeated in-and-out trades — keep records
- [ ] Reconcile broker **1099** at tax time; retain a full trade log
- [ ] Review the broker's **terms of service** for automated/API trading
- [ ] This is your own capital — managing anyone else's money invokes registration
      (RIA, etc.); out of scope here but do not cross that line casually
- [ ] Nothing in this repo is investment advice

---

## 9. Security

- [ ] Broker credentials in a secrets manager / host env, never committed
- [ ] Consider a **dedicated sub-account** funded only with what the algo may risk
- [ ] Least-privilege API sessions; IP allowlist where supported; 2FA
- [ ] Lock down the trading host (firewall, no public inbound, patched)

---

## 10. Phased rollout (milestones)

| Phase | Goal | Exit criteria |
|---|---|---|
| **0. Plumbing** _(in progress)_ | `Broker` interface, order state machine, idempotency ✅; reconciliation, `RiskEngine`, and routing execution through the broker — all against **PaperBroker** | Full order lifecycle + kill switch proven in paper; risk checks reject correctly |
| **1. IBKR paper** | Wire `IbkrBroker` to the **paper** account; run the whole stack live-but-paper | 3–6 months / hundreds of trades; slippage measured; ops (restart, alerts, re-auth) solid |
| **2. Edge validation** _(harness ✅, needs real data)_ | Cost-adjusted, out-of-sample, walk-forward proof using the quant panel | **Go/no-go gate.** Positive cost-adjusted edge that survives OOS + Monte Carlo, or **STOP** |
| **3. Canary live** | Micro-size real money, one strategy, supervised | Realized results match paper within tolerance |
| **4. Scale-up** | Grow size gradually; add strategies only after each proves out live | Each addition passes Phase 2 individually before it can size up |

---

## Guiding principles

1. **The broker is the source of truth** — always reconcile, never assume.
2. **Fail closed** — on any doubt, reject the order and/or flatten.
3. **The edge must survive costs and out-of-sample data**, or it isn't an edge.
4. **Scale slowly** — the cost of going too fast is real money; the cost of going
   too slow is only time.
5. **A human can always hit the kill switch.**
