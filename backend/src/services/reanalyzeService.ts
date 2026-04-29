import type Database from 'better-sqlite3';
import { getTransactionsByIds, updateTransaction } from '../queries/transactions';
import {
  classifyTransactions,
  matchReimbursements as matchReimbursementsAI,
  type TransactionAnalysisInput,
  type TokenUsage,
  type MatchCandidate,
  type UnreimbursedExpense,
} from './aiAnalysis';
import { fetchSplitwiseExpenses } from './splitwiseClient';
import { loadAnalysisContext, selectFewShotExamples, linkAndMatchTransactions } from './analysisHelpers';
import { getMerchantProfiles, findMatchingProfiles } from './merchantProfiles';
import { matchSplitwiseDeterministic } from './deterministicMatching';

function buildReanalyzeInput(tx: { date: string; amount: number; description: string; counterparty_account: string | null; counterparty_name: string | null; original_description: string | null }, index: number): TransactionAnalysisInput {
  return {
    index,
    date: tx.date,
    amount: tx.amount,
    counterparty_iban: tx.counterparty_account ?? '',
    counterparty_name: tx.counterparty_name ?? '',
    omschrijving: tx.original_description ?? tx.description,
    detail: '',
    bericht: '',
  };
}

export async function reanalyzeBulk(
  db: Database.Database,
  txs: ReturnType<typeof getTransactionsByIds>,
  onProgress: (msg: string, progress: number, tokens?: TokenUsage) => void
) {
  onProgress('Data laden...', 5);
  const txIds = txs.map(t => t.id);
  const { categories, organizations, unreimbursedExpenses } = loadAnalysisContext(db, { excludeIds: txIds });

  // Load merchant profiles + few-shot
  onProgress('Context laden...', 8);
  const allProfiles = getMerchantProfiles(db);
  const profileMatches = findMatchingProfiles(
    allProfiles,
    txs.map(t => ({ counterparty_account: t.counterparty_account, counterparty_name: t.counterparty_name })),
  );
  const fewShotExamples = selectFewShotExamples(db);

  // Deterministic Splitwise matching
  onProgress('Splitwise data ophalen...', 10);
  const earliestDate = txs.reduce((min, tx) => tx.date < min ? tx.date : min, txs[0].date);
  const splitwiseExpenses = await fetchSplitwiseExpenses(earliestDate);
  const splitwiseMatches = matchSplitwiseDeterministic(
    txs.map((tx, i) => ({ index: i, amount: tx.amount, date: tx.date, description: tx.description })),
    splitwiseExpenses,
  );
  const swByIndex = new Map(splitwiseMatches.map(m => [m.transactionIndex, m]));

  // AI Call 1: Classification
  onProgress('AI-classificatie uitvoeren...', 15);
  const inputs = txs.map((tx, idx) => buildReanalyzeInput(tx, idx));

  const { results: classResults, usage: classUsage } = await classifyTransactions(
    inputs,
    { categories, organizations, merchantProfiles: profileMatches, fewShotExamples },
    (tokens) => onProgress('AI-classificatie uitvoeren...', 15, tokens),
  );

  if (!classResults || classResults.length === 0) {
    return null;
  }

  onProgress('Transacties bijwerken...', 75, classUsage ?? undefined);

  // Apply classification results + Splitwise matches
  for (const cr of classResults) {
    const tx = txs[cr.index];
    if (!tx) continue;
    const swMatch = swByIndex.get(cr.index);
    updateTransaction(db, tx.id, {
      description: cr.readable_name || tx.description,
      type: cr.type,
      category_id: cr.category_id,
      organization_id: cr.organization_id,
      splitwise_expense_id: swMatch?.splitwise_expense_id ?? null,
      splitwise_owed_share: swMatch?.splitwise_owed_share ?? null,
      notes: cr.notes,
      category_confirmed: 0,
    });
  }

  // AI Call 2: Reimbursement matching
  const incomeTransactions: MatchCandidate[] = [];
  const batchExpenses: MatchCandidate[] = [];

  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i];
    const cr = classResults.find(r => r.index === i);
    const txType = cr?.type ?? tx.type;
    if (tx.amount > 0) {
      incomeTransactions.push({
        index: i, id: tx.id, date: tx.date, amount: tx.amount,
        description: cr?.readable_name ?? tx.description,
        counterparty_name: tx.counterparty_name,
      });
    } else if (txType === 'reimbursable') {
      batchExpenses.push({
        index: i, id: tx.id, date: tx.date, amount: tx.amount,
        description: cr?.readable_name ?? tx.description,
        counterparty_name: tx.counterparty_name,
      });
    }
  }

  // Build aiResults-compatible format for linkAndMatchTransactions
  const aiResults = classResults.map(cr => {
    const swMatch = swByIndex.get(cr.index);
    return {
      index: cr.index,
      readable_name: cr.readable_name,
      category_id: cr.category_id,
      organization_id: cr.organization_id,
      type: cr.type,
      is_advance: false as const,
      advance_repaid_by_index: null as number | null,
      splitwise_expense_id: swMatch?.splitwise_expense_id ?? null,
      notes: cr.notes,
      matches_existing_id: null as number | null,
      matches_existing_confidence: null as number | null,
    };
  });

  if (incomeTransactions.length > 0 && (batchExpenses.length > 0 || (unreimbursedExpenses && unreimbursedExpenses.length > 0))) {
    onProgress('Terugbetalingen matchen...', 82);
    const dbExpenses: UnreimbursedExpense[] = (unreimbursedExpenses ?? []).map(e => ({
      id: e.id, date: e.date, amount: e.amount, description: e.description,
      counterparty_name: e.counterparty_name, organization_name: e.organization_name,
    }));

    const { matches } = await matchReimbursementsAI(
      incomeTransactions, batchExpenses, dbExpenses,
      (tokens) => onProgress('Terugbetalingen matchen...', 82, tokens),
    );

    if (matches && matches.length > 0) {
      for (const match of matches) {
        if (match.confidence >= 75) {
          let existing = aiResults.find(r => r.index === match.income_index);
          if (existing && match.match_type === 'cross_batch') {
            existing.matches_existing_id = match.expense_id;
            existing.matches_existing_confidence = match.confidence;
          }
        }
      }
    }
  }

  await linkAndMatchTransactions({
    db, txs, aiResults,
    note: 'Automatisch gedetecteerd bij heranalyse',
    onProgress,
  });

  const updated = getTransactionsByIds(db, txIds);
  return { reanalyzed: updated.length, transactions: updated };
}

