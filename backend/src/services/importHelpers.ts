import type Database from 'better-sqlite3';
import { isGmailConnected, fetchNmbsTickets as fetchNmbsTicketsFromGmail, type NmbsTicket } from './gmailService';
import { getSetting } from '../helpers/settings';
import { SETTING_KEYS } from '../helpers/constants';
import { amountExactMatch, amountWithinTolerance } from '../helpers/amount';

/** Save a ticket PDF receipt and update transaction notes with trajectory info. */
export function saveTicketReceipt(
  db: Database.Database,
  transactionId: number,
  ticket: NmbsTicket,
  pdfBuffer: Buffer,
  messageId: string
): void {
  db.prepare(`
    INSERT INTO expense_receipts (transaction_id, filename, content_type, data, gmail_message_id)
    VALUES (?, ?, 'application/pdf', ?, ?)
  `).run(transactionId, `ticket_${ticket.date}_${ticket.from}-${ticket.to}.pdf`, pdfBuffer, messageId);

  if (ticket.from && ticket.to) {
    const existing = db.prepare('SELECT notes FROM transactions WHERE id=?').get(transactionId) as { notes: string | null };
    const tripType = ticket.roundTrip ? 'heen en terug' : 'enkel';
    const trajNote = `Van: ${ticket.from} → Naar: ${ticket.to} (${tripType})`;
    if (!existing.notes?.includes('Van:')) {
      const newNotes = existing.notes ? `${existing.notes}\n${trajNote}` : trajNote;
      db.prepare("UPDATE transactions SET notes=?, updated_at=datetime('now') WHERE id=?").run(newNotes, transactionId);
    }
  }
}

/**
 * Match NMBS tickets from Gmail to transactions by exact amount + exact date.
 * Matched transactions are marked as reimbursable with the work organization,
 * and the ticket PDF is attached as a receipt.
 */
export async function matchNmbsTickets(db: Database.Database, transactionIds: number[]): Promise<{ matched: number; total: number }> {
  if (!isGmailConnected()) return { matched: 0, total: 0 };

  const workOrgId = getSetting(SETTING_KEYS.WORK_ORG_ID, db);
  if (!workOrgId) return { matched: 0, total: 0 };

  const placeholders = transactionIds.map(() => '?').join(',');
  const txRows = db.prepare(`SELECT id, date, amount, notes FROM transactions WHERE id IN (${placeholders}) AND amount < 0`).all(...transactionIds) as Array<{ id: number; date: string; amount: number; notes: string | null }>;
  if (txRows.length === 0) return { matched: 0, total: 0 };

  const dates = txRows.map(t => t.date).sort();
  let tickets;
  try {
    tickets = await fetchNmbsTicketsFromGmail(dates[0], dates[dates.length - 1]);
  } catch {
    return { matched: 0, total: 0 };
  }
  if (tickets.length === 0) return { matched: 0, total: 0 };

  let matched = 0;
  for (const { ticket, pdfBuffer, messageId } of tickets) {
    const match = txRows.find(tx =>
      tx.date === ticket.date && amountExactMatch(Math.abs(tx.amount), ticket.amount)
    );
    if (!match) continue;

    db.prepare(`
      UPDATE transactions SET type = 'reimbursable', organization_id = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(Number(workOrgId), match.id);

    saveTicketReceipt(db, match.id, ticket, pdfBuffer, messageId);

    const idx = txRows.indexOf(match);
    if (idx !== -1) txRows.splice(idx, 1);
    matched++;
  }

  return { matched, total: tickets.length };
}

/**
 * Match Gmail NMBS tickets to existing work expense transactions for a given month.
 * Used by the expenses page gmail/fetch endpoint.
 */
export async function matchGmailTicketsToExpenses(
  db: Database.Database,
  workOrgId: string,
  dateFrom: string,
  dateTo: string
): Promise<{ fetched: number; linked: number; unmatched: string[] }> {
  const tickets = await fetchNmbsTicketsFromGmail(dateFrom, dateTo);
  const linked: number[] = [];
  const unmatched: string[] = [];

  for (const { ticket, pdfBuffer, messageId } of tickets) {
    const candidates = db.prepare(`
      SELECT id, amount, date FROM transactions
      WHERE date = ?
        AND amount < 0
        AND type = 'reimbursable'
        AND organization_id = ?
      ORDER BY ABS(amount - ?) ASC
      LIMIT 5
    `).all(ticket.date, Number(workOrgId), -ticket.amount) as { id: number; amount: number; date: string }[];

    let matchedId: number | null = null;
    for (const cand of candidates) {
      if (amountWithinTolerance(Math.abs(cand.amount), ticket.amount, 0.05)) {
        matchedId = cand.id;
        break;
      }
    }

    if (matchedId) {
      saveTicketReceipt(db, matchedId, ticket, pdfBuffer, messageId);
      linked.push(matchedId);
    } else {
      unmatched.push(`${ticket.date} ${ticket.from}-${ticket.to} ${ticket.amount.toFixed(2)}`);
    }
  }

  return { fetched: tickets.length, linked: linked.length, unmatched };
}
