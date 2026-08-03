import { PriceChart, CHART_COLORS } from './chart.js';
import { ema, sma } from './indicators.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const usd = (n, opts = {}) =>
  n == null || Number.isNaN(n)
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
        ...opts,
      }).format(n);

const num = (n, d = 2) =>
  n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d });

// Compact large numbers: 3.42T, 918.2B, 12.4M
function compact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

const pct = (n) => (n == null || Number.isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const signClass = (n) => (n == null ? '' : n >= 0 ? 'up' : 'down');

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 3200);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  symbol: null,
  quote: null,
  timeframe: '1D',
  side: 'buy',
  chart: null,
};

// Intraday timeframes get a session-anchored VWAP; higher ones anchor to range.
const INTRADAY_TF = new Set(['1m', '5m', '10m', '30m', '1h', '3h']);
const TF_INTERVAL = {
  '1m': 'each candle = 1 minute',
  '5m': 'each candle = 5 minutes',
  '10m': 'each candle = 10 minutes',
  '30m': 'each candle = 30 minutes',
  '1h': 'each candle = 1 hour',
  '3h': 'each candle = 3 hours',
  '1D': 'each candle = 1 day',
  '1W': 'each candle = 1 week',
  '1Mo': 'each candle = 1 month',
  '6Mo': 'each candle = 6 months',
  '1Y': 'each candle = 1 year',
  '5Y': 'each candle = 5 years',
};
const QUICK_PICKS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'META', 'AMD'];

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
function initSearch() {
  const input = $('#search-input');
  const box = $('#search-results');
  let timer;
  let activeIdx = -1;
  let items = [];

  const close = () => {
    box.hidden = true;
    activeIdx = -1;
  };

  const render = () => {
    if (!items.length) {
      box.innerHTML = '<div class="result-empty">No NYSE / NASDAQ matches.</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = items
      .map(
        (r, i) => `
        <div class="result-row ${i === activeIdx ? 'active' : ''}" data-sym="${r.symbol}">
          <span class="result-sym">${r.symbol}</span>
          <span class="result-name">${escapeHtml(r.name)}</span>
          <span class="result-exch">${r.exchange || ''}</span>
        </div>`
      )
      .join('');
    box.hidden = false;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 1) return close();
    timer = setTimeout(async () => {
      try {
        items = await api(`/api/search?q=${encodeURIComponent(q)}`);
        activeIdx = -1;
        render();
      } catch {
        /* ignore transient search errors */
      }
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    if (box.hidden) {
      if (e.key === 'Enter' && input.value.trim()) selectSymbol(input.value.trim().toUpperCase());
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      render();
    } else if (e.key === 'Enter') {
      const pick = items[activeIdx] || items[0];
      if (pick) selectSymbol(pick.symbol);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  box.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.result-row');
    if (row) selectSymbol(row.dataset.sym);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search')) close();
  });

  function selectSymbol(sym) {
    input.value = '';
    close();
    loadSymbol(sym);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Symbol detail
// ---------------------------------------------------------------------------
async function loadSymbol(symbol) {
  symbol = symbol.toUpperCase();
  state.symbol = symbol;
  $('#welcome').hidden = true;
  $('#detail').hidden = false;

  $('#d-symbol').textContent = symbol;
  $('#d-name').textContent = 'Loading…';
  $('#d-exchange').textContent = '';
  $('#d-price').innerHTML = '<span class="spinner"></span>';
  $('#d-change').textContent = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  ensureChart();

  // Fetch quote + chart in parallel.
  const [quoteRes, chartRes] = await Promise.allSettled([
    api(`/api/quote/${symbol}`),
    loadChart(symbol, state.timeframe),
  ]);

  if (quoteRes.status === 'fulfilled') {
    state.quote = quoteRes.value;
    renderHeader(quoteRes.value);
    renderStats(quoteRes.value);
    renderTradePanel();
  } else {
    $('#d-name').textContent = 'Could not load quote.';
    toast(quoteRes.reason?.message || 'Failed to load quote', 'error');
  }

  if (chartRes.status === 'rejected') {
    toast(chartRes.reason?.message || 'Failed to load chart', 'error');
  }
}

function ensureChart() {
  if (state.chart) return;
  state.chart = new PriceChart($('#chart'));
  // live legend on crosshair
  state.chart.chart.subscribeCrosshairMove((param) => updateLegend(param));
}

async function loadChart(symbol, tf) {
  const data = await api(`/api/chart/${symbol}?tf=${tf}`);
  const intraday = INTRADAY_TF.has(tf);
  state.chart.setBars(data.bars, { intraday });
  $('#tf-interval').textContent = TF_INTERVAL[tf] || '';
  updateLegend(null);
  return data;
}

function renderHeader(q) {
  $('#d-symbol').textContent = q.symbol;
  $('#d-exchange').textContent = q.exchange || '';
  $('#d-name').textContent = q.name || '';
  $('#d-price').textContent = usd(q.price);
  const changeEl = $('#d-change');
  const cls = signClass(q.change);
  changeEl.className = `price-change ${cls}`;
  const arrow = q.change == null ? '' : q.change >= 0 ? '▲' : '▼';
  changeEl.textContent =
    q.change == null ? '' : `${arrow} ${usd(Math.abs(q.change))} (${pct(q.changePercent)})`;

  renderSpreadLine(q);
}

function spreadPct(q) {
  if (q.bid == null || q.ask == null || !q.price) return null;
  return ((q.ask - q.bid) / q.price) * 100;
}

function renderSpreadLine(q) {
  const el = $('#d-spread');
  if (q.bid == null || q.ask == null) {
    el.innerHTML = '';
    return;
  }
  const sp = q.ask - q.bid;
  const spPct = spreadPct(q);
  el.innerHTML =
    `Bid <span class="bid">${usd(q.bid)}</span>` +
    `${q.bidSize ? ` ×${num(q.bidSize / 100, 0)}` : ''}` +
    ` &nbsp;·&nbsp; Ask <span class="ask">${usd(q.ask)}</span>` +
    `${q.askSize ? ` ×${num(q.askSize / 100, 0)}` : ''}` +
    ` &nbsp;·&nbsp; Spread ${usd(sp)}${spPct != null ? ` (${spPct.toFixed(2)}%)` : ''}` +
    `${q.spreadEstimated ? ' <span class="est">est.</span>' : ''}`;
}

function renderStats(q) {
  const spPct = spreadPct(q);
  const rows = [
    ['Bid', q.bid != null ? `${usd(q.bid)}${q.bidSize ? ` ×${num(q.bidSize / 100, 0)}` : ''}` : '—'],
    ['Ask', q.ask != null ? `${usd(q.ask)}${q.askSize ? ` ×${num(q.askSize / 100, 0)}` : ''}` : '—'],
    ['Spread', q.bid != null && q.ask != null ? `${usd(q.ask - q.bid)}${spPct != null ? ` (${spPct.toFixed(2)}%)` : ''}` : '—'],
    ['Market cap', compact(q.marketCap)],
    ['Volume', compact(q.volume)],
    ['Avg volume', compact(q.avgVolume)],
    ['Day range', q.dayLow != null ? `${usd(q.dayLow)} – ${usd(q.dayHigh)}` : '—'],
    ['52-wk range', q.fiftyTwoWeekLow != null ? `${usd(q.fiftyTwoWeekLow)} – ${usd(q.fiftyTwoWeekHigh)}` : '—'],
    ['Open', usd(q.open)],
    ['Prev close', usd(q.previousClose)],
    ['P/E (TTM)', num(q.peRatio)],
    ['Forward P/E', num(q.forwardPE)],
    ['EPS (TTM)', usd(q.eps)],
    ['Beta', num(q.beta)],
    ['Div yield', q.dividendYield != null ? pct(q.dividendYield * 100) : '—'],
    ['50-day avg', usd(q.fiftyDayAverage)],
    ['200-day avg', usd(q.twoHundredDayAverage)],
    ['Shares out', compact(q.sharesOutstanding)],
    ['Analyst target', usd(q.targetMeanPrice)],
  ];
  $('#stat-grid').innerHTML = rows
    .map(([k, v]) => `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v">${v}</span></div>`)
    .join('');

  const tags = [q.sector, q.industry, q.recommendation ? `Rating: ${q.recommendation}` : null].filter(Boolean);
  const parts = [];
  if (tags.length) parts.push(`<div class="tags">${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>`);
  if (q.description) {
    const short = q.description.length > 420 ? q.description.slice(0, 420) + '…' : q.description;
    parts.push(`<div>${escapeHtml(short)}</div>`);
  }
  const meta = [];
  if (q.employees) meta.push(`${num(q.employees, 0)} employees`);
  if (q.website) meta.push(`<a href="${escapeHtml(q.website)}" target="_blank" rel="noopener">${escapeHtml(q.website.replace(/^https?:\/\//, ''))}</a>`);
  if (meta.length) parts.push(`<div style="margin-top:8px;color:var(--text-faint)">${meta.join(' · ')}</div>`);
  $('#profile').innerHTML = parts.join('');
}

// Legend showing OHLC + volume + indicator values at the crosshair (or latest).
function updateLegend(param) {
  if (!state.chart) return;
  const c = state.chart;
  let candle, vol;
  if (param && param.seriesData && param.seriesData.size) {
    candle = param.seriesData.get(c.candles);
    const v = param.seriesData.get(c.volume);
    vol = v ? v.value : null;
  }
  if (!candle && c.bars.length) {
    const last = c.bars[c.bars.length - 1];
    candle = last;
    vol = last.volume;
  }
  const ind = c.latest();
  if (!candle) {
    $('#chart-legend').innerHTML = '';
    return;
  }
  const cl = candle.close >= candle.open ? 'up' : 'down';
  const items = [
    `<span class="legend-item">O <b>${num(candle.open)}</b></span>`,
    `<span class="legend-item">H <b>${num(candle.high)}</b></span>`,
    `<span class="legend-item">L <b>${num(candle.low)}</b></span>`,
    `<span class="legend-item ${cl}">C <b>${num(candle.close)}</b></span>`,
    `<span class="legend-item">Vol <b>${compact(vol)}</b></span>`,
  ];
  const indMap = [
    ['ema20', 'EMA20', CHART_COLORS.ema20],
    ['ema50', 'EMA50', CHART_COLORS.ema50],
    ['ema100', 'EMA100', CHART_COLORS.ema100],
    ['vwap', 'VWAP', CHART_COLORS.vwap],
  ];
  for (const [key, label, color] of indMap) {
    if (c.enabled[key] && ind[key] != null) {
      items.push(
        `<span class="legend-item"><span class="legend-dot" style="background:${color}"></span>${label} <b>${num(ind[key])}</b></span>`
      );
    }
  }
  $('#chart-legend').innerHTML = items.join('');
}

// ---------------------------------------------------------------------------
// Timeframe + indicator controls
// ---------------------------------------------------------------------------
function initChartControls() {
  $('#timeframes').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-tf]');
    if (!btn || !state.symbol) return;
    $$('#timeframes button').forEach((b) => b.classList.toggle('active', b === btn));
    state.timeframe = btn.dataset.tf;
    try {
      await loadChart(state.symbol, state.timeframe);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#indicator-toggles').addEventListener('change', (e) => {
    const cb = e.target;
    if (!cb.dataset.ind || !state.chart) return;
    state.chart.toggle(cb.dataset.ind, cb.checked);
    updateLegend(null);
  });
}

// ---------------------------------------------------------------------------
// Trade panel
// ---------------------------------------------------------------------------
function initTradePanel() {
  $('#buy-tab').addEventListener('click', () => setSide('buy'));
  $('#sell-tab').addEventListener('click', () => setSide('sell'));
  $('#shares-input').addEventListener('input', renderTradeEstimate);

  $('#qty-quick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-qty]');
    if (!btn) return;
    applyQuickQty(btn.dataset.qty);
  });

  $('#submit-order').addEventListener('click', submitOrder);
}

