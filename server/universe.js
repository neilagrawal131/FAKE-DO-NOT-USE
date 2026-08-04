// Curated, liquid NYSE/NASDAQ tickers grouped by sector. The AI Analyst scans
// these universes when backtesting a scenario. Kept to ~20 names each to bound
// how many symbols a single analysis has to fetch.

export const SECTORS = {
  biotech: {
    label: 'Biotech / Healthcare',
    aliases: ['biotech', 'biotechnology', 'pharma', 'pharmaceutical', 'pharmaceuticals', 'healthcare', 'health care', 'health', 'drug', 'drugs', 'life sciences'],
    symbols: ['MRNA', 'BNTX', 'VRTX', 'REGN', 'GILD', 'AMGN', 'BIIB', 'ILMN', 'INCY', 'BMRN', 'SRPT', 'NBIX', 'ALNY', 'IONS', 'EXEL', 'HALO', 'RARE', 'UTHR', 'JAZZ', 'NVAX'],
  },
  technology: {
    label: 'Technology / Software',
    aliases: ['tech', 'technology', 'software', 'saas', 'internet', 'cloud'],
    symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NFLX', 'CRM', 'ADBE', 'ORCL', 'NOW', 'INTU', 'SNOW', 'SHOP', 'UBER', 'PLTR', 'PANW', 'CRWD', 'DDOG', 'NET', 'ABNB'],
  },
  semiconductors: {
    label: 'Semiconductors',
    aliases: ['semi', 'semis', 'semiconductor', 'semiconductors', 'chip', 'chips', 'chipmaker'],
    symbols: ['NVDA', 'AMD', 'INTC', 'AVGO', 'QCOM', 'MU', 'TXN', 'AMAT', 'LRCX', 'KLAC', 'ADI', 'MRVL', 'ON', 'MCHP', 'NXPI', 'MPWR', 'SWKS', 'QRVO', 'TER', 'ENTG'],
  },
  financials: {
    label: 'Financials / Banks',
    aliases: ['financial', 'financials', 'finance', 'bank', 'banks', 'banking'],
    symbols: ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BLK', 'SCHW', 'AXP', 'USB', 'PNC', 'TFC', 'COF', 'BK', 'MET', 'AIG', 'PRU', 'ALL', 'DFS', 'FITB'],
  },
  energy: {
    label: 'Energy / Oil & Gas',
    aliases: ['energy', 'oil', 'gas', 'oil and gas', 'petroleum', 'crude'],
    symbols: ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'HAL', 'DVN', 'FANG', 'KMI', 'WMB', 'HES', 'BKR', 'MRO', 'CTRA', 'APA', 'OKE'],
  },
  consumer: {
    label: 'Consumer / Retail',
    aliases: ['consumer', 'retail', 'retailer', 'consumer discretionary', 'discretionary'],
    symbols: ['TSLA', 'HD', 'MCD', 'NKE', 'SBUX', 'LOW', 'TGT', 'LULU', 'CMG', 'BKNG', 'MAR', 'GM', 'F', 'ROST', 'YUM', 'DG', 'DLTR', 'EBAY', 'TJX', 'ORLY'],
  },
  staples: {
    label: 'Consumer Staples',
    aliases: ['staples', 'consumer staples', 'defensive', 'food', 'beverage', 'beverages'],
    symbols: ['KO', 'PEP', 'PG', 'COST', 'WMT', 'MDLZ', 'CL', 'KMB', 'GIS', 'MO', 'PM', 'KHC', 'STZ', 'HSY', 'K', 'SYY', 'KR', 'ADM', 'CHD', 'CLX'],
  },
  industrials: {
    label: 'Industrials',
    aliases: ['industrial', 'industrials', 'manufacturing', 'aerospace', 'defense'],
    symbols: ['BA', 'CAT', 'GE', 'HON', 'UPS', 'RTX', 'DE', 'LMT', 'MMM', 'UNP', 'GD', 'NOC', 'EMR', 'ETN', 'ITW', 'CSX', 'FDX', 'NSC', 'WM', 'PH'],
  },
  communication: {
    label: 'Communication / Media',
    aliases: ['communication', 'communications', 'media', 'telecom', 'telecommunications', 'entertainment'],
    symbols: ['GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'CHTR', 'WBD', 'EA', 'TTWO', 'OMC', 'PARA', 'FOXA', 'LYV', 'MTCH', 'PINS', 'SNAP', 'ROKU'],
  },
  utilities: {
    label: 'Utilities',
    aliases: ['utility', 'utilities', 'power', 'electric', 'electricity', 'water utility'],
    symbols: ['NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL', 'ED', 'WEC', 'ES', 'PEG', 'AEE', 'DTE', 'PPL', 'FE', 'ETR', 'EIX', 'AWK', 'CMS'],
  },
  market: {
    label: 'Broad market (large caps)',
    aliases: ['broad market', 'overall market', 'whole market', 's&p', 'sp500', 'all sectors', 'large cap', 'large caps'],
    symbols: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'JNJ', 'V', 'PG', 'HD', 'BAC', 'KO', 'DIS', 'CVX', 'MRK', 'WMT', 'CAT', 'BA', 'AMD', 'NFLX', 'COST'],
  },
};

