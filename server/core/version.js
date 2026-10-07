import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * Versionskennung der installierten Programmdateien (aus Dateinamen, Größen und Änderungszeiten von server/ und public/).
 * Ändert sich bei jedem Update; Browser nutzen sie, um veralteten lokalen Zustand zu erkennen und sich selbst zu erneuern.
 */
function scan(dir, h) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) scan(p, h);
    else { const s = statSync(p); h.update(`${p.slice(ROOT.length)}:${s.size}:${Math.floor(s.mtimeMs)}|`); }
  }
}
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const APP_VERSION = (() => {
  try { const h = createHash('sha1'); scan(join(ROOT, 'server'), h); scan(join(ROOT, 'public'), h); return h.digest('hex').slice(0, 12); } catch { return String(Date.now()); }
})();