function setSide(side) {
  state.side = side;
  $('#buy-tab').classList.toggle('active', side === 'buy');
  $('#sell-tab').classList.toggle('active', side === 'sell');
  renderTradePanel();
}

function renderTradePanel() {
  const q = state.quote;
  const btn = $('#submit-order');
  btn.classList.toggle('sell', state.side === 'sell');
  btn.textContent = `${state.side === 'buy' ? 'Buy' : 'Sell'} ${state.symbol || ''}`;

  // quick-qty buttons
  const quick = state.side === 'buy' ? ['1', '10', '25%', '50%', 'Max'] : ['25%', '50%', '75%', 'All'];
  $('#qty-quick').innerHTML = quick.map((qv) => `<button data-qty="${qv}">${qv}</button>`).join('');

  renderTradeEstimate();
}

function heldShares(symbol) {
  const p = window.__portfolio;
  const pos = p?.positions?.find((x) => x.symbol === symbol);
  return pos ? pos.shares : 0;
}

// The price a market order will fill at: buys pay the ask, sells hit the bid.
function fillPrice() {
  const q = state.quote;
  if (!q) return 0;
  return state.side === 'buy' ? q.ask ?? q.price ?? 0 : q.bid ?? q.price ?? 0;
}

function applyQuickQty(qv) {
  const q = state.quote;
  if (!q) return;
  const px = fillPrice();
  if (!px) return;
  const input = $('#shares-input');
  const buyingPower = window.__portfolio?.cash ?? 0;
  const held = heldShares(state.symbol);

  if (qv === 'Max') input.value = Math.floor(buyingPower / px);
  else if (qv === 'All') input.value = held;
  else if (qv.endsWith('%')) {
    const frac = parseInt(qv) / 100;
    if (state.side === 'buy') input.value = Math.floor((buyingPower * frac) / px);
    else input.value = Math.floor(held * frac);
  } else input.value = qv;

  renderTradeEstimate();
}

