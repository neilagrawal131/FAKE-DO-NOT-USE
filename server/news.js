// Market-news helpers: rate an article's importance (for color-coding) and a
// synthetic feed so the news layer works in demo mode / without a Polygon key.

// Market-moving words weigh more than routine ones.
const HIGH_WORDS = [
  'fed', 'fomc', 'rate cut', 'rate hike', 'interest rate', 'recession', 'inflation', 'crash', 'plunge',
  'soar', 'surge', 'acquisition', 'merger', 'bankruptcy', 'lawsuit', 'fraud', 'earnings', 'guidance',
  'downgrade', 'upgrade', 'tariff', 'jobs report', 'default', 'bailout', 'sanction', 'antitrust',
];
const MED_WORDS = [
  'analyst', 'price target', 'forecast', 'outlook', 'partnership', 'launch', 'deal', 'revenue', 'profit',
  'dividend', 'buyback', 'ceo', 'factory', 'supply', 'sales', 'stake', 'raises', 'cuts',
];

// Returns 'high' | 'medium' | 'low'.
export function scoreImportance(a) {
  const t = `${a.title || ''} ${a.description || ''}`.toLowerCase();
  let s = 0;
  for (const w of HIGH_WORDS) if (t.includes(w)) s += 2;
  for (const w of MED_WORDS) if (t.includes(w)) s += 1;
  s += Math.min(3, (a.tickers || []).length); // broad-impact stories mention more tickers
  if (Array.isArray(a.insights) && a.insights.some((i) => i.sentiment === 'positive' || i.sentiment === 'negative')) s += 1;
  return s >= 5 ? 'high' : s >= 2 ? 'medium' : 'low';
}

export function importanceRank(level) {
  return level === 'high' ? 3 : level === 'medium' ? 2 : 1;
}

// A synthetic feed (no external images) for demo mode / when no key is present.
export function mockNews() {
  const now = Date.now();
  const mins = (m) => new Date(now - m * 60000).toISOString();
  return [
    { id: 'm1', title: 'Fed signals it may cut interest rates as inflation cools', description: 'Officials hint at a rate cut at the next FOMC meeting.', publisher: 'Markets Wire', url: '#', imageUrl: null, tickers: ['SPY', 'QQQ', 'JPM', 'BAC'], published: mins(8) },
    { id: 'm2', title: 'NVIDIA shares surge after blowout earnings beat guidance', description: 'Data-center revenue soars; analysts raise price targets.', publisher: 'TechDesk', url: '#', imageUrl: null, tickers: ['NVDA', 'AMD', 'AVGO'], published: mins(21) },
    { id: 'm3', title: 'SEC charges investment firm in alleged fraud scheme', description: 'Regulators allege misled investors over several years.', publisher: 'RegWatch', url: '#', imageUrl: null, tickers: ['XYZ'], published: mins(35) },
    { id: 'm4', title: 'Analyst upgrades Apple, lifts price target on services growth', description: 'Sees continued margin expansion into next year.', publisher: 'StreetView', url: '#', imageUrl: null, tickers: ['AAPL'], published: mins(52) },
    { id: 'm5', title: 'Oil prices climb on supply concerns in the Gulf', description: 'Energy names rally as crude tops recent range.', publisher: 'EnergyNow', url: '#', imageUrl: null, tickers: ['XOM', 'CVX', 'COP'], published: mins(66) },
    { id: 'm6', title: 'Markets steady ahead of Friday jobs report', description: 'Traders await payrolls for rate-path clues.', publisher: 'Markets Wire', url: '#', imageUrl: null, tickers: ['SPY', 'DIA'], published: mins(80) },
    { id: 'm7', title: 'Tesla announces new gigafactory and production deal', description: 'Expansion aimed at boosting output next year.', publisher: 'AutoBeat', url: '#', imageUrl: null, tickers: ['TSLA'], published: mins(95) },
    { id: 'm8', title: 'Retail sales data in focus as consumer spending holds', description: 'Consumer names mixed ahead of the release.', publisher: 'EconDaily', url: '#', imageUrl: null, tickers: ['WMT', 'TGT', 'COST'], published: mins(120) },
    { id: 'm9', title: 'Gold holds near record as investors seek safety', description: 'Bullion steady amid rate uncertainty.', publisher: 'CommodityDesk', url: '#', imageUrl: null, tickers: ['GLD'], published: mins(140) },
    { id: 'm10', title: 'Small-cap stocks see modest gains in quiet session', description: 'Breadth improves slightly on the day.', publisher: 'MarketPulse', url: '#', imageUrl: null, tickers: ['IWM'], published: mins(165) },
  ];
}
