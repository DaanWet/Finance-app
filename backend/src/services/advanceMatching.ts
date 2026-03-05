import type Database from 'better-sqlite3';
import { AUTO_REIMBURSEMENT_NOTE, REPAYMENT_NOTE } from '../helpers/constants';
import type { MatchableTx } from '../helpers/types';

export interface AdvanceLinkParams {
  expenseId: number;
  incomeId: number;
  amount: number;
  reimbursedAt: string;
  note?: string;
}

/**
 * Link an advance (expense) to its repayment (income) transaction.
 * Sets reimbursed_at on the expense and creates a reimbursement_link.
 */
export function linkAdvanceToRepayment(db: Database.Database, params: AdvanceLinkParams): void {
  const { expenseId, incomeId, amount, reimbursedAt, note = AUTO_REIMBURSEMENT_NOTE } = params;

  db.prepare(`
    UPDATE transactions SET reimbursed_at = ?, reimbursed_note = ?
    WHERE id = ? AND reimbursed_at IS NULL
  `).run(reimbursedAt, note, expenseId);

  db.prepare(`
    UPDATE transactions SET reimbursed_note = ?
    WHERE id = ? AND reimbursed_note IS NULL
  `).run(REPAYMENT_NOTE, incomeId);

  db.prepare(`
    INSERT OR IGNORE INTO reimbursement_links (income_transaction_id, expense_transaction_id, amount)
    VALUES (?, ?, ?)
  `).run(incomeId, expenseId, amount);
}

/**
 * Find an unreimbursed expense matching an income transaction by counterparty + amount (within 10%).
 * If found, automatically links them.
 */
export function findAndLinkAdvance(
  db: Database.Database,
  incomeTx: MatchableTx,
  note: string = AUTO_REIMBURSEMENT_NOTE
): boolean {
  if (incomeTx.amount <= 0 || !incomeTx.counterparty_account) return false;

  const match = db.prepare(`
    SELECT id, amount FROM transactions
    WHERE type = 'reimbursable'
      AND reimbursed_at IS NULL
      AND counterparty_account = ?
      AND ABS(amount + ?) < ABS(?) * 0.1
      AND id != ?
    ORDER BY date DESC
    LIMIT 1
  `).get(incomeTx.counterparty_account, incomeTx.amount, incomeTx.amount, incomeTx.id) as { id: number; amount: number } | undefined;

  if (!match) return false;

  linkAdvanceToRepayment(db, {
    expenseId: match.id, incomeId: incomeTx.id,
    amount: Math.abs(match.amount), reimbursedAt: incomeTx.date, note,
  });
  return true;
}

/**
 * Reverse matching: find a positive (income) transaction matching a negative (expense) transaction.
 * Used when reanalyzing an expense to find if it was already repaid.
 */
export function findAndLinkReverseAdvance(
  db: Database.Database,
  expenseTx: MatchableTx,
  note: string = AUTO_REIMBURSEMENT_NOTE
): boolean {
  if (expenseTx.amount >= 0 || !expenseTx.counterparty_account) return false;

  const match = db.prepare(`
    SELECT id, date FROM transactions
    WHERE amount > 0
      AND counterparty_account = ?
      AND ABS(amount + ?) < ABS(?) * 0.1
      AND id != ?
    ORDER BY date DESC
    LIMIT 1
  `).get(expenseTx.counterparty_account, expenseTx.amount, expenseTx.amount, expenseTx.id) as { id: number; date: string } | undefined;

  if (!match) return false;

  linkAdvanceToRepayment(db, {
    expenseId: expenseTx.id, incomeId: match.id,
    amount: Math.abs(expenseTx.amount), reimbursedAt: match.date, note,
  });
  return true;
}

/**
 * Within-batch advance linking: link an advance to its repayment when both are in the same batch.
 * Used during import and bulk reanalyze when AI identifies advance_repaid_by_index.
 */
export function linkBatchAdvance(
  db: Database.Database,
  advanceTx: { id: number; amount: number },
  repaymentTx: { id: number; date: string },
  note: string = AUTO_REIMBURSEMENT_NOTE
): void {
  linkAdvanceToRepayment(db, {
    expenseId: advanceTx.id, incomeId: repaymentTx.id,
    amount: Math.abs(advanceTx.amount), reimbursedAt: repaymentTx.date, note,
  });
}