function renderTradeEstimate() {
  const q = state.quote;
  const shares = Number($('#shares-input').value) || 0;
  const px = fillPrice();
  const cost = shares * px;

  // Explain, per the spread, exactly what price the order fills at.
  const note = $('#fill-note');
  if (q && (q.bid != null || q.ask != null)) {
    if (state.side === 'buy') {
      note.innerHTML = `Market buys fill at the <b>ask</b>: <span class="px buy-px">${usd(q.ask)}</span>${q.spreadEstimated ? ' <span style="color:var(--text-faint)">(est.)</span>' : ''}`;
    } else {
      note.innerHTML = `Market sells fill at the <b>bid</b>: <span class="px sell-px">${usd(q.bid)}</span>${q.spreadEstimated ? ' <span style="color:var(--text-faint)">(est.)</span>' : ''}`;
    }
  } else {
    note.innerHTML = '';
  }

  $('#trade-est').innerHTML = `
    <span class="est-label">Estimated ${state.side === 'buy' ? 'cost' : 'proceeds'}</span>
    <span class="est-value">${usd(cost)}</span>`;

  const p = window.__portfolio;
  if (p) {
    if (state.side === 'buy') {
      $('#buying-power').textContent = `Buying power: ${usd(p.cash)}`;
    } else {
      $('#buying-power').textContent = `You hold ${num(heldShares(state.symbol), 4)} shares`;
    }
  }
  $('#trade-msg').textContent = '';
}

