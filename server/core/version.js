import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/**
 * Versionskennung der installierten Programmdateien (Hash über Dateinamen UND Inhalt von server/ und public/ – unabhängig von Änderungszeiten, die in Docker-Images oft vereinheitlicht sind).
 * Ändert sich bei jedem Update; Browser nutzen sie, um veralteten lokalen Zustand zu erkennen und sich selbst zu erneuern.
 */
function scan(dir, h) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) scan(p, h);
    else { h.update(`${p.slice(ROOT.length)}|`); h.update(readFileSync(p)); }
  }
}
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const APP_VERSION = (() => {
  try { const h = createHash('sha1'); scan(join(ROOT, 'server'), h); scan(join(ROOT, 'public'), h); return h.digest('hex').slice(0, 12); } catch { return String(Date.now()); }
})();
