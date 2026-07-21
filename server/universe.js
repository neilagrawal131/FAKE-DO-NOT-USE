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
  market: {
    label: 'Broad market (large caps)',
    aliases: ['broad market', 'overall market', 'whole market', 's&p', 'sp500', 'all sectors', 'large cap', 'large caps'],
    symbols: ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'XOM', 'JNJ', 'V', 'PG', 'HD', 'BAC', 'KO', 'DIS', 'CVX', 'MRK', 'WMT', 'CAT', 'BA', 'AMD', 'NFLX', 'COST'],
  },
};

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