async function submitOrder() {
  const shares = Number($('#shares-input').value);
  const msg = $('#trade-msg');
  if (!state.symbol || !shares || shares <= 0) {
    msg.className = 'trade-msg error';
    msg.textContent = 'Enter a positive number of shares.';
    return;
  }
  const btn = $('#submit-order');
  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';
  msg.textContent = '';

  try {
    const { order, portfolio } = await api('/api/trade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side: state.side, symbol: state.symbol, shares }),
    });
    applyPortfolio(portfolio);
    msg.className = 'trade-msg success';
    msg.textContent = `Filled: ${order.side.toUpperCase()} ${num(order.shares, 4)} ${order.symbol} @ ${usd(order.price)}`;
    toast(`${order.side === 'buy' ? 'Bought' : 'Sold'} ${num(order.shares, 4)} ${order.symbol} @ ${usd(order.price)}`, 'success');
  } catch (err) {
    msg.className = 'trade-msg error';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ---------------------------------------------------------------------------
// Portfolio sidebar
// ---------------------------------------------------------------------------
async function refreshPortfolio() {
  try {
    // /api/portfolio also runs the AI Trader on the shared account, so its
    // buys/sells arrive as real orders in this response.
    applyPortfolio(await api('/api/portfolio'));
  } catch (err) {
    console.error(err);
  }
}

function applyPortfolio(p) {
  window.__portfolio = p;
  $('#account-equity').textContent = usd(p.equity);

  // summary tiles
  $('#summary-grid').innerHTML = `
    <div class="tile wide">
      <div class="tile-label">Account value</div>
      <div class="tile-value">${usd(p.equity)}</div>
      <div class="tile-sub ${signClass(p.dayChange)}">${p.dayChange >= 0 ? '▲' : '▼'} ${usd(Math.abs(p.dayChange))} today</div>
    </div>
    <div class="tile">
      <div class="tile-label">Cash</div>
      <div class="tile-value" style="font-size:15px">${usd(p.cash)}</div>
    </div>
    <div class="tile">
      <div class="tile-label">Invested</div>
      <div class="tile-value" style="font-size:15px">${usd(p.positionsValue)}</div>
    </div>
    <div class="tile">
      <div class="tile-label">Total P/L</div>
      <div class="tile-value ${signClass(p.totalPnL)}" style="font-size:15px">${usd(p.totalPnL)}</div>
      <div class="tile-sub ${signClass(p.totalReturnPct)}">${pct(p.totalReturnPct)}</div>
    </div>
    <div class="tile">
      <div class="tile-label">Realized P/L</div>
      <div class="tile-value ${signClass(p.realizedPnL)}" style="font-size:15px">${usd(p.realizedPnL)}</div>
    </div>`;

  // positions
  const posEl = $('#positions');
  if (!p.positions.length) {
    posEl.innerHTML = '<div class="empty">No open positions.</div>';
  } else {
    posEl.innerHTML = p.positions
      .map(
        (pos) => `
        <div class="pos-row" data-sym="${pos.symbol}">
          <div>
            <div class="pos-sym">${pos.symbol}</div>
            <div class="pos-meta">${num(pos.shares, 4)} @ ${usd(pos.avgCost)}</div>
          </div>
          <div>
            <div class="pos-val">${usd(pos.marketValue)}</div>
            <div class="pos-pl ${signClass(pos.unrealized)}">${pos.unrealized == null ? '' : (pos.unrealized >= 0 ? '+' : '') + usd(pos.unrealized).replace('$', '$') + ' (' + pct(pos.unrealizedPct) + ')'}</div>
          </div>
        </div>`
      )
      .join('');
  }

  // orders — includes both your manual orders and the AI Trader's (badged "AI").
  const orderEl = $('#orders');
  if (!p.orders.length) {
    orderEl.innerHTML = '<div class="empty">No orders yet.</div>';
  } else {
    orderEl.innerHTML = p.orders
      .slice(0, 40)
      .map(
        (o) => `
        <div class="order-row">
          <span>${o.source === 'ai' ? `<span class="ai-tag" title="AI Trader — ${escapeHtml(o.strategyName || '')}">AI</span> ` : ''}<span class="order-side ${o.side}">${o.side}</span> ${o.symbol}</span>
          <span class="order-meta">${num(o.shares, 4)} @ ${usd(o.price)}</span>
        </div>`
      )
      .join('');
  }

  // refresh trade panel context (buying power, held shares)
  if (state.symbol) renderTradeEstimate();
}

function initPortfolioInteractions() {
  $('#positions').addEventListener('click', (e) => {
    const row = e.target.closest('.pos-row');
    if (row) loadSymbol(row.dataset.sym);
  });

  $('#reset-btn').addEventListener('click', async () => {
    if (!confirm('Reset your paper account back to $100,000 cash and clear all positions?')) return;
    try {
      const p = await api('/api/portfolio/reset', { method: 'POST' });
      applyPortfolio(p);
      toast('Account reset to $100,000.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

// ---------------------------------------------------------------------------
// View navigation (rail tabs)
// ---------------------------------------------------------------------------
function initNav() {
  $('#rail').addEventListener('click', (e) => {
    const btn = e.target.closest('.rail-item');
    if (btn) setView(btn.dataset.view);
  });
}

function setView(view) {
  $$('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => {
    const on = v.id === `view-${view}`;
    v.classList.toggle('active', on);
    v.hidden = !on;
  });
  // Nudge the chart to re-fit after being unhidden.
  if (view === 'trade' && state.chart) {
    requestAnimationFrame(() => state.chart.chart.timeScale().fitContent());
  }
  if (view === 'trader') refreshTrader();
  if (view === 'strategist') initStrategist();
}

async function showConfig() {
  try {
    const cfg = await api('/api/config');
    $('#rail-source').textContent = cfg.source === 'mock' ? 'demo data' : 'live data';
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// AI Analyst (scenario backtesting)
// ---------------------------------------------------------------------------
const ANALYST_EXAMPLES = [
  'In the past 6 months in biotech, what happens when a stock rises above its 100-day moving average with volume over 100,000?',
  'Analyze NVDA over the past 2 years: when it crosses above its 50-day EMA, what happens over the next 20 days?',
  '$TSLA in the last year when a bullish fair value gap forms — over the next 5 days',
  'In the first 30 minutes, if $SOFI\'s opening move is +5% or more, what happens in the next 30 minutes?',
];

const sPct = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const pctOnly = (n) => (n == null ? '—' : `${n.toFixed(1)}%`);

// Horizon labels honour the analysis timeframe (base bar = 1 day or 30 minutes).
function analysisTimeframe() {
  return analysis.res?.scenario?.timeframe || 'daily';
}
function hzLabel(bars) {
  if (analysisTimeframe() === 'intraday') {
    const m = bars * 30;
    if (m < 60) return `${m}m`;
    if (m % 390 === 0) return `${m / 390}d`;
    if (m % 60 === 0) return `${m / 60}h`;
    return `${m}m`;
  }
  return `${bars}d`;
}
function hzLabelLong(bars) {
  if (analysisTimeframe() === 'intraday') {
    const m = bars * 30;
    if (m < 60) return `${m} minutes`;
    if (m % 390 === 0) return `${m / 390} trading day${m / 390 > 1 ? 's' : ''}`;
    if (m % 60 === 0) return `${m / 60} hour${m / 60 > 1 ? 's' : ''}`;
    return `${m} minutes`;
  }
  return `${bars} trading day${bars > 1 ? 's' : ''}`;
}

function initAnalyst() {
  $('#query-examples').innerHTML = ANALYST_EXAMPLES.map(
    (q) => `<button class="example-chip" data-q="${escapeHtml(q)}">${escapeHtml(q)}</button>`
  ).join('');

  $('#query-examples').addEventListener('click', (e) => {
    const chip = e.target.closest('.example-chip');
    if (!chip) return;
    $('#analyst-query').value = chip.dataset.q;
    runAnalysis();
  });

  $('#run-analysis').addEventListener('click', runAnalysis);
  $('#analyst-query').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runAnalysis();
  });

  // Delegated clicks for occurrence rows (open chart / remove / restore).
  $('#analyst-results').addEventListener('click', onResultsClick);

  // Occurrence modal controls.
  $('#occ-close').addEventListener('click', closeOccurrence);
  $('#occ-modal').addEventListener('click', (e) => {
    if (e.target.id === 'occ-modal') closeOccurrence();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#occ-modal').hidden) closeOccurrence();
  });
}

async function runAnalysis() {
  const query = $('#analyst-query').value.trim();
  const out = $('#analyst-results');
  if (!query) {
    out.innerHTML = '<div class="no-results">Type a scenario above, or tap an example.</div>';
    return;
  }
  const btn = $('#run-analysis');
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  out.innerHTML = '<div class="loading"><span class="spinner"></span> Scanning historical data across the sector…</div>';

  try {
    const res = await api('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    renderAnalysis(res);
  } catch (err) {
    out.innerHTML = `<div class="no-results">Analysis failed: ${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Current analysis + the set of occurrence ids the user has removed.
const analysis = { res: null, removed: new Set() };
const EV_DISPLAY_CAP = 300;

function renderAnalysis(res) {
  analysis.res = res;
  analysis.removed = new Set();
  renderResults();
}

function activeEvents() {
  return analysis.res.events.filter((e) => !analysis.removed.has(e.id));
}

// Same aggregation the server used, run client-side so removals recompute live.
function summarizeReturns(rets) {
  const n = rets.length;
  if (n === 0) return { n: 0 };
  const ups = rets.filter((r) => r > 0);
  const downs = rets.filter((r) => r < 0);
  const s = [...rets].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return {
    n,
    pctUp: (ups.length / n) * 100,
    avgUp: ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : 0,
    pctDown: (downs.length / n) * 100,
    avgDown: downs.length ? downs.reduce((a, b) => a + b, 0) / downs.length : 0,
    avg: rets.reduce((a, b) => a + b, 0) / n,
    median,
    best: Math.max(...rets),
    worst: Math.min(...rets),
  };
}

function computeHorizonStats(events, horizons) {
  return horizons.map((h) => ({
    days: h,
    ...summarizeReturns(events.map((e) => e.returns[h]).filter((r) => r != null)),
  }));
}

function renderResults() {
  const res = analysis.res;
  const out = $('#analyst-results');
  const parts = [];
  const removedCount = analysis.removed.size;

  parts.push(
    `<div class="interp"><span class="interp-label">Interpreted as</span><br/>${escapeHtml(res.interpretation)}</div>`
  );
  if (res.warnings && res.warnings.length) {
    parts.push(`<div class="warn-box">${res.warnings.map((w) => `<div>⚠︎ ${escapeHtml(w)}</div>`).join('')}</div>`);
  }

  const scopeNote = res.universe.symbol
    ? `Analyzed <b>${escapeHtml(res.universe.symbol)}</b> over the window`
    : `Scanned <b>${res.universe.symbolsWithData}</b> of ${res.universe.symbolsRequested} ${escapeHtml(res.universe.label)} stocks`;
  const removedTxt = removedCount
    ? ` · <span class="removed-note">${removedCount} removed <button class="restore-removed">restore all</button></span>`
    : '';
  parts.push(
    `<div class="universe-note">${scopeNote} · found <b>${res.triggers}</b> matching occurrence${res.triggers === 1 ? '' : 's'}${removedTxt}.</div>`
  );

  // Promote this pattern to the algorithmic AI Trader.
  if (res.scenario.conditions && res.scenario.conditions.length) {
    parts.push(
      `<button class="btn-primary add-to-trader" id="add-to-trader" style="width:auto;padding:10px 18px">🦾 Add this pattern to the AI Trader</button>`
    );
  }

  const events = activeEvents();
  const horizons = res.horizons || [1, 5, 10, 20];
  const stats = computeHorizonStats(events, horizons);
  const primary = stats.find((h) => h.days === res.primaryHorizon) || stats[0];

  if (primary && primary.n) {
    const upW = primary.pctUp || 0;
    const avgClass = primary.avg >= 0 ? 'up' : 'down';
    parts.push(`
      <div class="verdict">
        <div class="verdict-side up">
          <div class="verdict-pct">${pctOnly(primary.pctUp)}</div>
          <div class="verdict-cap">of the time it <b>rose</b> over the next ${hzLabelLong(primary.days)}</div>
          <div class="verdict-move up">average gain ${sPct(primary.avgUp)}</div>
        </div>
        <div class="verdict-side down">
          <div class="verdict-pct">${pctOnly(primary.pctDown)}</div>
          <div class="verdict-cap">of the time it <b>fell</b> over the next ${hzLabelLong(primary.days)}</div>
          <div class="verdict-move down">average drop ${sPct(primary.avgDown)}</div>
        </div>
      </div>
      <div class="updown-bar"><div class="seg-up" style="width:${upW}%"></div><div class="seg-down" style="width:${100 - upW}%"></div></div>
      <div class="summary-line">
        Across <b>${primary.n}</b> occurrences${removedCount ? ` (after removing ${removedCount})` : ''}, the average move over the next
        ${hzLabelLong(primary.days)} was <b class="${avgClass}">${sPct(primary.avg)}</b>
        (median ${sPct(primary.median)}). Best case <b class="up">${sPct(primary.best)}</b>,
        worst case <b class="down">${sPct(primary.worst)}</b>.
      </div>`);

    const rows = stats
      .filter((h) => h.n)
      .map(
        (h) => `
        <tr class="${h.days === res.primaryHorizon ? 'primary' : ''}">
          <td>${hzLabel(h.days)}</td><td>${h.n}</td>
          <td class="up">${pctOnly(h.pctUp)}</td><td class="up">${sPct(h.avgUp)}</td>
          <td class="down">${pctOnly(h.pctDown)}</td><td class="down">${sPct(h.avgDown)}</td>
          <td class="${h.avg >= 0 ? 'up' : 'down'}">${sPct(h.avg)}</td><td>${sPct(h.median)}</td>
        </tr>`
      )
      .join('');
    parts.push(`
      <div class="result-block">
        <h3>Outcome by forward horizon</h3>
        <div style="overflow-x:auto"><table class="h-table">
          <thead><tr><th>Horizon</th><th>Occurrences</th><th>% up</th><th>Avg gain</th><th>% down</th><th>Avg drop</th><th>Avg move</th><th>Median</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`);
  } else {
    parts.push(
      `<div class="no-results">${res.triggers ? 'No occurrences left with a completed forward return — restore some below.' : 'No occurrences of this scenario were found in the selected window. Try loosening the conditions or widening the time period.'}</div>`
    );
  }

  // Top contributors (multi-stock only), from the active set.
  if (!res.universe.symbol && events.length) {
    const counts = {};
    for (const e of events) counts[e.symbol] = (counts[e.symbol] || 0) + 1;
    const bySymbol = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 20);
    parts.push(`
      <div class="result-block">
        <h3>Which stocks triggered most</h3>
        <div class="chip-row">${bySymbol.map(([s, c]) => `<span class="sym-chip"><b>${s}</b> ${c}</span>`).join('')}</div>
      </div>`);
  }

  // Every occurrence — clickable to chart, removable from the data.
  const shown = events.slice(0, EV_DISPLAY_CAP);
  const evRows = shown
    .map((e) => {
      const ret = e.returns[res.primaryHorizon];
      const retCell = ret == null ? '<span style="color:var(--text-faint)">pending</span>' : `<span class="${ret >= 0 ? 'up' : 'down'}">${sPct(ret)}</span>`;
      return `
        <tr class="clickable ev-row" data-id="${escapeHtml(e.id)}" data-symbol="${e.symbol}" data-time="${e.time}" data-ret="${ret == null ? '' : ret}">
          <td>${e.date}</td><td>${e.symbol}</td><td>${usd(e.entry)}</td><td>${retCell}</td>
          <td class="ev-actions"><button class="ev-remove" data-id="${escapeHtml(e.id)}" title="Remove this occurrence">×</button></td>
        </tr>`;
    })
    .join('');
  parts.push(`
    <div class="result-block">
      <h3>Occurrences <span class="ev-hint">— click a row to see the chart · × to remove it from the stats</span></h3>
      <div class="ev-scroll" style="overflow-x:auto"><table class="ev-table">
        <thead><tr><th>Date</th><th>Symbol</th><th>Entry</th><th>${hzLabel(res.primaryHorizon)} return</th><th></th></tr></thead>
        <tbody>${evRows}</tbody>
      </table></div>
      ${events.length > EV_DISPLAY_CAP ? `<div class="disclaimer-sm">Showing the ${EV_DISPLAY_CAP} most recent of ${events.length} occurrences (stats use all of them).</div>` : ''}
    </div>`);

  parts.push(
    '<div class="disclaimer-sm">Backtest over historical NYSE/NASDAQ data — past behavior does not predict future results. For education only, not investment advice.</div>'
  );

  out.innerHTML = parts.join('');
}

// Delegated clicks inside the results: remove, restore, or open a chart.
function onResultsClick(e) {
  if (e.target.closest('#add-to-trader')) {
    addPatternToTrader();
    return;
  }
  const removeBtn = e.target.closest('.ev-remove');
  if (removeBtn) {
    e.stopPropagation();
    analysis.removed.add(removeBtn.dataset.id);
    renderResults();
    return;
  }
  if (e.target.closest('.restore-removed')) {
    analysis.removed.clear();
    renderResults();
    return;
  }
  const row = e.target.closest('.ev-row');
  if (row) {
    const ret = row.dataset.ret === '' ? null : Number(row.dataset.ret);
    openOccurrence({ id: row.dataset.id, symbol: row.dataset.symbol, time: Number(row.dataset.time), date: row.cells[0].textContent, ret });
  }
}

// ---- occurrence drill-down chart (modal) ----
let occChart = null;

async function openOccurrence(ev) {
  const res = analysis.res;
  const modal = $('#occ-modal');
  const retTxt = ev.ret == null ? '' : `<span class="mt-ret ${ev.ret >= 0 ? 'up' : 'down'}">${sPct(ev.ret)}</span>`;
  $('#occ-title').innerHTML = `<span class="mt-sym">${ev.symbol}</span> · ${ev.date} ${retTxt}`;
  $('#occ-legend').innerHTML = '';
  $('#occ-foot').innerHTML = '<span class="spinner"></span> Loading chart…';
  $('#occ-chart').innerHTML = '';
  modal.hidden = false;

  const maCond = res.scenario.conditions.find((c) => c.kind === 'ma_cross' || c.kind === 'ma_state');
  const intraday = res.scenario.timeframe === 'intraday';
  const params = new URLSearchParams({
    symbol: ev.symbol,
    time: String(ev.time),
    horizon: String(res.primaryHorizon),
    lookbackDays: String(res.lookbackDays || res.scenario.lookbackDays || 180),
    timeframe: res.scenario.timeframe || 'daily',
  });
  if (maCond) params.set('maPeriod', String(maCond.period));

  try {
    const data = await api(`/api/occurrence?${params.toString()}`);
    buildOccChart(data, maCond, ev.ret, intraday);
    $('#occ-foot').innerHTML = `Blue ▲ marks the trigger (entry <b>${usd(data.entryPrice)}</b>). ${
      data.exitPrice != null
        ? `The marker ${hzLabelLong(data.horizon)} later is the exit <b>${usd(data.exitPrice)}</b> — a <b class="${ev.ret >= 0 ? 'up' : 'down'}">${sPct(ev.ret)}</b> move.`
        : 'This occurrence is too recent to have a completed forward return.'
    }`;
  } catch (err) {
    $('#occ-foot').innerHTML = `<span class="down">Could not load chart: ${escapeHtml(err.message)}</span>`;
  }
}

function buildOccChart(data, maCond, ret, intraday = false) {
  const LWC = window.LightweightCharts;
  if (occChart) {
    occChart.remove();
    occChart = null;
  }
  const cont = $('#occ-chart');
  cont.innerHTML = '';
  occChart = LWC.createChart(cont, {
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#9ca3af' },
    grid: { vertLines: { color: 'rgba(148,163,184,0.08)' }, horzLines: { color: 'rgba(148,163,184,0.08)' } },
    rightPriceScale: { borderColor: 'rgba(148,163,184,0.2)' },
    timeScale: { borderColor: 'rgba(148,163,184,0.2)', timeVisible: intraday, secondsVisible: false },
    autoSize: true,
  });

  const candles = occChart.addCandlestickSeries({
    upColor: CHART_COLORS.up, downColor: CHART_COLORS.down, borderVisible: false,
    wickUpColor: CHART_COLORS.up, wickDownColor: CHART_COLORS.down,
  });
  candles.setData(data.bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));

  const vol = occChart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'v' });
  occChart.priceScale('v').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  vol.setData(data.bars.map((b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' })));

  let maLegend = '';
  if (maCond) {
    const line = occChart.addLineSeries({ color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const maData = (maCond.maType === 'ema' ? ema : sma)(data.bars, maCond.period);
    line.setData(maData);
    maLegend = `<span class="li"><span class="dot" style="background:#f59e0b"></span>${maCond.period}-${intraday ? 'bar' : 'day'} ${maCond.maType.toUpperCase()}</span>`;
  }

  const markers = [{ time: data.entryTime, position: 'belowBar', color: CHART_COLORS.ema20 || '#38bdf8', shape: 'arrowUp', text: 'Trigger' }];
  if (data.exitTime) {
    markers.push({
      time: data.exitTime, position: 'aboveBar',
      color: ret >= 0 ? CHART_COLORS.up : CHART_COLORS.down, shape: 'circle',
      text: `+${hzLabel(data.horizon)} ${sPct(ret)}`,
    });
  }
  candles.setMarkers(markers);
  candles.createPriceLine({ price: data.entryPrice, color: '#38bdf8', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'entry' });
  occChart.timeScale().fitContent();

  $('#occ-legend').innerHTML =
    `<span class="li"><span class="dot" style="background:#38bdf8"></span>Trigger day</span>` +
    maLegend +
    `<span class="li"><span class="dot" style="background:#26a69a"></span>Volume</span>`;
}

function closeOccurrence() {
  $('#occ-modal').hidden = true;
  if (occChart) {
    occChart.remove();
    occChart = null;
  }
}

// ---------------------------------------------------------------------------
// AI Trader
// ---------------------------------------------------------------------------
async function addPatternToTrader() {
  if (!analysis.res) return;
  const btn = $('#add-to-trader');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Adding…';
  }
  try {
    const stateData = await api('/api/aitrader/strategies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: analysis.res.scenario }),
    });
    renderTrader(stateData);
    refreshPortfolio(); // shared account may have changed
    toast('Pattern added to the AI Trader — it trades on your paper account from now on.', 'success');
    if (btn) btn.textContent = '✓ Added to AI Trader';
  } catch (err) {
    toast(err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🦾 Add this pattern to the AI Trader';
    }
  }
}

async function refreshTrader() {
  const acc = $('#trader-account');
  if (acc && !acc.innerHTML) acc.innerHTML = '<div class="loading"><span class="spinner"></span> Running strategies…</div>';
  try {
    renderTrader(await api('/api/aitrader'));
  } catch (err) {
    $('#trader-strategies').innerHTML = `<div class="trader-empty">Could not load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderAllocation(d) {
  const el = $('#trader-allocation');
  if (!el) return;
  if (!d || !d.sectors) { el.innerHTML = ''; return; }
  const rows = d.sectors
    .map((s) => {
      const over = s.pct > s.target + 0.5;
      const fillPct = s.target > 0 ? Math.min(100, (s.pct / s.target) * 100) : 0;
      return `
      <div class="alloc-row">
        <div class="alloc-name">${escapeHtml(s.label)}</div>
        <div class="alloc-bar"><div class="alloc-fill ${over ? 'over' : ''}" style="width:${fillPct}%"></div>
          <div class="alloc-target" style="left:100%" title="target ${s.target}%"></div></div>
        <div class="alloc-nums"><b class="${over ? 'down' : ''}">${s.pct}%</b> <span class="alloc-t">/ ${s.target}%</span></div>
      </div>`;
    })
    .join('');
  el.innerHTML = `
    <div class="alloc-head">
      <span>Invested <b>${d.investedPct}%</b></span>
      <span>Cash <b>${d.cashPct}%</b></span>
      <span class="ev-hint">bar fills to its sector target; over-target turns red</span>
    </div>
    <div class="alloc-list">${rows}</div>`;
}

function renderTrader(data) {
  const a = data.account; // shared paper account
  const ai = data.ai || { totalTrades: 0, openTrades: 0, closedTrades: 0, realizedPnL: 0 };
  $('#trader-account').innerHTML = `
    <div class="tile"><div class="tile-label">Account value <span class="ev-hint">(shared with Trade)</span></div><div class="tile-value">${usd(a.equity)}</div>
      <div class="tile-sub ${signClass(a.totalPnL)}">${pct(a.totalReturnPct)} all-time</div></div>
    <div class="tile"><div class="tile-label">Cash</div><div class="tile-value" style="font-size:16px">${usd(a.cash)}</div>
      <div class="tile-sub">invested ${usd(a.positionsValue)}</div></div>
    <div class="tile"><div class="tile-label">AI realized P/L</div><div class="tile-value ${signClass(ai.realizedPnL)}" style="font-size:16px">${usd(ai.realizedPnL)}</div>
      <div class="tile-sub">from closed bot trades</div></div>
    <div class="tile"><div class="tile-label">AI trades</div><div class="tile-value" style="font-size:16px">${ai.totalTrades}</div>
      <div class="tile-sub">${ai.openTrades} open · ${ai.closedTrades} closed</div></div>`;

  // diversification vs targets
  renderAllocation(data.diversification);

  // strategies
  const sEl = $('#trader-strategies');
  if (!data.strategies.length) {
    sEl.innerHTML =
      '<div class="trader-empty">No patterns yet. Go to the <a data-goto="analyst">AI Analyst</a>, find a scenario you like, and hit “Add this pattern to the AI Trader”.</div>';
  } else {
    sEl.innerHTML = data.strategies
      .map((s) => {
        const st = s.stats || {};
        const pnl = st.pnl || 0;
        return `
        <div class="strat-card ${s.enabled ? '' : 'strat-disabled'}">
          <label class="switch" title="Enable / disable">
            <input type="checkbox" class="strat-toggle" data-id="${s.id}" ${s.enabled ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
          <div class="strat-main">
            <div class="strat-name">${escapeHtml(s.name)}</div>
            <div class="strat-desc">${escapeHtml(s.interpretation)}</div>
            <div class="strat-since">Trading triggers since ${s.since ? new Date(s.since * 1000).toLocaleString() : 'activation'}${(st.trades || 0) === 0 ? ' · waiting for the next trigger' : ''}</div>
          </div>
          <div class="strat-stats">
            <div class="strat-stat"><div class="k">Trades</div><div class="v">${st.trades || 0}</div></div>
            <div class="strat-stat"><div class="k">Win rate</div><div class="v">${st.winRate == null ? '—' : st.winRate.toFixed(0) + '%'}</div></div>
            <div class="strat-stat"><div class="k">P/L</div><div class="v ${signClass(pnl)}">${usd(pnl)}</div></div>
          </div>
          <div class="strat-actions">
            <button class="strat-remove" data-id="${s.id}" title="Remove pattern">×</button>
          </div>
        </div>`;
      })
      .join('');
  }

  // trade log
  const tEl = $('#trader-trades');
  if (!data.trades.length) {
    tEl.innerHTML = data.strategies.length
      ? '<div class="trader-empty">No trades yet — the AI Trader only trades a pattern from the moment you add it, so it’s waiting for the next time one of your patterns triggers.</div>'
      : '<div class="trader-empty">No trades yet — add a pattern above.</div>';
  } else {
    const rows = data.trades
      .map(
        (t) => `
        <tr>
          <td>${t.entryDate}</td>
          <td>${t.symbol}</td>
          <td>${t.shares}</td>
          <td>${usd(t.entryPrice)}</td>
          <td>${t.exitPrice == null ? '—' : usd(t.exitPrice)}</td>
          <td class="${(t.pnl || 0) >= 0 ? 'up' : 'down'}">${t.pnl == null ? '—' : usd(t.pnl) + ' (' + sPct(t.pnlPct) + ')'}</td>
          <td>${t.status === 'open' ? '<span class="badge-open">open</span>' : '<span class="badge-closed">closed</span>'}</td>
          <td class="ev-hint" style="font-weight:400">${escapeHtml(t.strategyName)}</td>
        </tr>`
      )
      .join('');
    tEl.innerHTML = `
      <div class="ev-scroll" style="overflow-x:auto;max-height:460px"><table class="ev-table">
        <thead><tr><th>Entry date</th><th>Symbol</th><th>Shares</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Status</th><th>Pattern</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }
}

function initTrader() {
  $('#trader-reset').addEventListener('click', async () => {
    if (!confirm('Remove all patterns and reset the AI Trader to $100,000?')) return;
    try {
      renderTrader(await api('/api/aitrader/reset', { method: 'POST' }));
      toast('AI Trader reset.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const view = $('#view-trader');
  view.addEventListener('change', async (e) => {
    const tog = e.target.closest('.strat-toggle');
    if (!tog) return;
    try {
      renderTrader(
        await api(`/api/aitrader/strategies/${tog.dataset.id}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: tog.checked }),
        })
      );
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  view.addEventListener('click', async (e) => {
    const rm = e.target.closest('.strat-remove');
    if (rm) {
      try {
        renderTrader(await api(`/api/aitrader/strategies/${rm.dataset.id}`, { method: 'DELETE' }));
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const goto = e.target.closest('[data-goto]');
    if (goto) setView(goto.dataset.goto);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function initQuickPicks() {
  $('#quick-picks').innerHTML = QUICK_PICKS.map((s) => `<button class="quick-pick" data-sym="${s}">${s}</button>`).join('');
  $('#quick-picks').addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-pick');
    if (btn) loadSymbol(btn.dataset.sym);
  });
}

// ---------------------------------------------------------------------------
// AI Strategist
// ---------------------------------------------------------------------------
let strategistReady = false;
let strategistTimer = null;
async function initStrategist() {
  if (!strategistReady) {
    strategistReady = true;
    $('#strat-toggle').addEventListener('click', toggleStrategist);
  }
  refreshStrategist();
  if (strategistTimer) clearInterval(strategistTimer);
  // Poll while the tab is visible so the dashboard tracks the live engine.
  strategistTimer = setInterval(() => {
    if (!$('#view-strategist').hidden) refreshStrategist();
    else { clearInterval(strategistTimer); strategistTimer = null; }
  }, 4000);
}

async function toggleStrategist() {
  const btn = $('#strat-toggle');
  const wantEnable = btn.textContent.trim() === 'Resume';
  btn.disabled = true;
  try {
    const data = await api('/api/strategist/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: wantEnable }),
    });
    renderStrategist(data);
  } catch (err) {
    toast(`Could not ${wantEnable ? 'resume' : 'pause'}: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function refreshStrategist() {
  try {
    renderStrategist(await api('/api/strategist'));
  } catch {
    /* transient — next poll will retry */
  }
}

function agoLabel(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
const LOG_ICON = { discover: '🔎', promote: '⬆️', demote: '⬇️', pause: '⏸', resume: '▶️' };

function renderStrategist(data) {
  if (!data) return;

  // Live badge + pause/resume button reflect engine state.
  const badge = $('#strat-live');
  if (badge) {
    badge.textContent = data.enabled ? '● autonomous' : '● paused';
    badge.classList.toggle('paused', !data.enabled);
  }
  const tbtn = $('#strat-toggle');
  if (tbtn) tbtn.textContent = data.enabled ? 'Pause' : 'Resume';

  // Status strip.
  $('#strat-status').innerHTML = `
    <div class="strat-stat"><span class="strat-stat-v">${data.generation.toLocaleString()}</span><span class="strat-stat-k">generations</span></div>
    <div class="strat-stat"><span class="strat-stat-v">${data.poolSize}</span><span class="strat-stat-k">patterns explored</span></div>
    <div class="strat-stat"><span class="strat-stat-v">${data.qualified}</span><span class="strat-stat-k">qualified</span></div>
    <div class="strat-stat"><span class="strat-stat-v">${data.roster.length}/${data.targetRoster}</span><span class="strat-stat-k">live now</span></div>
    <div class="strat-stat"><span class="strat-stat-v">${data.running ? 'working…' : agoLabel(data.lastCycle)}</span><span class="strat-stat-k">last cycle</span></div>`;

  // Live roster.
  const roster = $('#strat-roster');
  if (!data.roster.length) {
    roster.innerHTML = '<div class="empty">Nothing live yet — the strategist promotes a pattern as soon as one clears the reward/risk bar.</div>';
  } else {
    roster.innerHTML = data.roster
      .map((r) => {
        const s = r.stats;
        return `<div class="strat-roster-row">
          <span class="dot live"></span>
          <span class="strat-roster-name">${escapeHtml(r.name)}</span>
          ${s ? `<span class="strat-chip">score <b>${s.score.toFixed(3)}</b></span>
                 <span class="strat-chip">win ${pctOnly(s.winRate)}</span>
                 <span class="strat-chip ${s.mean >= 0 ? 'up' : 'down'}">exp ${sPct(s.mean)}</span>
                 <span class="strat-chip">σ ${s.std.toFixed(1)}%</span>` : ''}
        </div>`;
      })
      .join('');
  }

  // Leaderboard.
  const rows = data.leaderboard
    .map((r, i) => {
      const s = r.stats;
      const tag = r.live ? '<span class="applied-tag">LIVE</span>' : r.qualified ? '<span class="active-tag">ready</span>' : '';
      return `<tr class="${r.live ? 'applied' : ''}">
        <td>${i + 1}</td>
        <td>${escapeHtml(r.label)} ${tag}</td>
        <td>${s.n}</td>
        <td class="${s.mean >= 0 ? 'up' : 'down'}">${sPct(s.mean)}</td>
        <td>${pctOnly(s.winRate)}</td>
        <td class="up">${sPct(s.avgWin)}</td>
        <td class="down">${sPct(s.avgLoss)}</td>
        <td>${s.std.toFixed(1)}%</td>
        <td><b>${s.score.toFixed(3)}</b></td>
      </tr>`;
    })
    .join('');
  $('#strat-leaderboard').innerHTML = data.leaderboard.length
    ? `<div style="overflow-x:auto"><table class="h-table">
        <thead><tr><th>#</th><th>Pattern</th><th>Occ.</th><th>Expected</th><th>Win</th>
          <th>Avg win</th><th>Avg loss</th><th>Risk (σ)</th><th>Score ★</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`
    : '<div class="empty">Warming up — scanning the pattern space…</div>';

  // Decision log.
  const log = $('#strat-log');
  log.innerHTML = data.log.length
    ? data.log
        .map(
          (e) => `<div class="strat-log-row strat-log-${e.type}">
            <span class="strat-log-ic">${LOG_ICON[e.type] || '•'}</span>
            <span class="strat-log-body"><b>${escapeHtml(e.label)}</b> — ${escapeHtml(e.detail || '')}</span>
            <span class="strat-log-ago">${agoLabel(e.ts)}</span>
          </div>`
        )
        .join('')
    : '<div class="empty">No decisions yet.</div>';
}

function boot() {
  initNav();
  initSearch();
  initChartControls();
  initTradePanel();
  initPortfolioInteractions();
  initQuickPicks();
  initAnalyst();
  initTrader();
  showConfig();
  refreshPortfolio();
  // Periodically re-mark the portfolio to live prices.
  setInterval(refreshPortfolio, 30_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
