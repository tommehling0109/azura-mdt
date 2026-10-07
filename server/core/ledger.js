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

export const ledgerEntries = ({ status, direction, q, limit = 200 } = {}) => {
  const where = [], p = [];
  if (['expected', 'settled', 'cancelled'].includes(status)) { where.push('l.status = ?'); p.push(status); }
  if (['in', 'out'].includes(direction)) { where.push('l.direction = ?'); p.push(direction); }
  if (q) { where.push('(d.deal_number LIKE ? OR pa.partner_number LIKE ? OR pa.name LIKE ? OR i.name LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  return all(`SELECT l.*, d.deal_number, pa.partner_number, pa.name partner_name, i.name item_name, i.unit item_unit, w.name warehouse_name
    FROM finance_ledger l LEFT JOIN market_deals d ON d.id = l.deal_id LEFT JOIN partners pa ON pa.id = l.partner_id
    LEFT JOIN market_items i ON i.id = l.item_id LEFT JOIN warehouses w ON w.id = l.warehouse_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`, ...p, Math.min(Math.max(limit, 1), 1000));
};
export const ledgerSummary = () => {
  const rows = all('SELECT direction, status, COUNT(*) n, COALESCE(SUM(amount),0) total FROM finance_ledger GROUP BY direction, status');
  const sum = (dir, st) => rows.find((r) => r.direction === dir && r.status === st)?.total ?? 0;
  return {
    currency: getConfig('market.currency') ?? '$',
    expectedIn: sum('in', 'expected'), expectedOut: sum('out', 'expected'), settledIn: sum('in', 'settled'), settledOut: sum('out', 'settled'),
    balanceSettled: sum('in', 'settled') - sum('out', 'settled'), balanceExpected: sum('in', 'expected') - sum('out', 'expected'),
    entries: rows.reduce((a, r) => a + r.n, 0),
  };
};
