// Turns a plain-English scenario into a structured, backtestable spec.
// This is a deterministic keyword/regex parser (not an LLM) — it always shows
// the user exactly how it interpreted their request, and every field can be
// overridden from the UI.

import { resolveSector, sectorLabel, resolveSymbol } from './universe.js';

const DEFAULT_HORIZONS = [1, 5, 10, 20];
const DEFAULT_PRIMARY = 10;
const DEFAULT_LOOKBACK_DAYS = 180; // ~6 months

// Parse free text -> { scenario, warnings }.
export function parseScenario(text) {
  const q = String(text || '');
  const lower = q.toLowerCase();
  const warnings = [];

  // --- scope: a specific stock takes priority over a sector ---
  const symbol = resolveSymbol(q);
  let sectorKey = null;
  if (!symbol) {
    sectorKey = resolveSector(lower);
    if (!sectorKey) {
      sectorKey = 'market';
      warnings.push('No stock or sector detected — analyzing a broad large-cap universe. Name a ticker (e.g. "NVDA") or a sector (e.g. "biotech") to focus it.');
    }
  }

  // --- lookback period (how far back to analyze) ---
  let lookbackDays = DEFAULT_LOOKBACK_DAYS;
  const lb = lower.match(/(?:past|last|previous|prior|trailing|recent|over(?:\s+the)?|within(?:\s+the)?|during(?:\s+the)?)\s+(\d+)?\s*[-\s]?(day|days|week|weeks|month|months|year|years|yr|yrs)/);
  if (lb) {
    lookbackDays = toDays(lb[1] ? parseInt(lb[1], 10) : 1, lb[2]);
  } else {
    warnings.push('No time window detected — defaulting to the past 6 months. Add e.g. "over the past 2 years".');
  }

  // --- conditions ---
  const conditions = [];

  // Opening-range / time-of-day context: "first 30 minutes", "9:30-10:00",
  // "at the open", "opening range", "initial move". Triggers only on the first
  // 30-minute bar of each session and forces intraday analysis.
  const openingCtx =
    /\b(first\s+(?:30|thirty)\s*[-\s]?(?:min|mins|minute|minutes)|opening\s+(?:range|30|thirty|move|bar|half[-\s]?hour|minutes?|candle)|at\s+the\s+open|first\s+half[-\s]?hour|9\s*:?\s*30\s*(?:-|–|to|until|thru|through)\s*10\s*:?\s*00|initial\s+(?:move|30|drop|gain|pop))\b/.test(lower);

  // Moving-average cross / position.
  // Captures period, optional ema/sma, and above/below direction.
  const maRe = /(\d+)\s*[-\s]?(?:day|bar|period)?s?\s*(exponential|simple|ema|sma)?\s*(?:moving\s*average|moving\s*avg|movingaverage|\bma\b|\bema\b|\bsma\b)/g;
  let m;
  while ((m = maRe.exec(lower)) !== null) {
    const period = parseInt(m[1], 10);
    const typeWord = m[2] || '';
    const maType = /ema|exponential/.test(typeWord) || /\bema\b/.test(m[0]) ? 'ema' : 'sma';
    // Direction + cross-vs-state: look at the ~40 chars before the match.
    const ctx = lower.slice(Math.max(0, m.index - 45), m.index + m[0].length);
    const below = /\b(below|under|beneath|drops?\s+below|falls?\s+below)\b/.test(ctx);
    const dir = below ? 'below' : 'above';
    const isState = /\b(is|are|trading|stays?|remains?|sits?|holds?)\b/.test(ctx) && !/\b(cross|crosses|rise|rises|rose|break|breaks|move|moves|go|goes|jump|jumps|fall|falls|drop|drops)\b/.test(ctx);
    conditions.push({ kind: isState ? 'ma_state' : 'ma_cross', dir, maType, period });
  }

  // Volume threshold.
  const volRe = /volume\s*(?:is\s+|of\s+|that\s+is\s+|at\s+|was\s+)?(?:(over|above|greater\s*than|more\s*than|at\s*least|exceed(?:s|ing)?|>)|(below|under|less\s*than|<))?\s*\$?([\d,\.]+)\s*([kmb])?/;
  const vm = lower.match(volRe);
  if (vm) {
    const op = vm[2] ? '<' : '>';
    const value = parseAbbrevNumber(vm[3], vm[4]);
    if (value != null) conditions.push({ kind: 'volume', op, value });
  }

  if (openingCtx) {
    // Opening move: the first 30-min bar's open-to-close return >= X%.
    // Handles "initial move is +5% or more", "opens up 5%", "gaps down 4%".
    const pm = lower.match(/([+\-])?\s*(\d+(?:\.\d+)?)\s*%/);
    if (pm) {
      const pct = parseFloat(pm[2]);
      const near = lower;
      const down = pm[1] === '-' || /\b(down|drop|drops|dropped|fall|falls|fell|decline|declines|lower|negative|red|sell[-\s]?off|loses?)\b/.test(near);
      const up = pm[1] === '+' || /\b(up|gain|gains|rise|rises|pop|pops|green|higher|positive|surge|surges|rally|rallies)\b/.test(near);
      const dir = down && !up ? 'down' : 'up';
      conditions.push({ kind: 'opening_move', dir, pct });
    }
  } else {
    // Single-bar move ("rises more than 5%", "drops 3%"). A % must be present.
    const upMove = lower.match(/(?:rises?|gains?|jumps?|climbs?|surges?|up)\s*(?:more\s*than|over|by|at\s*least)?\s*(\d+(?:\.\d+)?)\s*%/);
    const downMove = lower.match(/(?:falls?|drops?|declines?|loses?|down|sinks?)\s*(?:more\s*than|over|by|at\s*least)?\s*(\d+(?:\.\d+)?)\s*%/);
    if (upMove) conditions.push({ kind: 'day_change', dir: 'up', pct: parseFloat(upMove[1]) });
    if (downMove) conditions.push({ kind: 'day_change', dir: 'down', pct: parseFloat(downMove[1]) });
  }

  // Fair value gap (3-candle imbalance). "bullish/bearish fair value gap", "fvg",
  // "imbalance", optionally sized ("fair value gap of at least 0.5%").
  const fvgMatch = lower.match(/\b(?:fair[-\s]*value[-\s]*gaps?|fvgs?|imbalances?)\b/);
  if (fvgMatch) {
    const idx = fvgMatch.index;
    const ctx = lower.slice(Math.max(0, idx - 32), idx + fvgMatch[0].length + 12);
    const dir = /\b(bearish|bear|sell[-\s]?side|downside|down|short)\b/.test(ctx) ? 'bearish' : 'bullish';
    let minPct = null;
    const sizeM = lower
      .slice(idx, idx + 60)
      .match(/(?:of|at\s*least|bigger\s*than|larger\s*than|over|greater\s*than|>=?)\s*(\d+(?:\.\d+)?)\s*%/);
    if (sizeM) minPct = parseFloat(sizeM[1]);
    conditions.push({ kind: 'fvg', dir, minPct });
  }

  if (conditions.length === 0) {
    warnings.push('No trigger condition detected. Try phrases like "crosses above its 100-day moving average" or "volume over 100,000".');
  }

  // --- forward horizon (how long to measure the move) ---
  // A sub-daily horizon OR an opening-range condition puts the analysis on
  // 30-minute intraday bars.
  const ph = parseHorizon(lower);
  const hasOpening = conditions.some((c) => c.kind === 'opening_move');
  const intraday = hasOpening || (ph && ph.minutes != null);
  let timeframe = 'daily';
  let barMinutes = null;
  let primaryHorizon;
  let horizons;
  if (intraday) {
    timeframe = 'intraday';
    barMinutes = 30;
    const mins = ph && ph.minutes != null ? ph.minutes : 30;
    primaryHorizon = Math.max(1, Math.round(mins / 30));
    horizons = uniqSort([1, 2, 4, 13, primaryHorizon]); // 30m, 1h, 2h, 1 session
    if (lookbackDays > 30) {
      warnings.push('Intraday (30-minute) history from the data source only goes back ~30 days, so the window is limited to the last 30 days (a multi-year intraday backtest isn\'t available here).');
      lookbackDays = 30;
    }
    if (conditions.some((c) => c.kind === 'ma_cross' || c.kind === 'ma_state')) {
      warnings.push('Intraday mode: moving-average periods are counted in 30-minute bars (not days), and volume is per 30-minute bar.');
    }
  } else {
    primaryHorizon = ph && ph.days ? ph.days : DEFAULT_PRIMARY;
    horizons = uniqSort([...DEFAULT_HORIZONS, primaryHorizon]);
  }

  const scenario = {
    symbol: symbol || null,
    sectorKey,
    lookbackDays,
    timeframe,
    barMinutes,
    horizons,
    primaryHorizon,
    conditions,
  };
  return { scenario, warnings };
}

