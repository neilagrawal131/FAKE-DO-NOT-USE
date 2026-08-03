// Durable JSON persistence shared by the portfolio, AI Trader and Strategist.
//
// Two guarantees so state can never be silently wiped on reload/restart:
//   1. ATOMIC writes — serialize to a temp file then rename over the target
//      (rename is atomic on the same filesystem), so a process killed mid-write
//      (e.g. `node --watch` restarting, or a crash) can never leave a truncated,
//      unparseable file.
//   2. Safe load — on a successful read we keep a `.bak` copy; if the primary is
//      ever corrupt we fall back to that backup before starting fresh, and we
//      preserve the bad file as `.corrupt` instead of overwriting it.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function saveJSON(file, data) {
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file); // atomic replace — never a partially written primary
    return true;
  } catch (err) {
    console.error(`[store] save failed for ${file}: ${err.message}`);
    return false;
  }
}

// Load JSON from `file`, tolerating corruption. Returns `fallback()` (a fresh
// state) only when neither the primary nor its backup can be read.
export function loadJSON(file, fallback) {
  const bak = `${file}.bak`;
  // Primary.
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      try { copyFileSync(file, bak); } catch { /* backup is best-effort */ }
      return data;
    } catch (err) {
      console.error(`[store] ${file} is corrupt (${err.message}); trying backup`);
      try { copyFileSync(file, `${file}.corrupt`); } catch { /* keep evidence */ }
    }
  }
  // Backup.
  if (existsSync(bak)) {
    try {
      const data = JSON.parse(readFileSync(bak, 'utf8'));
      console.error(`[store] restored ${file} from backup`);
      return data;
    } catch { /* fall through to fresh */ }
  }
  return fallback ? fallback() : null;
}
