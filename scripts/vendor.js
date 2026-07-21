// Copies the standalone Lightweight Charts build into public/vendor so the
// front-end has no runtime CDN dependency (works fully offline / air-gapped).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(
  root,
  'node_modules',
  'lightweight-charts',
  'dist',
  'lightweight-charts.standalone.production.js'
);
const destDir = join(root, 'public', 'vendor');
const dest = join(destDir, 'lightweight-charts.standalone.production.js');

try {
  if (!existsSync(src)) {
    console.warn('[vendor] lightweight-charts not found in node_modules; skipping.');
    process.exit(0);
  }
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  console.log('[vendor] Copied lightweight-charts into public/vendor.');
} catch (err) {
  console.warn('[vendor] Could not vendor charts:', err.message);
}
