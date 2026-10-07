import { ledgerEntries, ledgerSummary } from '../core/ledger.js';
import { registerWidget } from './dashboard.js';

registerWidget({ id: 'finance-flow', title: 'Geldfluss', size: 'small', permission: 'finance.view', data: () => ledgerSummary() });

/**
 * Finanz-Grundlage: lesender Zugriff auf das Geldbewegungs-Journal (siehe core/ledger.js).
 * Das eigentliche Finanzsystem (Konten, Auswertungen, Export) setzt später darauf auf.
 */
export default {
  name: 'finance',
  permissions: [['finance.view', 'Finanzen: Geldbewegungen (Journal) ansehen']],
  routes(r) {
    r.get('/api/finance/summary', { perm: 'finance.view' }, () => ({ summary: ledgerSummary() }));
    r.get('/api/finance/ledger', { perm: 'finance.view' }, (ctx) => ({
      entries: ledgerEntries({ status: ctx.query.status, direction: ctx.query.direction, q: ctx.query.q, limit: parseInt(ctx.query.limit) || 200 }).map((l) => ({
        id: l.id, direction: l.direction, amount: l.amount, currency: l.currency, status: l.status, dealNumber: l.deal_number, dealId: l.deal_id,
        partner: l.partner_number ? { number: l.partner_number, name: l.partner_name } : null, entryType: l.entry_type, company: l.company_name ? { number: l.company_number, name: l.company_name } : null, entryNumber: l.tab_entry_number ?? null, item: l.item_name, unit: l.item_unit, quantity: l.quantity, unitPrice: l.unit_price,
        warehouse: l.warehouse_name, note: l.note, createdAt: l.created_at, settledAt: l.settled_at, cancelledAt: l.cancelled_at,
      })),
    }));
  },
};
