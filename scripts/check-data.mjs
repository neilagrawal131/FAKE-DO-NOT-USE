// Preflight: confirm which data source is active and — for Polygon — that a real
// request actually succeeds, before you trust any backtest. Never prints the key.
//
//   npm run check            # probes AAPL
//   npm run check -- MSFT    # probe a different symbol
import '../server/loadenv.js';
import * as polygon from '../market_data/polygon.js';

const key = process.env.POLYGON_API_KEY;
const source = (process.env.DATA_SOURCE || (key ? 'polygon' : 'yahoo')).toLowerCase();

console.log(`Data source: ${source}`);
if (key) {
  const masked = key.length > 6 ? `${key.slice(0, 3)}…${key.slice(-2)}` : '***';
  console.log(`POLYGON_API_KEY: present (${masked})`);
} else {
  console.log('POLYGON_API_KEY: not set');
}

if (source === 'mock') {
  console.log('Mock mode — synthetic data, no network. Backtests will NOT reflect real markets.');
  process.exit(0);
}
if (source !== 'polygon' || !key) {
  console.log('\nNot configured for Polygon. To use real data, set POLYGON_API_KEY in .env');
  console.log('(Yahoo fallback works for casual use but is rate-limited and less complete.)');
  process.exit(key ? 0 : 1);
}

const sym = (process.argv[2] || 'AAPL').toUpperCase();
try {
  const t0 = Date.now();
  const ch = await polygon.chart(sym, '1mo', '1d');
  const n = ch && ch.bars ? ch.bars.length : 0;
  if (!n) throw new Error('no bars returned');
  const last = ch.bars[n - 1];
  console.log(
    `\n✓ Polygon reachable — ${sym}: ${n} daily bars, last close ${last.close} @ ${new Date(last.time * 1000)
      .toISOString()
      .slice(0, 10)} (${Date.now() - t0} ms)`
  );
  console.log('Real data is flowing. You can now run:  npm run momentum   (or  npm start  and open Factor Lab)');
  process.exit(0);
} catch (e) {
  console.error(`\n✗ Polygon request failed: ${e.message}`);
  if (/401|403|not authoriz|invalid/i.test(e.message)) console.error('  → Check the API key is correct and active on your Polygon account.');
  if (/429/i.test(e.message)) console.error('  → Rate limited. Free plans allow ~5 requests/min; wait and retry, or upgrade.');
  if (/allowlist|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|fetch failed/i.test(e.message)) console.error('  → Network cannot reach api.polygon.io from this machine.');
  process.exit(2);
}
