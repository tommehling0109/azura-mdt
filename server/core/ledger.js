import { all, get, run, now } from './db.js';
import { getConfig } from './config.js';

/**
 * Geldbewegungs-Journal (Vormerkung für das spätere Finanzsystem).
 * Jedes angenommene Börsen-Geschäft erzeugt einen Eintrag „erwartet“ (expected):
 *   direction 'in'  = wir erhalten Geld (Verkauf an einen Partner)
 *   direction 'out' = wir zahlen Geld (Ankauf von einem Partner)
 * Wird das Geschäft abgeschlossen („Als bezahlt abschließen“), wechselt der Eintrag auf „verbucht“ (settled);
 * wird es storniert, auf „storniert“ (cancelled). Einträge werden nie gelöscht – so bleibt jede Bewegung nachvollziehbar und auswertbar.
 */
export function expectDealPayment(dealId) {
  const d = get('SELECT * FROM market_deals WHERE id = ?', dealId);
  if (!d) return;
  run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE deal_id = ? AND status = 'expected'", now(), dealId);
  run(`INSERT INTO finance_ledger (entry_type,direction,amount,currency,status,deal_id,partner_id,item_id,quantity,unit_price,warehouse_id,note,created_at)
       VALUES ('deal',?,?,?,'expected',?,?,?,?,?,?,?,?)`,
  d.direction === 'sell' ? 'in' : 'out', d.quantity * d.unit_price, getConfig('market.currency') ?? '$', dealId, d.partner_id, d.item_id, d.quantity, d.unit_price, d.warehouse_id ?? null,
  `${d.direction === 'sell' ? 'Verkauf' : 'Ankauf'} ${d.deal_number ?? ''}`.trim(), now());
}
export const settleDeal = (dealId) => run("UPDATE finance_ledger SET status = 'settled', settled_at = ? WHERE deal_id = ? AND status = 'expected'", now(), dealId);
export const voidDeal = (dealId) => run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE deal_id = ? AND status = 'expected'", now(), dealId);

/** Deckel-Buchung → Finanzvorgang (erwartete Ausgabe), eindeutig über ref_type/ref_id zuordenbar. */
export function expectTabEntry(e, companyName) {
  run(`INSERT INTO finance_ledger (entry_type,direction,amount,currency,status,partner_id,quantity,note,ref_type,ref_id,company_id,created_at)
       VALUES ('tab','out',?,?,'expected',NULL,1,?,'tab_entry',?,?,?)`, e.amount_cents / 100, getConfig('market.currency') ?? '$', `Deckel ${e.entry_number} · ${companyName}`, e.id, e.company_id, now());
}
export const cancelTabEntry = (entryId) => run("UPDATE finance_ledger SET status = 'cancelled', cancelled_at = ? WHERE ref_type = 'tab_entry' AND ref_id = ? AND status = 'expected'", now(), entryId);
/** Abrechnung bezahlt → alle (aktiven) Deckelbuchungen des Zeitraums gelten als verbucht. */
export const settleTabPeriod = (companyId, periodKey) => run(
  "UPDATE finance_ledger SET status = 'settled', settled_at = ? WHERE ref_type = 'tab_entry' AND status = 'expected' AND ref_id IN (SELECT id FROM tab_entries WHERE company_id = ? AND period_key = ? AND status = 'active')",
  now(), companyId, periodKey);

export const ledgerEntries = ({ status, direction, q, limit = 200 } = {}) => {
  const where = [], p = [];
  if (['expected', 'settled', 'cancelled'].includes(status)) { where.push('l.status = ?'); p.push(status); }
  if (['in', 'out'].includes(direction)) { where.push('l.direction = ?'); p.push(direction); }
  if (q) { where.push('(d.deal_number LIKE ? OR pa.partner_number LIKE ? OR pa.name LIKE ? OR i.name LIKE ? OR tc.name LIKE ? OR te.entry_number LIKE ?)'); p.push(...Array(6).fill(`%${q}%`)); }
  return all(`SELECT l.*, d.deal_number, pa.partner_number, pa.name partner_name, i.name item_name, i.unit item_unit, w.name warehouse_name, tc.company_number, tc.name company_name, te.entry_number tab_entry_number
    FROM finance_ledger l LEFT JOIN market_deals d ON d.id = l.deal_id LEFT JOIN partners pa ON pa.id = l.partner_id
    LEFT JOIN tab_companies tc ON tc.id = l.company_id LEFT JOIN tab_entries te ON l.ref_type = 'tab_entry' AND te.id = l.ref_id
    LEFT JOIN market_items i ON i.id = l.item_id LEFT JOIN warehouses w ON w.id = l.warehouse_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`, ...p, Math.min(Math.max(limit, 1), 1000));
};
const r2 = (n) => Math.round(n * 100) / 100;
export const ledgerSummary = () => {
  const rows = all('SELECT direction, status, COUNT(*) n, COALESCE(SUM(amount),0) total FROM finance_ledger GROUP BY direction, status');
  const sum = (dir, st) => rows.find((r) => r.direction === dir && r.status === st)?.total ?? 0;
  return {
    currency: getConfig('market.currency') ?? '$',
    expectedIn: r2(sum('in', 'expected')), expectedOut: r2(sum('out', 'expected')), settledIn: r2(sum('in', 'settled')), settledOut: r2(sum('out', 'settled')),
    balanceSettled: r2(sum('in', 'settled') - sum('out', 'settled')), balanceExpected: r2(sum('in', 'expected') - sum('out', 'expected')),
    entries: rows.reduce((a, r) => a + r.n, 0),
  };
};
