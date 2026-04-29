import Database from 'better-sqlite3';

export interface ReimbursementLink {
  id: number;
  income_transaction_id: number;
  expense_transaction_id: number;
  amount: number;
  created_at: string;
  // Joined from the other side
  description?: string;
  transaction_amount?: number;
  date?: string;
  organization_name?: string;
}

export interface LinkExpenseInput {
  expense_transaction_id: number;
  amount: number;
}

export function linkIncomeToExpenses(
  db: Database.Database,
  incomeId: number,
  expenses: LinkExpenseInput[]
): ReimbursementLink[] {
  return db.transaction(() => {
    // Get the income transaction date to use as reimbursed_at
    const income = db.prepare(`SELECT date FROM transactions WHERE id = ?`).get(incomeId) as { date: string } | undefined;
    const incomeDate = income?.date ?? new Date().toISOString().split('T')[0];

    const insertLink = db.prepare(`
      INSERT OR IGNORE INTO reimbursement_links (income_transaction_id, expense_transaction_id, amount)
      VALUES (?, ?, ?)
    `);
    const markExpense = db.prepare(`
      UPDATE transactions SET reimbursed_at = ?, updated_at = datetime('now')
      WHERE id = ? AND type = 'reimbursable'
    `);

    for (const exp of expenses) {
      insertLink.run(incomeId, exp.expense_transaction_id, exp.amount);
      markExpense.run(incomeDate, exp.expense_transaction_id);
    }

    // Mark income as reimbursement
    db.prepare(`
      UPDATE transactions SET reimbursed_note = 'Terugbetaling', updated_at = datetime('now')
      WHERE id = ? AND reimbursed_note IS NULL
    `).run(incomeId);

    return db.prepare(`
      SELECT rl.*, t.description, t.amount AS transaction_amount, t.date
      FROM reimbursement_links rl
      JOIN transactions t ON t.id = rl.expense_transaction_id
      WHERE rl.income_transaction_id = ?
    `).all(incomeId) as ReimbursementLink[];
  })();
}

