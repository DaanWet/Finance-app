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

type ReimbursementMode = 'outstanding' | 'received' | 'written_off';

function getReimbursementGroups(
  db: Database.Database,
  mode: ReimbursementMode,
  months?: number
): ReimbursementGroup[] {
  let statusFilter: string;
  let dateFilter = '';
  let orderBy: string;
  if (mode === 'outstanding') {
    statusFilter = 'AND t.reimbursed_at IS NULL AND t.written_off_at IS NULL';
    orderBy = 'ORDER BY t.date DESC';
  } else if (mode === 'received') {
    statusFilter = 'AND t.reimbursed_at IS NOT NULL';
    dateFilter = months ? `AND t.reimbursed_at >= date('now', '-${months} months')` : '';
    orderBy = 'ORDER BY t.reimbursed_at DESC';
  } else {
    statusFilter = 'AND t.written_off_at IS NOT NULL';
    dateFilter = months ? `AND t.written_off_at >= date('now', '-${months} months')` : '';
    orderBy = 'ORDER BY t.written_off_at DESC';
  }

  const orgs = db.prepare(`
    SELECT t.organization_id AS id, COALESCE(o.name, 'Zonder organisatie') AS name, COALESCE(o.color, '#9e9e9e') AS color,
           SUM(ABS(t.amount)) AS total,
           COUNT(*) AS count
    FROM transactions t
    LEFT JOIN organizations o ON t.organization_id = o.id
    WHERE t.type = 'reimbursable'
      ${statusFilter}
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
        ${statusFilter}
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
  return getReimbursementGroups(db, 'outstanding');
}

export function getReceivedReimbursements(db: Database.Database, months?: number): ReimbursementGroup[] {
  return getReimbursementGroups(db, 'received', months);
}

export function getWrittenOffReimbursements(db: Database.Database, months?: number): ReimbursementGroup[] {
  return getReimbursementGroups(db, 'written_off', months);
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
      AND written_off_at IS NULL
  `).run(note ?? null, id);
  return result.changes > 0;
}

export function markWrittenOff(
  db: Database.Database,
  id: number,
  note?: string,
  personalShare?: number,
): boolean {
  const result = db.prepare(`
    UPDATE transactions
    SET written_off_at = datetime('now'),
        written_off_note = ?,
        written_off_personal_share = ?,
        updated_at = datetime('now')
    WHERE id = ?
      AND type = 'reimbursable'
      AND reimbursed_at IS NULL
      AND written_off_at IS NULL
  `).run(note ?? null, personalShare ?? null, id);
  return result.changes > 0;
}

/**
 * Bulk write-off. `personalShareMode` controls how written_off_personal_share is set:
 *   - 'none' (default): leave NULL — no personal share counted
 *   - 'full': set to ABS(amount) per transaction — full amount counts as personal expense
 */
export function bulkMarkWrittenOff(
  db: Database.Database,
  ids: number[],
  note?: string,
  personalShareMode: 'none' | 'full' = 'none',
): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare(`
    UPDATE transactions
    SET written_off_at = datetime('now'),
        written_off_note = ?,
        written_off_personal_share = CASE WHEN ? = 'full' THEN ABS(amount) ELSE NULL END,
        updated_at = datetime('now')
    WHERE id = ?
      AND type = 'reimbursable'
      AND reimbursed_at IS NULL
      AND written_off_at IS NULL
  `);
  const tx = db.transaction((rows: number[]) => {
    let changed = 0;
    for (const id of rows) {
      const r = stmt.run(note ?? null, personalShareMode, id);
      changed += r.changes;
    }
    return changed;
  });
  return tx(ids);
}