// ---- target portfolio diversification ----------------------------------------
// Desired share of the portfolio per sector (the AI Trader keeps its deployed
// capital within these caps). Weights sum to 1.0. Keys are SECTORS keys.
export const SECTOR_TARGETS = {
  technology: 0.25,     // highest liquidity, strong intraday movement
  consumer: 0.15,       // Consumer Discretionary — high volatility (TSLA/AMZN-type)
  financials: 0.12,     // different macro drivers, good liquidity
  biotech: 0.1,         // Health Care — defensive + news-driven
  industrials: 0.1,     // economic-cycle exposure
  energy: 0.08,         // commodity-driven volatility
  communication: 0.08,  // large liquid names, catalysts
  semiconductors: 0.07, // high volatility, correlated with tech
  staples: 0.03,        // low volatility, diversification
  utilities: 0.02,      // defensive hedge
};

// Every sector that carries a diversification target (excludes the overlapping
// "market" universe). Used as the AI Strategist's exploration universe so every
// pattern it trades maps to a target bucket.
export const TARGET_SECTORS = Object.keys(SECTOR_TARGETS);

// ---- per-sector trading style ------------------------------------------------
// Volatile sectors are traded actively (short holds, quick targets/stops so we
// take the swings); stable sectors are held as long-term positions (long holds,
// wide targets/stops so normal wobble doesn't shake us out). These parameters
// drive BOTH the pattern scoring (so the ranking reflects the style) and live
// exits, keeping them consistent.
const STYLE_TIERS = {
  // fast, active trading
  volatile: { horizons: [2, 3, 5], target: 0.06, stop: 0.04, trail: 0.025, trailArm: 0.03 },
  // the middle-ground default
  moderate: { horizons: [5, 10, 15], target: 0.08, stop: 0.05, trail: 0.03, trailArm: 0.04 },
  // slow, long-term holds
  stable: { horizons: [20, 30, 45, 60], target: 0.14, stop: 0.09, trail: 0.05, trailArm: 0.07 },
};
const SECTOR_TIER = {
  technology: 'volatile',
  semiconductors: 'volatile',
  energy: 'volatile',
  consumer: 'volatile', // consumer discretionary — TSLA/AMZN-type volatility
  financials: 'moderate',
  industrials: 'moderate',
  communication: 'moderate',
  biotech: 'stable', // health care
  staples: 'stable', // consumer staples
  utilities: 'stable',
};
export function sectorStyle(key) {
  const tier = SECTOR_TIER[key] || 'moderate';
  return { tier, ...STYLE_TIERS[tier] };
}

// Canonical single sector for a symbol, resolving universe overlaps by priority
// (e.g. GOOGL/META -> communication, NVDA -> semiconductors, AAPL -> technology)
// so portfolio exposure can be attributed to exactly one target bucket.
const SECTOR_PRIORITY = ['semiconductors', 'biotech', 'energy', 'financials', 'industrials', 'utilities', 'staples', 'consumer', 'communication', 'technology'];
const SYMBOL_SECTOR = (() => {
  const m = {};
  for (const key of SECTOR_PRIORITY) {
    for (const sym of SECTORS[key]?.symbols || []) {
      if (!(sym in m)) m[sym] = key;
    }
  }
  return m;
})();
export function symbolSector(symbol) {
  return SYMBOL_SECTOR[String(symbol || '').toUpperCase()] || null;
}
export function sectorTarget(key) {
  return SECTOR_TARGETS[key] ?? null;
}

