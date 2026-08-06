import { PriceChart, CHART_COLORS } from './chart.js';
import { ema, sma } from './indicators.js';
import { fullStats, monteCarlo } from './stats.js';

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
  // Buying power = settled cash only (unsettled sale proceeds can't fund a buy).
  const buyingPower = window.__portfolio?.settledCash ?? window.__portfolio?.cash ?? 0;
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
      const bp = p.settledCash ?? p.cash;
      const unsettled = p.unsettledCash ?? 0;
      $('#buying-power').innerHTML =
        `Buying power: ${usd(bp)}` +
        (unsettled > 0.005 ? ` <span style="color:var(--text-faint)">· ${usd(unsettled)} unsettled</span>` : '');
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

  // Today's % change, relative to the start-of-day account value.
  const dayBase = p.equity - p.dayChange;
  const dayPct = dayBase > 0 ? (p.dayChange / dayBase) * 100 : 0;

  // summary tiles
  $('#summary-grid').innerHTML = `
    <div class="tile wide">
      <div class="tile-label">Account value</div>
      <div class="tile-value">${usd(p.equity)}</div>
      <div class="tile-sub ${signClass(p.dayChange)}">${p.dayChange >= 0 ? '▲' : '▼'} ${usd(Math.abs(p.dayChange))} (${pct(dayPct)}) today</div>
    </div>
    <div class="tile">
      <div class="tile-label">Cash</div>
      <div class="tile-value" style="font-size:15px">${usd(p.cash)}</div>
      ${p.unsettledCash > 0.005 ? `<div class="tile-sub">${usd(p.settledCash)} settled · ${usd(p.unsettledCash)} unsettled</div>` : '<div class="tile-sub">all settled</div>'}
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
      <div class="tile-sub">booked (closed + dividends)</div>
    </div>
    <div class="tile">
      <div class="tile-label">Unrealized P/L</div>
      <div class="tile-value ${signClass(p.unrealizedPnL)}" style="font-size:15px">${usd(p.unrealizedPnL)}</div>
      <div class="tile-sub">open positions</div>
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
      .map((o) =>
        o.side === 'dividend'
          ? `<div class="order-row">
          <span><span class="order-side dividend">div</span> ${o.symbol}</span>
          <span class="order-meta up">+${usd(o.amount)}</span>
        </div>`
          : `<div class="order-row">
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
  if (view === 'factorlab') initFactorLab();
}

