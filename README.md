# 📈 Shubh Quant Dashboard — NYSE & NASDAQ Simulator

A self-hosted **quant dashboard** with two workspaces, switchable from the side
rail:

- **📈 Trade** — a paper (virtual-money) trading simulator. Search any NYSE or
  NASDAQ stock, study a real interactive chart with **volume, VWAP and
  20 / 50 / 100 EMAs**, review fundamentals like **market cap, P/E and 52-week
  range**, then practice **buying and selling with a $100,000 paper account**.
- **🤖 AI Analyst** — describe a market scenario in plain English and it
  backtests it across real history, reporting **how often the stock rose or fell
  next, and by how much**. You control everything from the prompt:
  - **A single stock or a whole sector** — "Analyze NVDA…", "$TSLA…", "Apple…", or "in biotech…".
  - **The lookback window** — "over the past 2 years", "in the last 6 months", "past 90 days".
  - **The forward horizon** — "over the next 20 days", "held for 2 weeks", "10 days later".
  - **The trigger** — moving-average crosses, volume thresholds, single-day % moves.

  Example: *"Analyze NVDA over the past 2 years — when it crosses above its
  50-day EMA, what happens over the next 20 days?"* → % up / avg gain, % down /
  avg drop across several forward horizons.

No real money, no brokerage account, no API keys.

![Trade workspace](docs/screenshot.png)
![AI Analyst workspace](docs/analyst.png)

## Features

- **Live NYSE / NASDAQ data** pulled from Yahoo Finance (real, ~15-min delayed
  prices) — no API key required.
- **Interactive candlestick charts** (TradingView Lightweight Charts) with
  selectable timeframes: 1D · 5D · 1M · 6M · 1Y · 5Y.
- **Technical indicators**, each individually toggleable:
  - Volume histogram
  - VWAP (session-anchored intraday, range-anchored for daily)
  - EMA 20 / EMA 50 / EMA 100
  - Live OHLC + indicator legend that follows your cursor.
- **Fundamentals panel:** market cap, volume & average volume, day range,
  52-week range, open, previous close, P/E (trailing & forward), EPS, beta,
  dividend yield, 50/200-day averages, shares outstanding, analyst target,
  plus sector, industry and a company description.
- **Paper trading engine:**
  - $100,000 starting cash (persisted between restarts).
  - Market Buy / Sell **filled at the live price** (never a client-supplied one).
  - Quick-size buttons (10, 25%, 50%, Max / All).
  - Positions marked to market with unrealized P/L, realized P/L, day change,
    total return and an order blotter.
  - One-click account reset.
- **Search restricted to NYSE & NASDAQ equities** (other exchanges are filtered
  out).
- **Offline demo mode** with synthetic data so the app runs anywhere.

## Quick start

```bash
npm install     # installs deps and vendors the chart library
npm start       # serves on http://localhost:3000
```

Then open <http://localhost:3000> and start trading.

### Offline / demo mode

If you're on a network that blocks Yahoo Finance (or just want a deterministic
demo), run with synthetic data — clearly labelled "(simulated)" in the UI:

```bash
DATA_SOURCE=mock npm start
```

## Configuration

| Env var       | Default  | Description                                            |
| ------------- | -------- | ------------------------------------------------------ |
| `PORT`        | `3000`   | HTTP port.                                             |
| `DATA_SOURCE` | `yahoo`  | `yahoo` for live data, `mock` for synthetic offline.   |

## How it works

```
server/
  index.js      Express API + static file server
  yahoo.js      Live Yahoo Finance client (cookie/crumb handshake + caching)
  mock.js       Synthetic provider (same interface) for offline mode
  portfolio.js  Paper-trading account, persisted to data/portfolio.json
public/
  index.html    Single-page UI
  js/app.js     UI logic (search, detail, trading, portfolio)
  js/chart.js   Lightweight-Charts wiring (candles, volume, overlays)
  js/indicators.js  Pure EMA / SMA / VWAP math
  css/styles.css
```

### API

| Method | Endpoint                 | Purpose                                  |
| ------ | ------------------------ | ---------------------------------------- |
| GET    | `/api/search?q=`         | NYSE/NASDAQ symbol search                |
| GET    | `/api/quote/:symbol`     | Quote + fundamentals                     |
| GET    | `/api/chart/:symbol?tf=` | OHLCV bars (`tf` = 1D…5Y)                |
| GET    | `/api/portfolio`         | Account marked to live prices            |
| POST   | `/api/trade`             | `{ side, symbol, shares }` — market order|
| POST   | `/api/portfolio/reset`   | Reset to $100k cash                      |
| GET    | `/api/sectors`           | Sector universes for the AI Analyst      |
| POST   | `/api/analyze`           | `{ query }` — backtest a plain-English scenario |

### AI Analyst — how it works

The scenario engine is deterministic (not an LLM), so it always shows exactly how
it read your request and every field is overridable:

1. **`scenario.js`** parses the query into `{ sector, lookback, conditions[], horizons }`
   using keyword/regex rules (moving-average crosses, volume thresholds, % moves).
2. **`universe.js`** maps the sector to a curated list of ~20 liquid NYSE/NASDAQ tickers.
3. **`backtest.js`** fetches daily history for each name, finds every day all
   conditions fire, measures forward returns at 1/5/10/20-day horizons, and
   aggregates into % up / avg gain and % down / avg drop.

### Testing

```bash
npm i --no-save playwright
DATA_SOURCE=mock PORT=3111 npm start &     # in one shell
node scripts/smoke.mjs shot.png            # end-to-end browser check
```

## Notes & disclaimer

- Market data is provided by Yahoo Finance's public endpoints and is typically
  **delayed ~15 minutes**. This is intended for education and practice only.
- Fills are simulated at the last trade price with **no slippage, spread,
  commission, or market-hours restriction** — real execution differs.
- **Not investment advice.** This project is for learning and entertainment.

## License

MIT
