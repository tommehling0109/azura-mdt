import { get, run, now } from './db.js';

/**
 * Standard-Ränge der Organisation (aufsteigend). Jeder Rang ist dem nächsthöheren untergeordnet (Hierarchie für die Namensanzeige).
 * Wird einmalig bei der Einrichtung angelegt (bzw. beim Start, wenn das System noch keine Ränge hat) – danach frei änderbar.
 */
const RANKS = [
  ['Aspirante', 'Anwärter / Neuling', 'Beobachtet und lernt die internen Abläufe kennen. Unterstützt höhergestellte Mitglieder bei einfachen Aufgaben.'],
  ['Cocinero / Técnico', 'Koch / Techniker', 'Kümmert sich um Versorgung, Ausrüstung, Fahrzeuge und technische Angelegenheiten.'],
  ['Halcón', 'Beobachter / Späher', 'Sammelt Informationen und meldet verdächtige Aktivitäten an die Führung.'],
  ['Sicario', 'Ausführendes Mitglied', 'Übernimmt Schutz- und Einschüchterungsaufgaben innerhalb der Organisation.'],
  ['Sicario Élite', 'Elite-Mitglied', 'Besonders erfahrenes und vertrauenswürdiges Mitglied. Wird für wichtige Aufgaben eingesetzt.'],
  ['Teniente', 'Leutnant / Unterführer', 'Führt kleinere Gruppen und sorgt dafür, dass Anweisungen der Führung umgesetzt werden.'],
  ['Capitán', 'Hauptmann / Kommandant', 'Führt mehrere Mitglieder und koordiniert größere Bereiche der Organisation.'],
  ['Jefe de Plaza', 'Leiter eines Gebiets', 'Verantwortlich für eine bestimmte Stadt oder Region und die dortigen Mitglieder.'],
  ['Jefe de Zona', 'Zonenleiter', 'Kontrolliert mehrere Gebiete und koordiniert deren Führungskräfte.'],
  ['Licenciado del Cártel', 'Kartell-Anwalt', 'Rechtlicher Berater der Organisation. Kümmert sich um Verträge, rechtliche Fragen, Verhandlungen und berät die Führung.'],
  ['Consejero', 'Oberster Berater', 'Vertrauensperson der Führung. Entwickelt Strategien und berät bei wichtigen Entscheidungen.'],
  ['La Mano Azul', 'Rechte Hand', 'Stellvertreter des obersten Anführers. Überwacht die Führungsebene und setzt deren Entscheidungen durch.'],
  ['El Azur Supremo', 'Oberster Anführer', 'Höchste Autorität. Trifft die endgültigen Entscheidungen und steht an der Spitze der gesamten Organisation.'],
];
/** Farbverlauf von Grau (unten) über Blau bis Gold (Spitze) */
const COLORS = ['#94a3b8', '#8da2bd', '#7a9bc4', '#6a93cc', '#5b8def', '#4f7be0', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#f59e0b', '#f97316', '#facc15'];

export function seedRanks() {
  if (get("SELECT 1 x FROM sequences WHERE name = 'ranks_seeded'")) return false;
  run("INSERT INTO sequences (name,next_value) VALUES ('ranks_seeded',1)");
  if (get('SELECT 1 x FROM ranks LIMIT 1')) return false; // es gibt schon eigene Ränge – nichts überschreiben
  const ids = [];
  RANKS.forEach(([name, title, text], i) => {
    const res = run('INSERT INTO ranks (name,description,color,sort_order,parent_rank_id,created_at) VALUES (?,?,?,?,NULL,?)', name, `${title} – ${text}`, COLORS[i], i + 1, now());
    ids.push(Number(res.lastInsertRowid));
  });
  ids.forEach((id, i) => { if (i < ids.length - 1) run('UPDATE ranks SET parent_rank_id = ? WHERE id = ?', ids[i + 1], id); }); // Vorgesetzter Rang = nächsthöherer
  return true;
}
