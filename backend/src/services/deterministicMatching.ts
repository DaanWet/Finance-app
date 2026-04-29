import type { AnalysisContext } from './aiAnalysis';
import type { ParsedIngRow } from './csvParser';

export interface SplitwiseMatch {
  transactionIndex: number;
  splitwise_expense_id: string;
  splitwise_owed_share: number;
}

/**
 * Deterministic Splitwise matching: match transactions to Splitwise expenses
 * based on amount (within 2%) and date (within 365 days).
 * When multiple candidates match on amount, use description similarity to disambiguate.
 */
export function matchSplitwiseDeterministic(
  rows: { index: number; amount: number; date: string; description: string }[],
  splitwiseExpenses: AnalysisContext['splitwiseExpenses'],
): SplitwiseMatch[] {
  if (splitwiseExpenses.length === 0) return [];

  const matches: SplitwiseMatch[] = [];
  const usedExpenseIds = new Set<number>();

  for (const row of rows) {
    if (row.amount >= 0) continue; // Only match expenses (negative amounts)

    const absAmount = Math.abs(row.amount);
    const rowDate = new Date(row.date);

    // Find candidates: amount within 2%, date within 365 days
    const candidates = splitwiseExpenses.filter(e => {
      if (usedExpenseIds.has(e.id)) return false;
      const amountDiff = Math.abs(e.my_paid_share - absAmount);
      if (amountDiff > absAmount * 0.02) return false;
      const daysDiff = Math.abs(rowDate.getTime() - new Date(e.date).getTime()) / (1000 * 60 * 60 * 24);
      return daysDiff <= 365;
    });

    if (candidates.length === 0) continue;

    let best = candidates[0];
    if (candidates.length > 1) {
      // Disambiguate by description similarity (overlapping words)
      best = candidates.reduce((a, b) => {
        const scoreA = descriptionSimilarity(row.description, a.description);
        const scoreB = descriptionSimilarity(row.description, b.description);
        return scoreB > scoreA ? b : a;
      });
    }

    matches.push({
      transactionIndex: row.index,
      splitwise_expense_id: String(best.id),
      splitwise_owed_share: best.my_owed_share,
    });
    usedExpenseIds.add(best.id);
  }

  return matches;
}

/** Simple description similarity: count overlapping words (case-insensitive, length > 2). */
function descriptionSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap;
}

/**
 * Deterministic within-batch advance matching: find obvious pairs where
 * one transaction is an expense and another is a repayment from the same counterparty.
 */
export function matchObviousAdvances(
  rows: { index: number; amount: number; counterparty_account: string | null }[],
): { expenseIndex: number; repaymentIndex: number }[] {
  const matches: { expenseIndex: number; repaymentIndex: number }[] = [];
  const usedIndices = new Set<number>();

  // Group by counterparty_account
  const byAccount = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.counterparty_account) continue;
    if (!byAccount.has(row.counterparty_account)) byAccount.set(row.counterparty_account, []);
    byAccount.get(row.counterparty_account)!.push(row);
  }

  for (const group of byAccount.values()) {
    const expenses = group.filter(r => r.amount < 0);
    const incomes = group.filter(r => r.amount > 0);

    for (const expense of expenses) {
      for (const income of incomes) {
        if (usedIndices.has(expense.index) || usedIndices.has(income.index)) continue;
        // Amount within 10%
        const diff = Math.abs(Math.abs(expense.amount) - income.amount);
        if (diff <= Math.abs(expense.amount) * 0.1) {
          matches.push({ expenseIndex: expense.index, repaymentIndex: income.index });
          usedIndices.add(expense.index);
          usedIndices.add(income.index);
          break;
        }
      }
    }
  }

  return matches;
}