export function unlinkExpense(
  db: Database.Database,
  incomeId: number,
  expenseId: number
): boolean {
  return db.transaction(() => {
    const result = db.prepare(`
      DELETE FROM reimbursement_links WHERE income_transaction_id = ? AND expense_transaction_id = ?
    `).run(incomeId, expenseId);

    if (result.changes === 0) return false;

    // Clear reimbursed_at if expense has no other links
    const otherLinks = db.prepare(`
      SELECT COUNT(*) AS cnt FROM reimbursement_links WHERE expense_transaction_id = ?
    `).get(expenseId) as { cnt: number };

    if (otherLinks.cnt === 0) {
      db.prepare(`
        UPDATE transactions SET reimbursed_at = NULL, reimbursed_note = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(expenseId);
    }

    // Clear reimbursed_note on income if no more links
    const incomeLinks = db.prepare(`
      SELECT COUNT(*) AS cnt FROM reimbursement_links WHERE income_transaction_id = ?
    `).get(incomeId) as { cnt: number };

    if (incomeLinks.cnt === 0) {
      db.prepare(`
        UPDATE transactions SET reimbursed_note = NULL, updated_at = datetime('now')
        WHERE id = ? AND reimbursed_note = 'Terugbetaling'
      `).run(incomeId);
    }

    return true;
  })();
}

export function getLinksForTransaction(
  db: Database.Database,
  transactionId: number
): { as_income: ReimbursementLink[]; as_expense: ReimbursementLink[] } {
  const asIncome = db.prepare(`
    SELECT rl.*, t.description, t.amount AS transaction_amount, t.date, o.name AS organization_name
    FROM reimbursement_links rl
    JOIN transactions t ON t.id = rl.expense_transaction_id
    LEFT JOIN organizations o ON t.organization_id = o.id
    WHERE rl.income_transaction_id = ?
    ORDER BY t.date DESC
  `).all(transactionId) as ReimbursementLink[];

  const asExpense = db.prepare(`
    SELECT rl.*, t.description, t.amount AS transaction_amount, t.date
    FROM reimbursement_links rl
    JOIN transactions t ON t.id = rl.income_transaction_id
    WHERE rl.expense_transaction_id = ?
    ORDER BY t.date DESC
  `).all(transactionId) as ReimbursementLink[];

  return { as_income: asIncome, as_expense: asExpense };
}

export interface IncomeCandidateRow {
  id: number;
  description: string;
  amount: number;
  date: string;
  counterparty_name: string | null;
  linked_total: number;
}

export function getIncomeCandidates(
  db: Database.Database,
  _organizationId?: number
): IncomeCandidateRow[] {
  return db.prepare(`
    SELECT t.id, t.description, t.amount, t.date, t.counterparty_name,
           COALESCE(SUM(rl.amount), 0) AS linked_total
    FROM transactions t
    LEFT JOIN reimbursement_links rl ON rl.income_transaction_id = t.id
    WHERE t.type = 'income' AND t.amount > 0
    GROUP BY t.id ORDER BY t.date DESC LIMIT 100
  `).all() as IncomeCandidateRow[];
}

export function getExpenseCandidates(
  db: Database.Database,
  organizationId?: number
): { id: number; description: string; amount: number; date: string; organization_name: string | null }[] {
  let query = `
    SELECT t.id, t.description, t.amount, t.date, o.name AS organization_name
    FROM transactions t
    LEFT JOIN organizations o ON t.organization_id = o.id
    WHERE t.type = 'reimbursable' AND t.reimbursed_at IS NULL
  `;
  const params: unknown[] = [];

  if (organizationId) {
    query += ` AND t.organization_id = ?`;
    params.push(organizationId);
  }

  query += ` ORDER BY t.date DESC`;

  return db.prepare(query).all(...params) as { id: number; description: string; amount: number; date: string; organization_name: string | null }[];
}

export function cleanupLinksForDeletedTransaction(
  db: Database.Database,
  transactionId: number
): void {
  // Find expenses linked to this income, clear their reimbursed_at if they'll have no other links
  const linkedExpenses = db.prepare(`
    SELECT expense_transaction_id FROM reimbursement_links WHERE income_transaction_id = ?
  `).all(transactionId) as { expense_transaction_id: number }[];

  for (const { expense_transaction_id } of linkedExpenses) {
    const otherLinks = db.prepare(`
      SELECT COUNT(*) AS cnt FROM reimbursement_links
      WHERE expense_transaction_id = ? AND income_transaction_id != ?
    `).get(expense_transaction_id, transactionId) as { cnt: number };

    if (otherLinks.cnt === 0) {
      db.prepare(`
        UPDATE transactions SET reimbursed_at = NULL, reimbursed_note = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(expense_transaction_id);
    }
  }
}

export function cleanupLinksForTypeChange(
  db: Database.Database,
  transactionId: number,
  oldType: string,
  newType: string
): void {
  if (oldType === newType) return;

  db.transaction(() => {
    if (oldType === 'income' && newType !== 'income') {
      // Income changed away: unlink all connected expenses
      const linkedExpenses = db.prepare(`
        SELECT expense_transaction_id FROM reimbursement_links WHERE income_transaction_id = ?
      `).all(transactionId) as { expense_transaction_id: number }[];

      db.prepare(`DELETE FROM reimbursement_links WHERE income_transaction_id = ?`).run(transactionId);

      for (const { expense_transaction_id } of linkedExpenses) {
        const remaining = db.prepare(`
          SELECT COUNT(*) AS cnt FROM reimbursement_links WHERE expense_transaction_id = ?
        `).get(expense_transaction_id) as { cnt: number };

        if (remaining.cnt === 0) {
          db.prepare(`
            UPDATE transactions SET reimbursed_at = NULL, reimbursed_note = NULL, updated_at = datetime('now')
            WHERE id = ?
          `).run(expense_transaction_id);
        }
      }

      // Clear reimbursed_note on the former income
      db.prepare(`
        UPDATE transactions SET reimbursed_note = NULL, updated_at = datetime('now')
        WHERE id = ? AND reimbursed_note = 'Terugbetaling'
      `).run(transactionId);
    }

    if (oldType === 'reimbursable' && newType !== 'reimbursable') {
      // Expense changed away: unlink from all connected incomes
      const linkedIncomes = db.prepare(`
        SELECT income_transaction_id FROM reimbursement_links WHERE expense_transaction_id = ?
      `).all(transactionId) as { income_transaction_id: number }[];

      db.prepare(`DELETE FROM reimbursement_links WHERE expense_transaction_id = ?`).run(transactionId);

      for (const { income_transaction_id } of linkedIncomes) {
        const remaining = db.prepare(`
          SELECT COUNT(*) AS cnt FROM reimbursement_links WHERE income_transaction_id = ?
        `).get(income_transaction_id) as { cnt: number };

        if (remaining.cnt === 0) {
          db.prepare(`
            UPDATE transactions SET reimbursed_note = NULL, updated_at = datetime('now')
            WHERE id = ? AND reimbursed_note = 'Terugbetaling'
          `).run(income_transaction_id);
        }
      }

      // Clear reimbursed_at/note on the former expense
      db.prepare(`
        UPDATE transactions SET reimbursed_at = NULL, reimbursed_note = NULL, updated_at = datetime('now')
        WHERE id = ?
      `).run(transactionId);
    }
  })();
}
