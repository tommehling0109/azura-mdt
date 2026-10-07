import { all, get, run, DB_PATH } from './db.js';
import { unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Endgültiges Löschen samt allem Zugehörigen (nur für berechtigte Mitglieder / Superadmin).
 * Jede Funktion läuft in der Transaktion des Aufrufers und räumt Finanz-Journal und Dateien mit auf.
 */
const data = (...p) => join(dirname(DB_PATH), ...p);
const rm = (file) => { try { unlinkSync(file); } catch { /* war nicht da */ } };

export function purgeLoan(id) {
  run("DELETE FROM finance_ledger WHERE (ref_type = 'credit_installment' AND ref_id IN (SELECT id FROM credit_installments WHERE loan_id = ?)) OR (ref_type = 'loan' AND ref_id = ?)", id, id);
  run('DELETE FROM credit_loans WHERE id = ?', id); // Raten und Verlauf folgen per Cascade
}
export function purgeDeal(id) {
  run('DELETE FROM finance_ledger WHERE deal_id = ?', id);
  run('DELETE FROM market_deals WHERE id = ?', id);
}
export function purgeStatement(id) {
  const s = get('SELECT invoice_file_ext e FROM tab_statements WHERE id = ?', id);
  if (s?.e) rm(data('tab-invoices', `${id}.${s.e}`));
  run('DELETE FROM tab_statements WHERE id = ?', id);
}
export function purgeCompany(id) {
  for (const s of all('SELECT id FROM tab_statements WHERE company_id = ?', id)) purgeStatement(s.id);
  run("DELETE FROM finance_ledger WHERE company_id = ? OR (ref_type = 'tab_statement' AND ref_id IN (SELECT id FROM tab_statements WHERE company_id = ?))", id, id);
  run('DELETE FROM tab_entries WHERE company_id = ?', id); // (alte Buchungen aus früheren Versionen)
  run('DELETE FROM tab_companies WHERE id = ?', id);
}
export function purgePartner(id) {
  for (const l of all('SELECT id FROM credit_loans WHERE partner_id = ?', id)) purgeLoan(l.id);
  for (const d of all('SELECT id FROM market_deals WHERE partner_id = ?', id)) purgeDeal(d.id);
  run('DELETE FROM finance_ledger WHERE partner_id = ?', id);
  run("DELETE FROM notifications WHERE recipient_type = 'partner' AND recipient_id = ?", id);
  const p = get('SELECT id_doc_ext i, weapon_doc_ext w FROM partners WHERE id = ?', id);
  if (p?.i) rm(data('partner-docs', `${id}-id.${p.i}`));
  if (p?.w) rm(data('partner-docs', `${id}-weapon.${p.w}`));
  run('DELETE FROM partners WHERE id = ?', id); // Zugangs-Sitzungen, Chats und Lesemarken folgen per Cascade
}
