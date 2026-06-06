import type Database from 'better-sqlite3';
import { updateTransaction, getUnreimbursedExpensesForContext } from '../queries/transactions';
import type { TransactionAnalysisResult, AnalysisContext } from './aiAnalysis';
import { linkBatchAdvance, linkAdvanceToRepayment, findAndLinkAdvance, findAndLinkReverseAdvance } from './advanceMatching';
import { matchNmbsTickets } from './importHelpers';
import type { MatchableTx } from '../helpers/types';

export interface FewShotExample {
  counterparty_name: string | null;
  amount: number;
  description: string;
  original_description: string | null;
  category_id: number | null;
  category_name: string | null;
  organization_id: number | null;
  organization_name: string | null;
  type: string;
}

/**
 * Select diverse few-shot examples from confirmed historical transactions.
 * Picks 2 per category (diverse counterparties) + examples for special types.
 */
export function selectFewShotExamples(db: Database.Database): FewShotExample[] {
  // Get 2 confirmed examples per category, preferring diverse counterparties
  const examples = db.prepare(`
    SELECT e.counterparty_name, e.amount, e.description, e.original_description,
           e.category_id, c.name AS category_name,
           e.organization_id, o.name AS organization_name, e.type
    FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY category_id
        ORDER BY
          category_confirmed DESC,
          counterparty_name,
          date DESC
      ) AS rn
      FROM transactions
      WHERE category_id IS NOT NULL
    ) e
    LEFT JOIN categories c ON c.id = e.category_id
    LEFT JOIN organizations o ON o.id = e.organization_id
    WHERE e.rn <= 2
    ORDER BY e.category_id, e.rn
  `).all() as FewShotExample[];

  // Add examples for special types if not well represented
  const hasReimbursable = examples.some(e => e.type === 'reimbursable');
  const hasSavings = examples.some(e => e.type === 'savings');

  if (!hasReimbursable) {
    const reimb = db.prepare(`
      SELECT t.counterparty_name, t.amount, t.description, t.original_description,
             t.category_id, c.name AS category_name,
             t.organization_id, o.name AS organization_name, t.type
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN organizations o ON o.id = t.organization_id
      WHERE t.type = 'reimbursable' AND t.category_confirmed = 1
      ORDER BY t.date DESC
      LIMIT 2
    `).all() as FewShotExample[];
    examples.push(...reimb);
  }

  if (!hasSavings) {
    const savings = db.prepare(`
      SELECT t.counterparty_name, t.amount, t.description, t.original_description,
             t.category_id, c.name AS category_name,
             t.organization_id, o.name AS organization_name, t.type
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN organizations o ON o.id = t.organization_id
      WHERE t.type = 'savings' AND t.category_confirmed = 1
      ORDER BY t.date DESC
      LIMIT 2
    `).all() as FewShotExample[];
    examples.push(...savings);
  }

  return examples;
}

/**
 * Format few-shot examples as context string for the AI prompt.
 */
export function formatFewShotForPrompt(examples: FewShotExample[]): string {
  if (examples.length === 0) return '(geen voorbeelden beschikbaar)';

  return examples.map(e => {
    const parts = [
      `counterparty="${e.counterparty_name ?? 'onbekend'}"`,
      `bedrag=€${e.amount.toFixed(2)}`,
      e.original_description ? `beschrijving="${e.original_description}"` : null,
    ].filter(Boolean).join(', ');

    const result: Record<string, unknown> = {
      readable_name: e.description,
      category_id: e.category_id,
      type: e.type,
    };
    if (e.organization_id) result.organization_id = e.organization_id;

    return `TX: ${parts}\n→ ${JSON.stringify(result)}`;
  }).join('\n\n');
}

/** Shared type for the classification fields applied to a transaction by AI/rules. */
export interface TransactionClassification {
  type: 'personal' | 'reimbursable' | 'income' | 'savings';
  category_id: number | null;
  organization_id: number | null;
  splitwise_expense_id: string | null;
  splitwise_owed_share: number | null;
  notes: string | null;
  category_confirmed: number;
}

/** Load categories + organizations + unreimbursed expenses from DB for AI analysis context. */
export function loadAnalysisContext(
  db: Database.Database,
  options?: { excludeIds?: number[] }
): Pick<AnalysisContext, 'categories' | 'organizations' | 'unreimbursedExpenses'> {
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY id').all() as { id: number; name: string }[];
  const organizations = db.prepare('SELECT id, name FROM organizations ORDER BY id').all() as { id: number; name: string }[];
  const unreimbursedExpenses = getUnreimbursedExpensesForContext(db, { excludeIds: options?.excludeIds });
  return { categories, organizations, unreimbursedExpenses };
}

/** Normalize a splitwise_expense_id (number|string|null) to a clean string or null. */
export function normalizeSplitwise(id: string | number | null | undefined): string | null {
  return id != null ? String(parseInt(String(id), 10)) : null;
}

