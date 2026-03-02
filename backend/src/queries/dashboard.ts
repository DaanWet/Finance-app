import Database from 'better-sqlite3';

export interface DashboardSummary {
  personalTotal: number;
  reimbursableOutstanding: number;
  reimbursableCount: number;
  incomeTotal: number;
  byCategory: { name: string; color: string; icon: string | null; total: number }[];
  monthlyTrend: { month: string; total: number }[];
}

export function getDashboardSummary(
  db: Database.Database,
  startDate: string,
  endDate: string
): DashboardSummary {
  const personalTotal = (db.prepare(`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS total
    FROM transactions
    WHERE type = 'personal'
      AND amount < 0
      AND date BETWEEN ? AND ?
  `).get(startDate, endDate) as { total: number }).total;

  const reimbursableRow = db.prepare(`
    SELECT COALESCE(SUM(ABS(amount)), 0) AS total, COUNT(*) AS count
    FROM transactions
    WHERE type = 'reimbursable'
      AND reimbursed_at IS NULL
  `).get() as { total: number; count: number };

  const incomeTotal = (db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE type = 'income'
      AND date BETWEEN ? AND ?
  `).get(startDate, endDate) as { total: number }).total;

  const byCategory = db.prepare(`
    SELECT
      COALESCE(c.name, 'Zonder categorie') AS name,
      COALESCE(c.color, '#94a3b8') AS color,
      c.icon,
      SUM(ABS(t.amount)) AS total
    FROM transactions t
    LEFT JOIN categories c ON t.category_id = c.id
    WHERE t.type = 'personal'
      AND t.amount < 0
      AND t.date BETWEEN ? AND ?
    GROUP BY t.category_id
    ORDER BY total DESC
  `).all(startDate, endDate) as { name: string; color: string; icon: string | null; total: number }[];

  const monthlyTrend = db.prepare(`
    SELECT
      strftime('%Y-%m', date) AS month,
      SUM(ABS(amount)) AS total
    FROM transactions
    WHERE type = 'personal'
      AND amount < 0
      AND date >= date('now', '-6 months')
    GROUP BY month
    ORDER BY month ASC
  `).all() as { month: string; total: number }[];

  return {
    personalTotal,
    reimbursableOutstanding: reimbursableRow.total,
    reimbursableCount: reimbursableRow.count,
    incomeTotal,
    byCategory,
    monthlyTrend,
  };
}