export async function reanalyzeSingle(
  db: Database.Database,
  tx: { id: number; date: string; amount: number; description: string; counterparty_account: string | null; counterparty_name: string | null; original_description: string | null }
) {
  const { categories, organizations, unreimbursedExpenses } = loadAnalysisContext(db, { excludeIds: [tx.id] });

  // Load merchant profiles + few-shot
  const allProfiles = getMerchantProfiles(db);
  const profileMatches = findMatchingProfiles(
    allProfiles,
    [{ counterparty_account: tx.counterparty_account, counterparty_name: tx.counterparty_name }],
  );
  const fewShotExamples = selectFewShotExamples(db);

  // Deterministic Splitwise matching
  const splitwiseExpenses = await fetchSplitwiseExpenses(tx.date);
  const splitwiseMatches = matchSplitwiseDeterministic(
    [{ index: 0, amount: tx.amount, date: tx.date, description: tx.description }],
    splitwiseExpenses,
  );

  // AI Call 1: Classification
  const input = buildReanalyzeInput(tx, 0);
  const { results: classResults } = await classifyTransactions(
    [input],
    { categories, organizations, merchantProfiles: profileMatches, fewShotExamples },
  );

  if (!classResults || classResults.length === 0) return null;

  const cr = classResults[0];
  const swMatch = splitwiseMatches[0];
  updateTransaction(db, tx.id, {
    description: cr.readable_name || tx.description,
    type: cr.type,
    category_id: cr.category_id,
    organization_id: cr.organization_id,
    splitwise_expense_id: swMatch?.splitwise_expense_id ?? null,
    splitwise_owed_share: swMatch?.splitwise_owed_share ?? null,
    notes: cr.notes,
    category_confirmed: 0,
  });

  // Build aiResults for linking pipeline
  const aiResults = [{
    index: 0,
    readable_name: cr.readable_name,
    category_id: cr.category_id,
    organization_id: cr.organization_id,
    type: cr.type,
    is_advance: false as const,
    advance_repaid_by_index: null as null,
    splitwise_expense_id: swMatch?.splitwise_expense_id ?? null,
    notes: cr.notes,
    matches_existing_id: null as null,
    matches_existing_confidence: null as null,
  }];

  const noopProgress = () => {};
  await linkAndMatchTransactions({
    db, txs: [tx], aiResults,
    note: 'Automatisch gedetecteerd bij heranalyse',
    onProgress: noopProgress,
  });
}
