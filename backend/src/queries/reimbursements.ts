import Database from 'better-sqlite3';
import { Transaction } from './transactions';

export interface ReimbursementGroup {
  organization_id: number;
  organization_name: string;
  organization_color: string;
  total: number;
  count: number;
  transactions: Transaction[];
}

export function getOutstandingReimbursements(db: Database.Database): ReimbursementGroup[] {
  const orgs = db.prepare(`
    SELECT o.id, o.name, o.color,
           SUM(ABS(t.amount)) AS total,
           COUNT(*) AS count
    FROM transactions t
    JOIN organizations o ON t.organization_id = o.id
    WHERE t.type = 'reimbursable'
      AND t.reimbursed_at IS NULL
    GROUP BY o.id
    ORDER BY total DESC
  `).all() as { id: number; name: string; color: string; total: number; count: number }[];

  return orgs.map(org => {
    const transactions = db.prepare(`
      SELECT t.*, c.name AS category_name, c.color AS category_color
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.organization_id = ?
        AND t.type = 'reimbursable'
        AND t.reimbursed_at IS NULL
      ORDER BY t.date DESC
    `).all(org.id) as Transaction[];

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

export function getReceivedReimbursements(db: Database.Database): ReimbursementGroup[] {
  const orgs = db.prepare(`
    SELECT o.id, o.name, o.color,
           SUM(ABS(t.amount)) AS total,
           COUNT(*) AS count
    FROM transactions t
    JOIN organizations o ON t.organization_id = o.id
    WHERE t.type = 'reimbursable'
      AND t.reimbursed_at IS NOT NULL
      AND t.reimbursed_at >= date('now', '-3 months')
    GROUP BY o.id
    ORDER BY total DESC
  `).all() as { id: number; name: string; color: string; total: number; count: number }[];

  return orgs.map(org => {
    const transactions = db.prepare(`
      SELECT t.*, c.name AS category_name, c.color AS category_color
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.organization_id = ?
        AND t.type = 'reimbursable'
        AND t.reimbursed_at IS NOT NULL
        AND t.reimbursed_at >= date('now', '-3 months')
      ORDER BY t.reimbursed_at DESC
    `).all(org.id) as Transaction[];

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
