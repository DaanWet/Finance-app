import Database from 'better-sqlite3';
import { Transaction } from './transactions';

export interface ReimbursementGroup {
  organization_id: number | null;
  organization_name: string;
  organization_color: string;
  total: number;
  count: number;
  transactions: Transaction[];
}

function getReimbursementGroups(
  db: Database.Database,
  outstanding: boolean,
  months?: number
): ReimbursementGroup[] {
  const reimbursedFilter = outstanding ? 'AND t.reimbursed_at IS NULL' : 'AND t.reimbursed_at IS NOT NULL';
  const dateFilter = !outstanding && months ? `AND t.reimbursed_at >= date('now', '-${months} months')` : '';
  const orderBy = outstanding ? 'ORDER BY t.date DESC' : 'ORDER BY t.reimbursed_at DESC';

  const orgs = db.prepare(`
    SELECT t.organization_id AS id, COALESCE(o.name, 'Zonder organisatie') AS name, COALESCE(o.color, '#9e9e9e') AS color,
           SUM(ABS(t.amount)) AS total,
           COUNT(*) AS count
    FROM transactions t
    LEFT JOIN organizations o ON t.organization_id = o.id
    WHERE t.type = 'reimbursable'
      ${reimbursedFilter}
      ${dateFilter}
    GROUP BY t.organization_id
    ORDER BY total DESC
  `).all() as { id: number | null; name: string; color: string; total: number; count: number }[];

  return orgs.map(org => {
    const orgFilter = org.id === null ? 'AND t.organization_id IS NULL' : 'AND t.organization_id = ?';
    const params = org.id === null ? [] : [org.id];

    const transactions = db.prepare(`
      SELECT t.*, c.name AS category_name, c.color AS category_color
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.type = 'reimbursable'
        ${reimbursedFilter}
        ${dateFilter}
        ${orgFilter}
      ${orderBy}
    `).all(...params) as Transaction[];

    return {
      organization_id: org.id,
      organization_name: org.name,
      organization_color: org.color,
      total: org.total,
      count: org.count,
      transactions,
    };
  });
}

export function getOutstandingReimbursements(db: Database.Database): ReimbursementGroup[] {
  return getReimbursementGroups(db, true);
}

export function getReceivedReimbursements(db: Database.Database, months?: number): ReimbursementGroup[] {
  return getReimbursementGroups(db, false, months);
}

export function markReimbursed(db: Database.Database, id: number, note?: string): boolean {
  const result = db.prepare(`
    UPDATE transactions
    SET reimbursed_at = datetime('now'),
        reimbursed_note = ?,
        updated_at = datetime('now')
    WHERE id = ?
      AND type = 'reimbursable'
      AND reimbursed_at IS NULL
  `).run(note ?? null, id);
  return result.changes > 0;
}