/** Resolve splitwise owed_share from an AI result's splitwise_expense_id. */
export function resolveSplitwise(
  aiResult: TransactionAnalysisResult,
  splitwiseExpenses: AnalysisContext['splitwiseExpenses']
): { splitwise_expense_id: string | null; splitwise_owed_share: number | null } {
  const swId = normalizeSplitwise(aiResult.splitwise_expense_id);
  let splitwise_owed_share: number | null = null;
  if (swId) {
    const swExpense = splitwiseExpenses.find(e => String(e.id) === swId);
    if (swExpense) splitwise_owed_share = swExpense.my_owed_share;
  }
  return { splitwise_expense_id: swId, splitwise_owed_share };
}

/** Build a TransactionClassification from an AI result + splitwise data. */
export function buildClassification(
  ai: TransactionAnalysisResult,
  splitwiseExpenses: AnalysisContext['splitwiseExpenses']
): TransactionClassification {
  const { splitwise_expense_id, splitwise_owed_share } = resolveSplitwise(ai, splitwiseExpenses);
  return {
    type: ai.type,
    category_id: ai.category_id,
    organization_id: ai.organization_id,
    splitwise_expense_id,
    splitwise_owed_share,
    notes: ai.notes,
    category_confirmed: 0,
  };
}

/** Apply an AI analysis result to a transaction (update description, type, category, org, splitwise, notes). */
export function applyAiResult(
  db: Database.Database,
  txId: number,
  ai: TransactionAnalysisResult,
  splitwiseExpenses: AnalysisContext['splitwiseExpenses'],
  fallbackDescription: string
): void {
  const classification = buildClassification(ai, splitwiseExpenses);
  updateTransaction(db, txId, {
    description: ai.readable_name || fallbackDescription,
    ...classification,
  });
}

const AI_MATCH_CONFIDENCE_THRESHOLD = 75;

/** Link AI-detected cross-batch reimbursement matches. */
function linkAiMatchedReimbursements(
  db: Database.Database,
  txs: MatchableTx[],
  aiResults: TransactionAnalysisResult[],
  note: string
): number {
  let linked = 0;
  for (const ai of aiResults) {
    if (ai.matches_existing_id == null || ai.matches_existing_confidence == null) continue;

    const incomeTx = txs[ai.index];
    if (!incomeTx || incomeTx.amount <= 0) continue;

    const expense = db.prepare(
      `SELECT id, amount FROM transactions WHERE id = ? AND type = 'reimbursable' AND reimbursed_at IS NULL`
    ).get(ai.matches_existing_id) as { id: number; amount: number } | undefined;
    if (!expense) continue;

    if (ai.matches_existing_confidence >= AI_MATCH_CONFIDENCE_THRESHOLD) {
      linkAdvanceToRepayment(db, {
        expenseId: expense.id,
        incomeId: incomeTx.id,
        amount: Math.abs(expense.amount),
        reimbursedAt: incomeTx.date,
        note: `${note} (AI-match, ${ai.matches_existing_confidence}% confidence)`,
      });
      linked++;
    } else {
      db.prepare(
        `UPDATE transactions SET notes = CASE WHEN notes IS NOT NULL THEN notes || ' | ' ELSE '' END || ?, updated_at = datetime('now') WHERE id = ?`
      ).run(
        `AI-suggestie: mogelijk terugbetaling van tx #${expense.id} (${ai.matches_existing_confidence}% confidence)`,
        incomeTx.id
      );
    }
  }
  return linked;
}

export interface LinkAndMatchOptions {
  db: Database.Database;
  txs: MatchableTx[];
  aiResults: TransactionAnalysisResult[] | null;
  note: string;
  onProgress: (msg: string, progress: number) => void;
}

/**
 * Shared post-analysis pipeline: batch advance linking, DB-level advance matching,
 * reverse advance matching, and NMBS ticket matching.
 */
export async function linkAndMatchTransactions(opts: LinkAndMatchOptions): Promise<{ nmbs_matched: number; ai_matched: number }> {
  const { db, txs, aiResults, note, onProgress } = opts;

  onProgress('Voorschotten koppelen...', 92);

  // Pass 1: within-batch advance linking (AI-detected)
  if (aiResults) {
    for (const ai of aiResults) {
      if (ai.advance_repaid_by_index === null) continue;
      const advanceTx = txs[ai.index];
      const repaymentTx = txs[ai.advance_repaid_by_index];
      if (!advanceTx || !repaymentTx) continue;
      linkBatchAdvance(db, advanceTx, repaymentTx, `${note} (zelfde batch)`);
    }
  }

  // Pass 1.5: AI-detected cross-batch reimbursement matches
  let ai_matched = 0;
  if (aiResults) {
    ai_matched = linkAiMatchedReimbursements(db, txs, aiResults, note);
  }

  // Pass 2: DB-level advance matching
  for (const tx of txs) {
    if (!tx) continue;
    findAndLinkAdvance(db, tx, note);
  }

  // Pass 3: reverse advance matching (expense → existing income)
  for (const tx of txs) {
    if (!tx) continue;
    findAndLinkReverseAdvance(db, tx, note);
  }

  // Pass 4: NMBS ticket matching
  onProgress('NMBS tickets koppelen...', 96);
  const nmbsResult = await matchNmbsTickets(db, txs.filter(t => t).map(t => t.id));

  return { nmbs_matched: nmbsResult.matched, ai_matched };
}
