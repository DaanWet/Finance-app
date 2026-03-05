import type Database from 'better-sqlite3';
import { updateTransaction } from '../queries/transactions';
import type { TransactionAnalysisResult, AnalysisContext } from './aiAnalysis';
import { linkBatchAdvance, findAndLinkAdvance, findAndLinkReverseAdvance } from './advanceMatching';
import { matchNmbsTickets } from './importHelpers';
import type { MatchableTx } from '../helpers/types';

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

/** Load categories + organizations from DB for AI analysis context. */
export function loadAnalysisContext(db: Database.Database): Pick<AnalysisContext, 'categories' | 'organizations'> {
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY id').all() as { id: number; name: string }[];
  const organizations = db.prepare('SELECT id, name FROM organizations ORDER BY id').all() as { id: number; name: string }[];
  return { categories, organizations };
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
export async function linkAndMatchTransactions(opts: LinkAndMatchOptions): Promise<{ nmbs_matched: number }> {
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

  // Pass 2: DB-level advance matching
  for (const tx of txs) {
    findAndLinkAdvance(db, tx, note);
  }

  // Pass 3: reverse advance matching (expense → existing income)
  for (const tx of txs) {
    findAndLinkReverseAdvance(db, tx, note);
  }

  // Pass 4: NMBS ticket matching
  onProgress('NMBS tickets koppelen...', 96);
  const nmbsResult = await matchNmbsTickets(db, txs.map(t => t.id));

  return { nmbs_matched: nmbsResult.matched };
}