async function showConfig() {
  try {
    const cfg = await api('/api/config');
    const base = cfg.source === 'mock' ? 'demo data' : 'live data';
    $('#rail-source').textContent = base;
    // Show how much data our own market database owns (updates periodically).
    const paintDb = async () => {
      try {
        const db = await api('/api/marketdb');
        if (db && db.bars > 0) {
          $('#rail-source').innerHTML = `${base}<br /><span class="rail-db">🗄 ${db.bars.toLocaleString()} bars · ${db.symbols} symbols</span>`;
        }
      } catch {
        /* ignore */
      }
    };
    paintDb();
    setInterval(paintDb, 60_000);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Floating market news (Trade page)
// ---------------------------------------------------------------------------
function newsAgo(iso) {
  try {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  } catch {
    return '';
  }
}
function renderNews(items) {
  const el = $('#news-cards');
  if (!el) return;
  const list = items || [];
  if (!list.length) {
    el.innerHTML = '<div class="empty">No market news right now.</div>';
    return;
  }
  // API returns most-important-first; the top story is rendered as a featured hero.
  el.innerHTML = list
    .map((a, i) => {
      const feat = i === 0;
      const img = a.imageUrl
        ? `<div class="news-img"><img src="${escapeHtml(a.imageUrl)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('ph');this.remove()"/></div>`
        : '<div class="news-img ph"></div>';
      const when = a.published ? newsAgo(a.published) : '';
      const href = a.url && a.url !== '#' ? ` href="${escapeHtml(a.url)}" target="_blank" rel="noopener"` : '';
      const tag = href ? 'a' : 'div';
      const top = feat ? '<span class="news-top">Top story</span>' : '';
      const desc =
        feat && a.description
          ? `<p class="news-desc">${escapeHtml(a.description)}</p>`
          : '';
      return `<${tag} class="news-card${feat ? ' feat' : ''}"${href}>
        ${img}
        <div class="news-body">
          ${top}
          <div class="news-title">${escapeHtml(a.title || '')}</div>
          ${desc}
          <div class="news-meta">
            <span class="news-pub">${escapeHtml(a.publisher || '')}${when ? ' · ' + when : ''}</span>
          </div>
        </div>
      </${tag}>`;
    })
    .join('');
}
async function loadNews() {
  try {
    renderNews(await api('/api/news'));
    const stamp = $('#news-updated');
    if (stamp) stamp.innerHTML = `<i class="pulse"></i>updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    /* keep the prior cards on a transient fetch failure */
  }
}
function initNews() {
  if (!$('#news-cards')) return;
  loadNews();
  // Keep the gallery reflecting the newest data.
  setInterval(loadNews, 60_000);
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
  analysis.wf = null; // out-of-sample validation is run on demand per analysis
  analysis.wfLoading = false;
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

// Chronologically-ordered primary-horizon returns from the active occurrence set,
// so path metrics (drawdown, equity curve, Monte Carlo) use the real sequence.
function primarySeries() {
  const H = analysis.res.primaryHorizon;
  const events = activeEvents()
    .filter((e) => e.returns[H] != null)
    .sort((a, b) => a.time - b.time);
  return { events, rets: events.map((e) => e.returns[H]) };
}

const fmtPF = (x) => (x === Infinity ? '∞' : x == null ? '—' : x.toFixed(2));

function qstat(label, value, cls, hint) {
  return `<div class="qstat">
    <div class="qstat-k">${label}</div>
    <div class="qstat-v ${cls || ''}">${value}</div>
    ${hint ? `<div class="qstat-h">${hint}</div>` : ''}
  </div>`;
}

// The quantitative "Event statistics" panel — replaces a bare win-rate with a
// full picture of reward, risk and reliability.
function renderEventStats(st, H) {
  if (!st || !st.n) return '';
  return `
    <div class="result-block">
      <h3>Event statistics <span class="ev-hint">— the ${hzLabel(H)} forward return across every occurrence</span></h3>
      <div class="qgrid">
        ${qstat('Occurrences', st.n)}
        ${qstat('Average return', sPct(st.mean), signClass(st.mean))}
        ${qstat('Median return', sPct(st.median), signClass(st.median))}
        ${qstat('Std deviation', st.stdev.toFixed(2) + '%', '', 'spread of outcomes')}
        ${qstat('Best gain', sPct(st.best), 'up')}
        ${qstat('Worst loss', sPct(st.worst), 'down')}
        ${qstat('95% conf. interval', `${sPct(st.ci95[0])} … ${sPct(st.ci95[1])}`, '', 'for the mean return')}
        ${qstat('Sharpe', st.sharpe.toFixed(2), signClass(st.sharpe), 'reward ÷ risk, per trade')}
        ${qstat('Sortino', st.sortino.toFixed(2), signClass(st.sortino), 'reward ÷ downside risk')}
        ${qstat('Profit factor', fmtPF(st.profitFactor), st.profitFactor >= 1 ? 'up' : 'down', 'gross gains ÷ losses')}
        ${qstat('Max drawdown', st.maxDrawdown.toFixed(2) + '%', 'down', 'compounded, in sequence')}
        ${qstat('Total return', sPct(st.totalReturn), signClass(st.totalReturn), 'compounded, all trades')}
      </div>
    </div>`;
}

// A compact vertical-bar histogram of Monte Carlo final returns; bars left of 0
// are red, right of 0 green.
function mcHistogram(hist) {
  const max = Math.max(...hist.counts, 1);
  return hist.counts
    .map((c, i) => {
      const x0 = hist.lo + i * hist.width;
      const neg = x0 + hist.width <= 0;
      const h = Math.round((c / max) * 100);
      return `<span class="mc-bar ${neg ? 'neg' : 'pos'}" style="height:${Math.max(3, h)}%" title="${x0.toFixed(1)}% to ${(x0 + hist.width).toFixed(1)}%: ${c} runs"></span>`;
    })
    .join('');
}

// Monte Carlo panel — resample the trades 1,000× to see the distribution of
// outcomes and whether the edge survives bad luck.
function renderMonteCarlo(rets) {
  const mc = monteCarlo(rets, { runs: 1000 });
  if (!mc) return '';
  const f = mc.final;
  const pcls = mc.pProfit >= 50 ? 'up' : 'down';
  return `
    <div class="result-block">
      <h3>Monte Carlo <span class="ev-hint">— ${mc.runs.toLocaleString()} resampled runs of ${mc.n} trades: does the edge survive bad luck?</span></h3>
      <div class="mc-top">
        <div class="mc-headline">
          <div class="mc-prob ${pcls}">${mc.pProfit.toFixed(1)}%</div>
          <div class="mc-prob-cap">of simulations ended <b>profitable</b></div>
        </div>
        <div class="mc-hist" title="Distribution of total return across ${mc.runs.toLocaleString()} runs">${mcHistogram(mc.hist)}</div>
      </div>
      <div style="overflow-x:auto"><table class="h-table">
        <thead><tr><th>Total return</th><th>Worst 5%</th><th>25th</th><th>Median</th><th>75th</th><th>Best 5%</th></tr></thead>
        <tbody><tr>
          <td>compounded</td>
          <td class="${signClass(f.p5)}">${sPct(f.p5)}</td>
          <td class="${signClass(f.p25)}">${sPct(f.p25)}</td>
          <td class="${signClass(f.median)}">${sPct(f.median)}</td>
          <td class="${signClass(f.p75)}">${sPct(f.p75)}</td>
          <td class="${signClass(f.p95)}">${sPct(f.p95)}</td>
        </tr></tbody>
      </table></div>
      <div class="summary-line">
        Median outcome <b class="${signClass(f.median)}">${sPct(f.median)}</b>; a bad-luck run (5th percentile)
        returns <b class="${signClass(f.p5)}">${sPct(f.p5)}</b> and draws down about
        <b class="down">${mc.drawdown.badCase.toFixed(1)}%</b> (worst of any run ${mc.drawdown.worst.toFixed(1)}%).
      </div>
    </div>`;
}

const REGIME_AXES = [
  {
    axis: 'direction',
    title: 'Market direction',
    order: ['bull', 'sideways', 'bear'],
    labels: { bull: '🐂 Bull', sideways: '➡︎ Sideways', bear: '🐻 Bear' },
  },
  {
    axis: 'vol',
    title: 'Volatility',
    order: ['low', 'normal', 'high'],
    labels: { low: 'Low vol', normal: 'Normal vol', high: 'High vol' },
  },
  {
    axis: 'structure',
    title: 'Structure',
    order: ['trending', 'mixed', 'meanrev'],
    labels: { trending: 'Trending', mixed: 'Mixed', meanrev: 'Mean-reverting' },
  },
];

function regimeRows(events, H, axis, order, labels) {
  const groups = {};
  for (const e of events) {
    const r = e.returns[H];
    if (r == null || !e.regime) continue;
    const k = e.regime[axis];
    if (!k) continue;
    (groups[k] || (groups[k] = [])).push(r);
  }
  return order
    .filter((k) => groups[k] && groups[k].length)
    .map((k) => ({ label: labels[k], st: fullStats(groups[k]) }));
}

// Performance broken out by market regime — three axes (direction, volatility,
// structure) so you can see where the pattern earns its edge and where it fails.
function renderRegimes(events, H) {
  if (!events.some((e) => e.regime)) return '';
  const blocks = REGIME_AXES.map(({ axis, title, order, labels }) => {
    const rows = regimeRows(events, H, axis, order, labels);
    if (!rows.length) return '';
    const body = rows
      .map(
        ({ label, st }) => `
        <tr>
          <td>${label}</td><td>${st.n}</td>
          <td class="${signClass(st.mean)}">${sPct(st.mean)}</td>
          <td class="${signClass(st.median)}">${sPct(st.median)}</td>
          <td>${pctOnly(st.winRate)}</td>
          <td class="${signClass(st.sharpe)}">${st.sharpe.toFixed(2)}</td>
          <td>${fmtPF(st.profitFactor)}</td>
        </tr>`
      )
      .join('');
    return `
      <div class="regime-card">
        <h4>${title}</h4>
        <div style="overflow-x:auto"><table class="h-table regime-table">
          <thead><tr><th>Regime</th><th>N</th><th>Avg</th><th>Median</th><th>Win%</th><th>Sharpe</th><th>PF</th></tr></thead>
          <tbody>${body}</tbody>
        </table></div>
      </div>`;
  })
    .filter(Boolean)
    .join('');
  if (!blocks) return '';
  return `
    <div class="result-block">
      <h3>Performance by market regime <span class="ev-hint">— where this pattern works, and where it doesn't</span></h3>
      <div class="regime-grid">${blocks}</div>
    </div>`;
}

// ---- Out-of-sample (walk-forward) validation --------------------------------
const wfDate = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '—');

function renderWalkForwardSection() {
  if (analysis.wfLoading) {
    return `<div class="result-block">
      <h3>Out-of-sample validation</h3>
      <div class="wf-loading">⏳ Running walk-forward across full history with realistic costs — scanning every name and rolling through train/test windows. This can take a moment…</div>
    </div>`;
  }
  if (analysis.wf) return renderWalkForward(analysis.wf);
  return `<div class="result-block wf-cta">
    <h3>Out-of-sample validation <span class="ev-hint">— the honest test: does this edge survive on unseen data, after costs?</span></h3>
    <p class="wf-intro">The statistics above are <b>in-sample</b> — measured on the same history the pattern was found in, with no trading costs. This runs a <b>walk-forward</b> test: it tunes the best hold horizon on a training window, then measures that choice on the <b>next, unseen</b> window — rolling forward through time — with commission, spread and slippage subtracted from every trade. Only the unseen results count.</p>
    <button class="btn-primary run-walkforward" id="run-walkforward" style="width:auto;padding:10px 18px">🔬 Run out-of-sample validation</button>
  </div>`;
}

async function runWalkForward() {
  analysis.wfLoading = true;
  renderResults();
  try {
    analysis.wf = await api('/api/walkforward', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: analysis.res.scenario }),
    });
  } catch (e) {
    analysis.wf = { error: e.message };
  } finally {
    analysis.wfLoading = false;
    renderResults();
  }
}

function wfCompareRow(label, inVal, outVal, hint) {
  return `<tr><td>${label}${hint ? ` <span class="wf-hint">${hint}</span>` : ''}</td><td>${inVal}</td><td class="wf-oos">${outVal}</td></tr>`;
}

function renderWalkForward(wf) {
  if (wf.error) {
    const msg =
      wf.error === 'no_data'
        ? 'Not enough history for these symbols to run a walk-forward test.'
        : `Walk-forward failed: ${escapeHtml(wf.error)}`;
    return `<div class="result-block"><h3>Out-of-sample validation</h3><div class="no-results">${msg}</div>
      <button class="btn-primary run-walkforward" id="run-walkforward" style="width:auto;padding:8px 16px;margin-top:10px">Try again</button></div>`;
  }
  const oos = wf.oosReturns || [];
  const is = wf.isReturns || [];
  const gross = wf.grossOosReturns || [];
  const c = wf.config || {};
  const costPct = wf.roundTripCostPct ?? 0;

  if (oos.length < 10) {
    return `<div class="result-block">
      <h3>Out-of-sample validation</h3>
      <div class="no-results">Inconclusive — only <b>${oos.length}</b> out-of-sample trade${oos.length === 1 ? '' : 's'} across ${wf.folds ? wf.folds.length : 0} window(s). Widen the universe or lengthen the history for a meaningful test.</div>
    </div>`;
  }

  const so = fullStats(oos, oos);
  const si = fullStats(is, is);
  const sg = fullStats(gross, gross);
  const mc = monteCarlo(oos, { runs: 1000 });
  const costDrag = sg.mean - so.mean;

  // Verdict — honest, cost- and out-of-sample-aware.
  let verdict;
  let vcls;
  let vsub;
  if (so.mean > 0 && mc && mc.pProfit >= 60) {
    verdict = '✓ Edge survives out-of-sample';
    vcls = 'wf-pass';
    vsub = 'Positive after costs on unseen data, and robust across resampling. Rare — worth validating further on a live paper account before funding.';
  } else if (so.mean > 0) {
    verdict = '~ Marginal / unproven';
    vcls = 'wf-warn';
    vsub = 'Barely positive out-of-sample after costs, but not robust to bad luck. Treat as noise until it proves out on more data.';
  } else {
    verdict = '✗ No edge survives costs + out-of-sample';
    vcls = 'wf-fail';
    vsub = 'On unseen data, after realistic costs, this loses money on average. The in-sample results were overfitting — do not fund this.';
  }

  const foldRows = (wf.folds || [])
    .map(
      (f) => `<tr>
        <td>${wfDate(f.testFrom)} → ${wfDate(f.testTo)}</td>
        <td>${hzLabel(f.horizon)}</td>
        <td>${f.nTrain}</td>
        <td>${f.nTest}</td>
        <td class="${signClass(f.oosMean)}">${f.oosMean == null ? '—' : sPct(f.oosMean)}</td>
      </tr>`
    )
    .join('');

  return `
    <div class="result-block wf-result">
      <h3>Out-of-sample validation <span class="ev-hint">— walk-forward, costs included · the number that actually matters</span></h3>

      <div class="wf-verdict ${vcls}">
        <div class="wf-verdict-head">${verdict}</div>
        <div class="wf-verdict-sub">${vsub}</div>
      </div>

      <div class="wf-grid">
        ${qstat('Out-of-sample avg', sPct(so.mean), signClass(so.mean), 'per trade, after costs')}
        ${qstat('OOS Sharpe', so.sharpe.toFixed(2), signClass(so.sharpe), 'reward ÷ risk')}
        ${qstat('OOS profit factor', fmtPF(so.profitFactor), so.profitFactor >= 1 ? 'up' : 'down')}
        ${qstat('OOS win rate', pctOnly(so.winRate))}
        ${qstat('OOS trades', so.n, '', `${wf.folds ? wf.folds.length : 0} test windows`)}
        ${mc ? qstat('MC profitable', mc.pProfit.toFixed(0) + '%', mc.pProfit >= 60 ? 'up' : 'down', 'of 1,000 resamples') : ''}
      </div>

      <h4 class="wf-sub">In-sample vs out-of-sample <span class="wf-hint">— the gap is the overfitting</span></h4>
      <div style="overflow-x:auto"><table class="h-table wf-compare">
        <thead><tr><th>Metric</th><th>In-sample</th><th>Out-of-sample</th></tr></thead>
        <tbody>
          ${wfCompareRow('Trades', si.n, so.n)}
          ${wfCompareRow('Avg return', sPct(si.mean), sPct(so.mean))}
          ${wfCompareRow('Median return', sPct(si.median), sPct(so.median))}
          ${wfCompareRow('Win rate', pctOnly(si.winRate), pctOnly(so.winRate))}
          ${wfCompareRow('Sharpe', si.sharpe.toFixed(2), so.sharpe.toFixed(2))}
          ${wfCompareRow('Sortino', si.sortino.toFixed(2), so.sortino.toFixed(2))}
          ${wfCompareRow('Profit factor', fmtPF(si.profitFactor), fmtPF(so.profitFactor))}
          ${wfCompareRow('Max drawdown', si.maxDrawdown.toFixed(1) + '%', so.maxDrawdown.toFixed(1) + '%')}
        </tbody>
      </table></div>

      <div class="wf-cost-note">
        <b>Cost impact:</b> commission ${wf.costs.commissionBps} bp + spread ${wf.costs.spreadBps} bp + slippage ${wf.costs.slippageBps} bp
        = <b>${(costPct).toFixed(2)}%</b> round-trip per trade. That drops the out-of-sample average from
        <b class="${signClass(sg.mean)}">${sPct(sg.mean)}</b> (gross) to
        <b class="${signClass(so.mean)}">${sPct(so.mean)}</b> (net).
      </div>

      <h4 class="wf-sub">Per test window <span class="wf-hint">— each row is unseen data; horizon was tuned on the prior window</span></h4>
      <div style="overflow-x:auto"><table class="h-table">
        <thead><tr><th>Test window</th><th>Horizon</th><th>Train trades</th><th>OOS trades</th><th>OOS avg</th></tr></thead>
        <tbody>${foldRows}</tbody>
      </table></div>

      <div class="disclaimer-sm">Walk-forward: train ${c.trainDays}d → test ${c.testDays}d, rolling; horizons tuned in-sample from ${(c.horizons || []).map((h) => hzLabel(h)).join(', ')}. Universe: ${wf.universe.symbolsWithData}/${wf.universe.symbolsRequested} ${escapeHtml(wf.universe.label || '')}. Costs and slippage are modeled estimates. Past performance does not predict future results.</div>
    </div>`;
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
    // The honest test: out-of-sample validation with realistic costs.
    parts.push(renderWalkForwardSection());
  }

  const events = activeEvents();
  const horizons = res.horizons || [1, 5, 10, 20];
  const stats = computeHorizonStats(events, horizons);
  const primary = stats.find((h) => h.days === res.primaryHorizon) || stats[0];

  if (primary && primary.n) {
    // Full quantitative event statistics (headline) — computed client-side from
    // the active occurrences so it recomputes live as occurrences are removed.
    const series = primarySeries();
    const st = fullStats(series.rets, series.rets);
    parts.push(renderEventStats(st, res.primaryHorizon));

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

    // Monte Carlo robustness + regime breakdown, both off the active occurrences.
    parts.push(renderMonteCarlo(series.rets));
    parts.push(renderRegimes(series.events, res.primaryHorizon));

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
  if (e.target.closest('.run-walkforward')) {
    runWalkForward();
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
      <div class="tile-sub">invested ${usd(a.positionsValue)}${a.unsettledCash > 0.005 ? ` · ${usd(a.unsettledCash)} unsettled` : ''}</div></div>
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
const LOG_ICON = { discover: '🔎', validate: '🔬', reject: '🚫', promote: '⬆️', demote: '⬇️', pause: '⏸', resume: '▶️' };

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
    <div class="strat-stat"><span class="strat-stat-v">${data.qualified}</span><span class="strat-stat-k">in-sample edge</span></div>
    <div class="strat-stat"><span class="strat-stat-v">${data.qualifiedLive ?? '—'}</span><span class="strat-stat-k">passed out-of-sample</span></div>
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
        const o = r.oos;
        return `<div class="strat-roster-row">
          <span class="dot live"></span>
          <span class="strat-roster-name">${escapeHtml(r.name)}</span>
          ${o ? `<span class="strat-chip oos">OOS <b class="${o.mean >= 0 ? 'up' : 'down'}">${sPct(o.mean)}</b> · ${o.n} trades</span>
                 <span class="strat-chip">OOS score <b>${o.score.toFixed(3)}</b></span>` : ''}
          ${s ? `<span class="strat-chip">in-sample ${sPct(s.mean)}</span>
                 <span class="strat-chip">win ${pctOnly(s.winRate)}</span>` : ''}
        </div>`;
      })
      .join('');
  }

  // Leaderboard.
  const rows = data.leaderboard
    .map((r, i) => {
      const s = r.stats;
      const o = r.oos;
      // Tag reflects the gate: LIVE (trading), OOS ✓ (passed, promotable),
      // OOS ✗ (validated but failed), ⏳ (in-sample edge, awaiting validation).
      let tag = '';
      if (r.live) tag = '<span class="applied-tag">LIVE</span>';
      else if (r.oosPassed) tag = '<span class="active-tag">OOS ✓</span>';
      else if (r.oosValidated) tag = '<span class="fail-tag">OOS ✗</span>';
      else if (r.qualified) tag = '<span class="pending-tag">⏳ validating</span>';
      const oosCell = o
        ? `<span class="${o.mean >= 0 ? 'up' : 'down'}">${sPct(o.mean)}</span> <span class="oos-n">${o.n}</span>`
        : '<span class="oos-n">—</span>';
      return `<tr class="${r.live ? 'applied' : ''}">
        <td>${i + 1}</td>
        <td>${escapeHtml(r.label)} ${tag}</td>
        <td>${s.n}</td>
        <td class="${s.mean >= 0 ? 'up' : 'down'}">${sPct(s.mean)}</td>
        <td>${oosCell}</td>
        <td>${pctOnly(s.winRate)}</td>
        <td>${s.std.toFixed(1)}%</td>
        <td>${o ? '<b>' + o.score.toFixed(3) + '</b>' : '<span class="oos-n">' + s.score.toFixed(3) + ' IS</span>'}</td>
      </tr>`;
    })
    .join('');
  $('#strat-leaderboard').innerHTML = data.leaderboard.length
    ? `<div style="overflow-x:auto"><table class="h-table">
        <thead><tr><th>#</th><th>Pattern</th><th>Occ.</th><th>In-sample</th><th>Out-of-sample</th><th>Win</th>
          <th>Risk (σ)</th><th>Score ★</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <div class="disclaimer-sm">Score ★ is the <b>out-of-sample</b>, cost-adjusted reward/risk once validated (falls back to in-sample "IS" until then). Only patterns marked <b>OOS ✓</b> can be promoted to live trading.</div>`
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

// ---------------------------------------------------------------------------
// Factor Lab — cross-sectional momentum
// ---------------------------------------------------------------------------
const factorLab = { inited: false, loading: false };

// Growth-of-$1 equity curve as a scaled SVG (breakeven line dashed).
function equitySvg(curve) {
  if (!curve || curve.length < 2) return '';
  const W = 680;
  const H = 150;
  const pad = 6;
  const min = Math.min(...curve, 1);
  const max = Math.max(...curve, 1);
  const span = max - min || 1;
  const x = (i) => pad + (i / (curve.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const pts = curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const last = curve[curve.length - 1];
  const color = last >= 1 ? 'var(--up)' : 'var(--down)';
  const yBreak = y(1).toFixed(1);
  return `<svg class="fl-eq" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="equity curve">
    <polyline points="${pad},${H - pad} ${pts} ${W - pad},${H - pad}" fill="${color}" fill-opacity="0.08" stroke="none"/>
    <line x1="${pad}" y1="${yBreak}" x2="${W - pad}" y2="${yBreak}" stroke="var(--border-strong)" stroke-dasharray="3 3" stroke-width="1"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/>
  </svg>`;
}

async function runMomentum() {
  factorLab.loading = true;
  $('#fl-results').innerHTML = '<div class="wf-loading">⏳ Loading full history for the universe, ranking every rebalance, and validating out-of-sample with costs… this can take a moment.</div>';
  const config = {
    universe: $('#fl-universe').value,
    topK: Number($('#fl-topk').value),
    weighting: $('#fl-weighting').value,
    lookbackMonths: Number($('#fl-lookback').value),
  };
  try {
    const res = await api('/api/momentum', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    renderMomentum(res);
  } catch (e) {
    $('#fl-results').innerHTML = `<div class="no-results">Backtest failed: ${escapeHtml(e.message)}</div>`;
  } finally {
    factorLab.loading = false;
  }
}

function renderMomentum(res) {
  const out = $('#fl-results');
  if (res.error) {
    out.innerHTML = `<div class="no-results">${res.error === 'insufficient_universe' ? 'Not enough symbols with history for this universe.' : escapeHtml(res.error)}</div>`;
    return;
  }
  const d = res.direct;
  const w = res.walkforward;
  const is = d.summary;
  const oos = w && !w.error ? w.summary : null;

  // Verdict from the OUT-OF-SAMPLE result (the number that matters).
  let verdict;
  let vcls;
  let vsub;
  if (oos && oos.n >= 6 && oos.annReturn > 0 && oos.annSharpe >= 0.5) {
    verdict = '✓ Edge survives out-of-sample';
    vcls = 'wf-pass';
    vsub = 'Positive risk-adjusted return on unseen data after costs. Validate further on a live paper account before funding — and expect long drawdowns even when the edge is real.';
  } else if (oos && oos.n >= 6 && oos.annReturn > 0) {
    verdict = '~ Weak / unproven out-of-sample';
    vcls = 'wf-warn';
    vsub = 'Barely positive out-of-sample after costs, with a low Sharpe. Treat as noise until it proves out on more data or a broader universe.';
  } else if (oos && oos.n >= 6) {
    verdict = '✗ No edge survives costs + out-of-sample';
    vcls = 'wf-fail';
    vsub = 'On unseen data, after costs, this does not pay. Momentum may still be real on a bigger/real universe — but on this test it is not investable.';
  } else {
    verdict = 'Inconclusive — not enough out-of-sample history';
    vcls = 'wf-warn';
    vsub = 'Too few out-of-sample periods to judge. Needs more history than this data source provides here.';
  }

  const foldRows = (w && w.folds ? w.folds : [])
    .map(
      (f) => `<tr>
        <td>${new Date(f.trainTo * 1000).toISOString().slice(0, 10)} → ${new Date(f.testTo * 1000).toISOString().slice(0, 10)}</td>
        <td>${f.lookbackMonths}mo</td>
        <td>${f.topK}</td>
        <td>${f.nTest}</td>
        <td class="${signClass(f.oosMean)}">${f.oosMean == null ? '—' : sPct(f.oosMean)}</td>
      </tr>`
    )
    .join('');

  const holds = (d.latest || [])
    .map((h) => `<span class="fl-hold"><b>${h.symbol}</b> <span class="fl-hold-w">${h.weight}%</span> <span class="${h.momentum >= 0 ? 'up' : 'down'}">${sPct(h.momentum)}</span></span>`)
    .join('');

  out.innerHTML = `
    <div class="result-block">
      <div class="wf-verdict ${vcls}">
        <div class="wf-verdict-head">${verdict}</div>
        <div class="wf-verdict-sub">${vsub}</div>
      </div>

      <h4 class="wf-sub">Out-of-sample (walk-forward, cost-adjusted) <span class="wf-hint">— the number that matters</span></h4>
      <div class="wf-grid">
        ${oos ? qstat('OOS return / yr', sPct(oos.annReturn), signClass(oos.annReturn), 'annualized, after costs') : ''}
        ${oos ? qstat('OOS Sharpe', oos.annSharpe.toFixed(2), signClass(oos.annSharpe), 'annualized') : ''}
        ${oos ? qstat('OOS max drawdown', oos.maxDrawdown.toFixed(1) + '%', 'down') : ''}
        ${oos ? qstat('OOS months', oos.n, '', `${w.folds.length} windows`) : ''}
      </div>

      <h4 class="wf-sub">In-sample equity curve <span class="wf-hint">— growth of $1, full history (optimistic — not the verdict)</span></h4>
      ${equitySvg(is.equity)}
      <div class="wf-grid" style="margin-top:10px">
        ${qstat('In-sample return / yr', sPct(is.annReturn), signClass(is.annReturn), 'annualized')}
        ${qstat('In-sample Sharpe', is.annSharpe.toFixed(2), signClass(is.annSharpe))}
        ${qstat('Volatility / yr', is.annVol.toFixed(1) + '%')}
        ${qstat('Max drawdown', is.maxDrawdown.toFixed(1) + '%', 'down')}
        ${qstat('Total return', sPct(is.totalReturn), signClass(is.totalReturn), `${is.n} months`)}
      </div>

      ${foldRows ? `<h4 class="wf-sub">Per test window <span class="wf-hint">— lookback & hold-count tuned in-sample, measured out-of-sample</span></h4>
        <div style="overflow-x:auto"><table class="h-table">
          <thead><tr><th>Test window</th><th>Lookback</th><th>Hold</th><th>Months</th><th>Avg / mo</th></tr></thead>
          <tbody>${foldRows}</tbody></table></div>` : ''}

      <h4 class="wf-sub">Portfolio it would hold now <span class="wf-hint">— top ${res.config.topK} by momentum, ${res.config.weighting === 'equal' ? 'equal' : 'inverse-vol'} weighted</span></h4>
      <div class="fl-holds">${holds || '<span class="oos-n">—</span>'}</div>

      <div class="disclaimer-sm">Universe: ${res.universe.symbolsWithData}/${res.universe.symbolsRequested} — ${escapeHtml(res.universe.label)}. 12-minus-1 momentum, monthly rebalance; walk-forward tunes lookback ${(w.grid ? w.grid.lookbackMonths : []).map((l) => l + 'mo').join('/')} and hold ${(w.grid ? w.grid.topKs : []).join('/')} on ${w.trainDays ? Math.round(w.trainDays / 365) : '?'}y train → ${w.testDays ? Math.round(w.testDays / 365) : '?'}y test. Costs modeled (commission + spread + slippage). Past performance does not predict future results.</div>
    </div>`;
}

async function initFactorLab() {
  if (factorLab.inited) return;
  factorLab.inited = true;
  // Populate universe options with sectors, keeping "All" first.
  try {
    const sectors = await api('/api/sectors');
    const sel = $('#fl-universe');
    for (const s of sectors) {
      const o = document.createElement('option');
      o.value = s.key;
      o.textContent = `${s.label} (${s.count})`;
      sel.appendChild(o);
    }
  } catch {
    /* keep just "All" */
  }
  $('#fl-run').addEventListener('click', runMomentum);
  runMomentum(); // run once on first open
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
  initNews();
  showConfig();
  refreshPortfolio();
  // Re-mark the portfolio to live prices frequently so each position's unrealized
  // P&L updates in ~real time (prices themselves refresh on the server's data
  // cache interval, ~10s, so this polls a little faster than that).
  setInterval(refreshPortfolio, 4_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
