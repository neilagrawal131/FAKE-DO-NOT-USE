import { PriceChart, CHART_COLORS } from './chart.js';

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
  timeframe: '1M',
  side: 'buy',
  chart: null,
};

const INTRADAY_TF = new Set(['1D', '5D', '1M']);
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
}

function renderStats(q) {
  const rows = [
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

function applyQuickQty(qv) {
  const q = state.quote;
  if (!q || !q.price) return;
  const input = $('#shares-input');
  const buyingPower = window.__portfolio?.cash ?? 0;
  const held = heldShares(state.symbol);

  if (qv === 'Max') input.value = Math.floor(buyingPower / q.price);
  else if (qv === 'All') input.value = held;
  else if (qv.endsWith('%')) {
    const frac = parseInt(qv) / 100;
    if (state.side === 'buy') input.value = Math.floor((buyingPower * frac) / q.price);
    else input.value = Math.floor(held * frac);
  } else input.value = qv;

  renderTradeEstimate();
}

function renderTradeEstimate() {
  const q = state.quote;
  const shares = Number($('#shares-input').value) || 0;
  const price = q?.price ?? 0;
  const cost = shares * price;
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
    const p = await api('/api/portfolio');
    applyPortfolio(p);
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

  // orders
  const orderEl = $('#orders');
  if (!p.orders.length) {
    orderEl.innerHTML = '<div class="empty">No orders yet.</div>';
  } else {
    orderEl.innerHTML = p.orders
      .slice(0, 30)
      .map(
        (o) => `
        <div class="order-row">
          <span><span class="order-side ${o.side}">${o.side}</span> ${o.symbol}</span>
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
// Boot
// ---------------------------------------------------------------------------
function initQuickPicks() {
  $('#quick-picks').innerHTML = QUICK_PICKS.map((s) => `<button class="quick-pick" data-sym="${s}">${s}</button>`).join('');
  $('#quick-picks').addEventListener('click', (e) => {
    const btn = e.target.closest('.quick-pick');
    if (btn) loadSymbol(btn.dataset.sym);
  });
}

function boot() {
  initSearch();
  initChartControls();
  initTradePanel();
  initPortfolioInteractions();
  initQuickPicks();
  refreshPortfolio();
  // Periodically re-mark the portfolio to live prices.
  setInterval(refreshPortfolio, 30_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
