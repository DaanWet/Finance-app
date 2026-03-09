import type Database from 'better-sqlite3';
import { getTransactionsByIds } from '../queries/transactions';
import { analyzeTransactions, TransactionAnalysisInput, type TokenUsage } from './aiAnalysis';
import { fetchSplitwiseExpenses } from './splitwiseClient';
import { loadAnalysisContext, applyAiResult, linkAndMatchTransactions } from './analysisHelpers';

function buildReanalyzeInput(tx: { date: string; amount: number; description: string; counterparty_account: string | null }, index: number): TransactionAnalysisInput {
  return {
    index,
    date: tx.date,
    amount: tx.amount,
    counterparty_iban: tx.counterparty_account ?? '',
    counterparty_name: '',
    omschrijving: tx.description,
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

  onProgress('Splitwise data ophalen...', 10);
  const earliestDate = txs.reduce((min, tx) => tx.date < min ? tx.date : min, txs[0].date);
  const splitwiseExpenses = await fetchSplitwiseExpenses(earliestDate);

  onProgress('AI-analyse uitvoeren...', 15);
  const inputs = txs.map((tx, idx) => buildReanalyzeInput(tx, idx));

  const { results: aiResults, usage: tokenUsage } = await analyzeTransactions(
    inputs,
    { categories, organizations, splitwiseExpenses, unreimbursedExpenses },
    (tokens) => onProgress('AI-analyse uitvoeren...', 15, tokens),
  );
  if (!aiResults || aiResults.length === 0) {
    return null;
  }

  onProgress('Transacties bijwerken...', 82, tokenUsage ?? undefined);

  for (const ai of aiResults) {
    const tx = txs[ai.index];
    if (!tx) continue;
    applyAiResult(db, tx.id, ai, splitwiseExpenses, tx.description);
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
  tx: { id: number; date: string; amount: number; description: string; counterparty_account: string | null }
) {
  const { categories, organizations, unreimbursedExpenses } = loadAnalysisContext(db, { excludeIds: [tx.id] });
  const splitwiseExpenses = await fetchSplitwiseExpenses(tx.date);

  const input = buildReanalyzeInput(tx, 0);
  const { results: aiResults } = await analyzeTransactions([input], { categories, organizations, splitwiseExpenses, unreimbursedExpenses });
  if (!aiResults || aiResults.length === 0) {
    return null;
  }

  applyAiResult(db, tx.id, aiResults[0], splitwiseExpenses, tx.description);

  // For single reanalyze, use the shared pipeline (handles advance + NMBS + AI matching)
  const noopProgress = () => {};
  await linkAndMatchTransactions({
    db, txs: [tx], aiResults,
    note: 'Automatisch gedetecteerd bij heranalyse',
    onProgress: noopProgress,
  });
}