// Fill defaults / clamp a scenario coming from the UI form.
export function normalizeScenario(s = {}) {
  const timeframe = s.timeframe === 'intraday' ? 'intraday' : 'daily';
  const scenario = {
    symbol: s.symbol ? String(s.symbol).toUpperCase() : null,
    sectorKey: s.symbol ? null : s.sectorKey || 'market',
    lookbackDays: clamp(Number(s.lookbackDays) || DEFAULT_LOOKBACK_DAYS, 20, timeframe === 'intraday' ? 30 : 365 * 6),
    timeframe,
    barMinutes: timeframe === 'intraday' ? 30 : null,
    horizons: Array.isArray(s.horizons) && s.horizons.length ? s.horizons.map(Number).filter((n) => n > 0) : [...DEFAULT_HORIZONS],
    primaryHorizon: Number(s.primaryHorizon) || DEFAULT_PRIMARY,
    conditions: Array.isArray(s.conditions) ? s.conditions : [],
  };
  if (!scenario.horizons.includes(scenario.primaryHorizon)) {
    scenario.horizons.push(scenario.primaryHorizon);
    scenario.horizons.sort((a, b) => a - b);
  }
  return scenario;
}

// Human-readable one-liner describing the scenario.
export function describeScenario(s) {
  const intraday = s.timeframe === 'intraday';
  const unit = intraday ? 'bar' : 'day';
  const parts = [];
  for (const c of s.conditions) {
    if (c.kind === 'ma_cross') parts.push(`price crosses ${c.dir} its ${c.period}-${unit} ${c.maType.toUpperCase()}`);
    else if (c.kind === 'ma_state') parts.push(`price is ${c.dir} its ${c.period}-${unit} ${c.maType.toUpperCase()}`);
    else if (c.kind === 'volume') parts.push(`volume ${c.op === '>' ? 'above' : 'below'} ${c.value.toLocaleString('en-US')}${intraday ? ' per 30-min bar' : ''}`);
    else if (c.kind === 'day_change') parts.push(`the ${intraday ? 'bar' : 'stock'} ${c.dir === 'up' ? 'rises' : 'falls'} ${c.pct}%+ ${intraday ? 'in a 30-min bar' : 'in a day'}`);
    else if (c.kind === 'fvg') parts.push(`a ${c.dir} fair value gap forms${c.minPct != null ? ` (≥ ${c.minPct}%)` : ''}`);
    else if (c.kind === 'opening_move') parts.push(`the opening 30-minute move is ${c.dir === 'up' ? '+' : '−'}${c.pct}% or more`);
  }
  const cond = parts.length ? parts.join(' AND ') : intraday ? 'any bar' : 'any day';
  const window = describeWindow(s.lookbackDays) + (intraday ? ' of 30-minute bars' : '');
  const hz = horizonLabelLong(s.primaryHorizon, s.timeframe);
  if (s.symbol) {
    return `For ${s.symbol}, over the past ${window}, when ${cond} — what did it do over the next ${hz}?`;
  }
  return `In ${sectorLabel(s.sectorKey)}, over the past ${window}, when ${cond} — what did the stock do over the next ${hz}?`;
}

