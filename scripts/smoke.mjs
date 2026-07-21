// Headless browser smoke test. Requires `npm i --no-save playwright` and a
// running server (DATA_SOURCE=mock PORT=3111 npm start).
// Set CHROME_PATH to a chromium binary if Playwright's own download is absent.
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || '/tmp/shot.png';
const launchOpts = {};
const envPath = process.env.CHROME_PATH;
if (envPath && existsSync(envPath)) launchOpts.executablePath = envPath;
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto('http://localhost:3111', { waitUntil: 'networkidle' });

// Load a symbol via a quick pick.
await page.click('.quick-pick[data-sym="AAPL"]');
await page.waitForSelector('#detail:not([hidden])');
await page.waitForFunction(() => document.querySelector('#d-price')?.textContent?.includes('$'), { timeout: 8000 });
// wait for chart canvas + stats
await page.waitForSelector('#chart canvas', { timeout: 8000 });
await page.waitForFunction(() => document.querySelectorAll('#stat-grid .stat').length > 5, { timeout: 8000 });
await page.waitForTimeout(600);

// Read a few rendered values
const info = await page.evaluate(() => ({
  symbol: document.querySelector('#d-symbol').textContent,
  price: document.querySelector('#d-price').textContent,
  exchange: document.querySelector('#d-exchange').textContent,
  stats: document.querySelectorAll('#stat-grid .stat').length,
  legend: document.querySelector('#chart-legend').textContent.trim().slice(0, 80),
  spread: document.querySelector('#d-spread').textContent.trim(),
  interval: document.querySelector('#tf-interval').textContent.trim(),
  hasCanvas: !!document.querySelector('#chart canvas'),
}));
console.log('DETAIL:', JSON.stringify(info));

const buyNote = await page.evaluate(() => document.querySelector('#fill-note').textContent.trim());
console.log('BUY FILL NOTE:', buyNote);

// Place a buy order.
await page.fill('#shares-input', '15');
await page.click('#submit-order');
await page.waitForFunction(() => document.querySelector('#trade-msg')?.textContent?.includes('Filled'), { timeout: 8000 });
const afterTrade = await page.evaluate(() => ({
  msg: document.querySelector('#trade-msg').textContent,
  equity: document.querySelector('#account-equity').textContent,
  positions: document.querySelectorAll('#positions .pos-row').length,
  orders: document.querySelectorAll('#orders .order-row').length,
}));
console.log('TRADE:', JSON.stringify(afterTrade));

// Cycle through several candle intervals and confirm the label updates.
for (const tf of ['1m', '3h', '1W', '1Mo']) {
  await page.click(`#timeframes button[data-tf="${tf}"]`);
  await page.waitForTimeout(500);
  const label = await page.evaluate(() => document.querySelector('#tf-interval').textContent.trim());
  console.log(`TF ${tf} -> label:`, label);
}

// Toggle an indicator off.
await page.click('#indicator-toggles label:has-text("EMA 100")');
const ema100off = await page.evaluate(() => !document.querySelector('#indicator-toggles input[data-ind="ema100"]').checked);
console.log('EMA100 toggled off:', ema100off);
await page.waitForTimeout(300);

await page.screenshot({ path: OUT, fullPage: true });
console.log('ERRORS:', errors.length ? JSON.stringify(errors) : 'none');
console.log('SHOT:', OUT);
await browser.close();
