import Database from 'better-sqlite3';

export interface DashboardSummary {
  personalTotal: number;
  reimbursableOutstanding: number;
  reimbursableCount: number;
  incomeTotal: number;
  savingsTotal: number;
  splitwisePaidForOthers: number;
  byCategory: { name: string; color: string; icon: string | null; total: number }[];
  monthlyTrend: { month: string; total: number }[];
}

export function getDashboardSummary(
  db: Database.Database,
  startDate: string,
  endDate: string
): DashboardSummary {
  const personalTotal = (db.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN type = 'personal' THEN COALESCE(splitwise_owed_share, ABS(amount))
        WHEN type = 'reimbursable' AND written_off_at IS NOT NULL THEN COALESCE(written_off_personal_share, 0)
        ELSE 0
      END
    ), 0) AS total
    FROM transactions
    WHERE date BETWEEN ? AND ?
      AND (
        (type = 'personal' AND amount < 0)
        OR (type = 'reimbursable' AND written_off_at IS NOT NULL AND written_off_personal_share > 0)
      )
  `).get(startDate, endDate) as { total: number }).total;

  const reimbursableRow = db.prepare(`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
    FROM transactions
    WHERE type = 'reimbursable'
      AND reimbursed_at IS NULL
      AND written_off_at IS NULL
  `).get() as { total: number; count: number };

  const incomeTotal = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE type = 'income'
      AND date BETWEEN ? AND ?
  `).get(startDate, endDate) as { total: number }).total;

  const savingsTotal = (db.prepare(`
    SELECT COALESCE(SUM(-amount), 0) AS total
    FROM transactions
    WHERE type = 'savings'
      AND date BETWEEN ? AND ?
  `).get(startDate, endDate) as { total: number }).total;

  const byCategory = db.prepare(`
    SELECT
      COALESCE(c.name, 'Zonder categorie') AS name,
      COALESCE(c.color, '#94a3b8') AS color,
      c.icon,
      SUM(
        CASE
          WHEN t.type = 'personal' THEN COALESCE(t.splitwise_owed_share, ABS(t.amount))
          WHEN t.type = 'reimbursable' AND t.written_off_at IS NOT NULL THEN COALESCE(t.written_off_personal_share, 0)
          ELSE 0
        END
      ) AS total
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.date BETWEEN ? AND ?
      AND (
        (t.type = 'personal' AND t.amount < 0)
        OR (t.type = 'reimbursable' AND t.written_off_at IS NOT NULL AND t.written_off_personal_share > 0)
      )
    GROUP BY t.category_id
    ORDER BY total DESC
  `).all(startDate, endDate) as { name: string; color: string; icon: string | null; total: number }[];

  const splitwisePaidForOthers = (db.prepare(`
    SELECT COALESCE(SUM(ABS(amount) - splitwise_owed_share), 0) AS total
    FROM transactions
    WHERE type = 'personal'
      AND amount < 0
      AND splitwise_owed_share IS NOT NULL
      AND date BETWEEN ? AND ?
  `).get(startDate, endDate) as { total: number }).total;

  const monthlyTrend = db.prepare(`
    SELECT
      strftime('%Y-%m', date) AS month,
      SUM(
        CASE
          WHEN type = 'personal' THEN COALESCE(splitwise_owed_share, ABS(amount))
          WHEN type = 'reimbursable' AND written_off_at IS NOT NULL THEN COALESCE(written_off_personal_share, 0)
          ELSE 0
        END
      ) AS total
    FROM transactions
    WHERE date >= date('now', '-6 months')
      AND (
        (type = 'personal' AND amount < 0)
        OR (type = 'reimbursable' AND written_off_at IS NOT NULL AND written_off_personal_share > 0)
      )
    GROUP BY month
    ORDER BY month ASC
  `).all() as { month: string; total: number }[];

  return {
    personalTotal,
    reimbursableOutstanding: reimbursableRow.total,
    reimbursableCount: reimbursableRow.count,
    incomeTotal,
    savingsTotal,
    splitwisePaidForOthers,
    byCategory,
    monthlyTrend,
  };
}