function describeWindow(days) {
  if (days >= 360) {
    const y = days / 365;
    return `${y % 1 === 0 ? y : y.toFixed(1)} year${y >= 2 ? 's' : ''}`;
  }
  const m = days / 30;
  return `~${m % 1 === 0 ? m : m.toFixed(1)} months`;
}

// ---- helpers ----

// Parse a forward horizon. Returns { minutes } for sub-daily horizons (which put
// the analysis into 30-minute intraday mode) or { days } for daily+ horizons.
function parseHorizon(s) {
  // Intraday: minutes / hours.
  let m = s.match(/(?:next|following|forward|over\s+the\s+(?:next|following)|after|hold(?:ing)?\s+for|held\s+for|within)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)/);
  if (m) return { minutes: /hour|hr/.test(m[2]) ? parseInt(m[1], 10) * 60 : parseInt(m[1], 10) };
  m = s.match(/(\d+)\s*(minutes?|mins?|hours?|hrs?)\s+(?:later|after|out|forward|ahead)/);
  if (m) return { minutes: /hour|hr/.test(m[2]) ? parseInt(m[1], 10) * 60 : parseInt(m[1], 10) };
  if (/\bhalf\s+an?\s+hour\b/.test(s)) return { minutes: 30 };
  if (/\b(?:next\s+hour|over\s+the\s+next\s+hour|an?\s+hour\s+(?:later|after|out|forward|ahead)|within\s+an?\s+hour)\b/.test(s)) return { minutes: 60 };

  // Daily+: days / weeks / months / sessions.
  m = s.match(/(?:next|following|forward|over\s+the\s+(?:next|following)|after|hold(?:ing)?\s+for|held\s+for)\s+(\d+)\s*(day|days|week|weeks|month|months|session|sessions)/);
  if (m) return { days: horizonDays(parseInt(m[1], 10), m[2]) };
  m = s.match(/(\d+)\s*(day|days|week|weeks|month|months|session|sessions)\s+(?:later|after|out|forward|ahead)/);
  if (m) return { days: horizonDays(parseInt(m[1], 10), m[2]) };
  m = s.match(/\b(?:a|one)\s+(day|week|month)\s+(?:later|after|out|forward|ahead)/);
  if (m) return { days: horizonDays(1, m[1]) };
  return null;
}
function horizonDays(n, unit) {
  if (/month/.test(unit)) return n * 21; // ~21 trading days / month
  if (/week/.test(unit)) return n * 5; // 5 trading days / week
  return n; // day / session
}

