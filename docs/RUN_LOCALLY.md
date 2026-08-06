# Running locally against real Polygon data

Every backtest in this repo runs on **mock/synthetic data** in the hosted
environment (outbound access to Polygon is blocked there). To get a *real* answer
— does the momentum edge actually exist after costs, out-of-sample? — you run it
on your own machine with a Polygon key. This is that setup.

## 1. Prerequisites

- **Node 18+** (the repo is tested on Node 22).
- A **Polygon.io API key** — https://polygon.io. A free key works but is limited
  to ~5 requests/minute, which makes the first full-universe fetch slow (see §5).
  A paid "Stocks Starter" tier removes that limit and gives deeper history.

## 2. Clone + install

```bash
git clone https://github.com/neilagrawal131/FAKE-DO-NOT-USE.git
cd FAKE-DO-NOT-USE
npm install
```

## 3. Add your key

```bash
cp .env.example .env
```

Edit `.env` and set your key. `.env` is gitignored — your key is never committed.

```
POLYGON_API_KEY=your_real_key_here
```

(Optional knobs — costs, settlement, etc. — are documented in `.env.example`.)

## 4. Verify real data is flowing — do this first

```bash
npm run check
```

Expected on success:

```
Data source: polygon
POLYGON_API_KEY: present (abc…yz)
✓ Polygon reachable — AAPL: 21 daily bars, last close 2xx.xx @ 2026-…
Real data is flowing.
```

If it fails it tells you why (bad/inactive key, rate limit, or network). **Do not
trust any backtest until this passes** — otherwise you're reading mock numbers.
The key is always shown masked; it is never printed in full or logged.

## 5. Run the momentum backtest on real data

Headless (prints the verdict to the terminal):

```bash
# Start SMALL — one sector is ~20 symbols and finishes fast even on a free plan:
npm run momentum -- --universe technology

# The broad universe (~200 names). On a FREE plan the first run fetches
# ~200 symbols at ~5/min → it can take ~40 minutes. Paid plans are quick.
npm run momentum

# Paid Polygon tier — lift the rate cap and go fast:
npm run momentum -- --rpm 100

# Tune it:
npm run momentum -- --topK 15 --weighting equal --lookback 126
#   --universe   all | a sector key (technology, energy, biotech, …)
#   --topK       how many names to hold
#   --weighting  inversevol | equal
#   --lookback   momentum window in bars (252≈12mo, 189≈9mo, 126≈6mo)
#   --rpm        request/min cap for the first download (free tier = 5, default)
```

**Free plan? This is handled automatically.** Polygon's free tier allows ~5
requests/minute. The downloader runs one symbol at a time, capped at `--rpm`
(default **5**), and if it still hits a `429` it backs off and retries rather than
dropping the symbol — so the first full download completes (slowly) and every
symbol lands in the local DB. If a run ends with "only N/20 symbols loaded", just
re-run it: the DB keeps what it already fetched (those are instant) and fills in
the rest. On a paid plan, pass `--rpm 100` to skip the throttle.

Read the **OUT-OF-SAMPLE** block — that's the honest number. In-sample is shown
only for context and is always flattering.

**Why the first run is slow, and why the next is instant:** history is fetched
through a local SQLite database (`data/marketdb.sqlite`). The first run pulls each
symbol from Polygon and persists it; every run afterward reads from the DB with no
network calls. Start with one sector to validate the pipeline before pulling the
whole universe.

## 6. Or use the browser UI

```bash
npm start
# open http://localhost:3000  →  Factor Lab (🧪)
```

Same engine, with an equity curve, per-window folds, and the live portfolio. The
CLI and the server share the same local DB, so a headless run also warms the UI.

## 7. What to expect (read this before you over-interpret a good number)

- A single lucky out-of-sample window is not an edge. Look for a **positive,
  cost-adjusted OOS result that holds across multiple windows and universes**, and
  a Sharpe that survives — not one big fold carrying the average.
- Published factors have **decayed** as they got crowded, and retail costs are
  higher than an institution's. A real momentum edge today is *modest* (think
  Sharpe ~0.5, with long drawdowns), not a money machine.
- Before funding anything, follow the gates in **`GOING_LIVE.md`**: paper-trade it
  live on an IBKR paper account for months, then start with tiny real size.
