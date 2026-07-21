// Turns a plain-English scenario into a structured, backtestable spec.
// This is a deterministic keyword/regex parser (not an LLM) — it always shows
// the user exactly how it interpreted their request, and every field can be
// overridden from the UI.

import { resolveSector, sectorLabel } from './universe.js';

const DEFAULT_HORIZONS = [1, 5, 10, 20];
const DEFAULT_PRIMARY = 10;
const DEFAULT_LOOKBACK_DAYS = 180; // ~6 months

// Parse free text -> { scenario, warnings }.
export function parseScenario(text) {
  const q = String(text || '');
  const lower = q.toLowerCase();
  const warnings = [];

  // --- sector ---
  let sectorKey = resolveSector(lower);
  if (!sectorKey) {
    sectorKey = 'market';
    warnings.push('No sector detected — analyzing a broad large-cap universe. Name a sector (e.g. "biotech", "semiconductors") to focus it.');
  }

  // --- lookback period ---
  let lookbackDays = DEFAULT_LOOKBACK_DAYS;
  const lb = lower.match(/(?:past|last|previous|over(?:\s+the)?|within(?:\s+the)?)\s+(\d+)\s*[-\s]?(day|days|week|weeks|month|months|year|years|yr|yrs)/);
  if (lb) {
    lookbackDays = toDays(parseInt(lb[1], 10), lb[2]);
  } else {
    warnings.push('No time window detected — defaulting to the past 6 months.');
  }

  // --- conditions ---
  const conditions = [];

  // Moving-average cross / position.
  // Captures period, optional ema/sma, and above/below direction.
  const maRe = /(\d+)\s*[-\s]?day\s*(exponential|simple|ema|sma)?\s*(?:moving\s*average|moving\s*avg|movingaverage|\bma\b|\bema\b|\bsma\b)/g;
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

  // Single-day move ("rises more than 5%", "drops 3%").
  const upMove = lower.match(/(?:rises?|gains?|jumps?|climbs?|surges?|up)\s*(?:more\s*than|over|by|at\s*least)?\s*(\d+(?:\.\d+)?)\s*%/);
  const downMove = lower.match(/(?:falls?|drops?|declines?|loses?|down|sinks?)\s*(?:more\s*than|over|by|at\s*least)?\s*(\d+(?:\.\d+)?)\s*%/);
  // Only treat these as day-moves if a % is present (avoids clashing with "rises above MA").
  if (upMove) conditions.push({ kind: 'day_change', dir: 'up', pct: parseFloat(upMove[1]) });
  if (downMove) conditions.push({ kind: 'day_change', dir: 'down', pct: parseFloat(downMove[1]) });

  if (conditions.length === 0) {
    warnings.push('No trigger condition detected. Try phrases like "crosses above its 100-day moving average" or "volume over 100,000".');
  }

  // --- forward horizon ---
  let primaryHorizon = DEFAULT_PRIMARY;
  const horizons = [...DEFAULT_HORIZONS];
  const hz = lower.match(/(?:next|following|forward|over\s+the\s+next|after)\s+(\d+)\s*(day|days|week|weeks)/);
  if (hz) {
    const days = /week/.test(hz[2]) ? parseInt(hz[1], 10) * 5 : parseInt(hz[1], 10);
    primaryHorizon = days;
    if (!horizons.includes(days)) horizons.push(days);
    horizons.sort((a, b) => a - b);
  }

  const scenario = {
    sectorKey,
    lookbackDays,
    horizons,
    primaryHorizon,
    conditions,
  };
  return { scenario, warnings };
}

// Fill defaults / clamp a scenario coming from the UI form.
export function normalizeScenario(s = {}) {
  const scenario = {
    sectorKey: s.sectorKey || 'market',
    lookbackDays: clamp(Number(s.lookbackDays) || DEFAULT_LOOKBACK_DAYS, 20, 365 * 6),
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
  const parts = [];
  for (const c of s.conditions) {
    if (c.kind === 'ma_cross') parts.push(`price crosses ${c.dir} its ${c.period}-day ${c.maType.toUpperCase()}`);
    else if (c.kind === 'ma_state') parts.push(`price is ${c.dir} its ${c.period}-day ${c.maType.toUpperCase()}`);
    else if (c.kind === 'volume') parts.push(`volume ${c.op === '>' ? 'above' : 'below'} ${c.value.toLocaleString('en-US')}`);
    else if (c.kind === 'day_change') parts.push(`the stock ${c.dir === 'up' ? 'rises' : 'falls'} ${c.pct}%+ in a day`);
  }
  const cond = parts.length ? parts.join(' AND ') : 'any day';
  const months = (s.lookbackDays / 30).toFixed(s.lookbackDays % 30 ? 1 : 0);
  return `In ${sectorLabel(s.sectorKey)}, over the past ~${months} months, when ${cond} — what did the stock do over the next ${s.primaryHorizon} trading days?`;
}

// ---- helpers ----
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