const uniqSort = (arr) => [...new Set(arr)].sort((a, b) => a - b);

// Long human label for a horizon expressed in base bars (days, or 30-min bars).
export function horizonLabelLong(bars, timeframe) {
  if (timeframe === 'intraday') {
    const mins = bars * 30;
    if (mins < 60) return `${mins} minutes`;
    if (mins % 390 === 0) return `${mins / 390} trading day${mins / 390 > 1 ? 's' : ''}`;
    if (mins % 60 === 0) return `${mins / 60} hour${mins / 60 > 1 ? 's' : ''}`;
    return `${mins} minutes`;
  }
  return `${bars} trading day${bars > 1 ? 's' : ''}`;
}

function toDays(n, unit) {
  if (/year|yr/.test(unit)) return n * 365;
  if (/month/.test(unit)) return n * 30;
  if (/week/.test(unit)) return n * 7;
  return n;
}
function parseAbbrevNumber(numStr, suffix) {
  let v = parseFloat(String(numStr).replace(/,/g, ''));
  if (Number.isNaN(v)) return null;
  const s = (suffix || '').toLowerCase();
  if (s === 'k') v *= 1e3;
  else if (s === 'm') v *= 1e6;
  else if (s === 'b') v *= 1e9;
  return Math.round(v);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