// Match a free-text fragment to a sector key. Returns null if nothing matches.
export function resolveSector(text) {
  const t = (text || '').toLowerCase();
  // Prefer the longest alias match so "consumer staples" beats "consumer".
  let best = null;
  let bestLen = 0;
  for (const [key, s] of Object.entries(SECTORS)) {
    for (const alias of s.aliases) {
      if (t.includes(alias) && alias.length > bestLen) {
        best = key;
        bestLen = alias.length;
      }
    }
  }
  return best;
}

// ---- single-ticker resolution -------------------------------------------------

// Every symbol we know about (union of all sector universes) for bareword matching.
export const KNOWN_TICKERS = new Set(
  Object.values(SECTORS).flatMap((s) => s.symbols)
);

// Common company names -> ticker, so "analyze Apple" works as well as "AAPL".
export const NAME_TO_TICKER = {
  apple: 'AAPL', microsoft: 'MSFT', google: 'GOOGL', alphabet: 'GOOGL',
  amazon: 'AMZN', meta: 'META', facebook: 'META', tesla: 'TSLA',
  nvidia: 'NVDA', netflix: 'NFLX', 'advanced micro devices': 'AMD',
  intel: 'INTC', broadcom: 'AVGO', qualcomm: 'QCOM', micron: 'MU',
  moderna: 'MRNA', biontech: 'BNTX', 'vertex': 'VRTX', regeneron: 'REGN',
  gilead: 'GILD', amgen: 'AMGN', biogen: 'BIIB', illumina: 'ILMN',
  salesforce: 'CRM', adobe: 'ADBE', oracle: 'ORCL', palantir: 'PLTR',
  uber: 'UBER', airbnb: 'ABNB', shopify: 'SHOP', snowflake: 'SNOW',
  'coca cola': 'KO', 'coca-cola': 'KO', pepsi: 'PEP', pepsico: 'PEP',
  disney: 'DIS', walmart: 'WMT', costco: 'COST', target: 'TGT',
  starbucks: 'SBUX', nike: 'NKE', mcdonalds: 'MCD', "mcdonald's": 'MCD',
  boeing: 'BA', caterpillar: 'CAT', jpmorgan: 'JPM', 'jp morgan': 'JPM',
  'bank of america': 'BAC', goldman: 'GS', 'goldman sachs': 'GS',
  exxon: 'XOM', chevron: 'CVX', ford: 'F', 'general motors': 'GM',
};

// Uppercase tokens that look like tickers but almost never are the target here.
const TICKER_STOPWORDS = new Set([
  'MA', 'EMA', 'SMA', 'US', 'USA', 'AI', 'ETF', 'IPO', 'CEO', 'YTD', 'NYSE',
  'NASDAQ', 'PE', 'EPS', 'MACD', 'RSI', 'ATH', 'AND', 'OR', 'THE', 'IN', 'ON',
  'IT', 'AT', 'OF', 'TO', 'VS', 'ADR', 'API',
]);

// Detect a specific stock in free text. Priority: $cashtag > company name >
// an uppercase bareword that matches a known ticker. Returns a ticker or null.
export function resolveSymbol(text) {
  const raw = String(text || '');

  const cash = raw.match(/\$([A-Za-z]{1,5})\b/);
  if (cash) return cash[1].toUpperCase();

  const lower = raw.toLowerCase();
  let best = null;
  let bestLen = 0;
  for (const [name, tk] of Object.entries(NAME_TO_TICKER)) {
    const re = new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
    if (re.test(lower) && name.length > bestLen) {
      best = tk;
      bestLen = name.length;
    }
  }
  if (best) return best;

  // Uppercase 2-5 letter tokens (case-sensitive) that are known tickers.
  const tokens = raw.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const tok of tokens) {
    if (TICKER_STOPWORDS.has(tok)) continue;
    if (KNOWN_TICKERS.has(tok)) return tok;
  }
  return null;
}

export function sectorList() {
  return Object.entries(SECTORS).map(([key, s]) => ({
    key,
    label: s.label,
    count: s.symbols.length,
  }));
}

export function sectorSymbols(key) {
  return SECTORS[key]?.symbols || [];
}

export function sectorLabel(key) {
  return SECTORS[key]?.label || key;
}
