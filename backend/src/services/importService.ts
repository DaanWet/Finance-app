import type Database from 'better-sqlite3';
import { createTransaction, type CreateTransactionInput } from '../queries/transactions';
import { analyzeTransactions, TransactionAnalysisInput, TransactionAnalysisResult } from './aiAnalysis';
import { fetchSplitwiseExpenses } from './splitwiseClient';
import { loadAnalysisContext, resolveSplitwise, linkAndMatchTransactions } from './analysisHelpers';
import type { AnalysisContext } from './aiAnalysis';
import type { ParsedIngRow } from './csvParser';
import type { MatchableTx } from '../helpers/types';

export interface ImportProgress {
  message: string;
  progress: number;
}

type RuleMatch = { type: 'personal' | 'reimbursable' | 'income' | 'savings'; organization_id: number | null; category_id: number | null };

/** Match classification rules against rows, returning a map of index -> matched rule. */
function applyClassificationRules(
  db: Database.Database,
  rowsToAnalyze: { row: ParsedIngRow; i: number }[]
): Map<number, RuleMatch> {
  const rules = db.prepare('SELECT * FROM classification_rules ORDER BY id').all() as Array<{
    id: number; pattern: string; type: RuleMatch['type'];
    organization_id: number | null; category_id: number | null;
  }>;

  const matches = new Map<number, RuleMatch>();
  for (const { row, i } of rowsToAnalyze) {
    for (const rule of rules) {
      if (row.description.toLowerCase().includes(rule.pattern.toLowerCase())) {
        matches.set(i, { type: rule.type, organization_id: rule.organization_id, category_id: rule.category_id });
        break;
      }
    }
  }
  return matches;
}

/** Merge rule match + AI result into a CreateTransactionInput for a single row. */
function classifyRow(
  row: ParsedIngRow,
  index: number,
  ruleMatch: RuleMatch | undefined,
  aiResults: TransactionAnalysisResult[] | null,
  splitwiseExpenses: AnalysisContext['splitwiseExpenses']
): CreateTransactionInput {
  let type: RuleMatch['type'] = ruleMatch?.type ?? (row.amount > 0 ? 'income' : 'personal');
  let organization_id: number | null = ruleMatch?.organization_id ?? null;
  let category_id: number | null = ruleMatch?.category_id ?? null;
  let splitwise_expense_id: string | null = null;
  let splitwise_owed_share: number | null = null;
  let notes: string | null = null;
  let description = row.description;
  let category_confirmed = 1;

  if (aiResults) {
    const ai = aiResults.find(r => r.index === index);
    if (ai) {
      description = ai.readable_name || row.description;
      if (!ruleMatch) {
        type = ai.type;
        organization_id = ai.organization_id;
        category_id = ai.category_id;
        if (category_id !== null) category_confirmed = 0;
      } else if (ruleMatch.category_id === null && ai.category_id !== null) {
        category_id = ai.category_id;
        category_confirmed = 0;
      }
      const sw = resolveSplitwise(ai, splitwiseExpenses);
      splitwise_expense_id = sw.splitwise_expense_id;
      splitwise_owed_share = sw.splitwise_owed_share;
      notes = ai.notes;
    }
  }

  return {
    description, amount: row.amount, date: row.date, type,
    category_id, organization_id,
    ing_transaction_id: row.ing_transaction_id,
    splitwise_expense_id, splitwise_owed_share, notes,
    counterparty_account: row.counterparty_account,
    counterparty_name: row.counterparty_name,
    original_description: row.description,
    category_confirmed,
  };
}

export async function executeImport(
  db: Database.Database,
  rows: ParsedIngRow[],
  selectedSet: Set<number> | null,
  onProgress: (msg: string, progress: number) => void
) {
  onProgress('CSV verwerken...', 5);
  const { categories, organizations, unreimbursedExpenses } = loadAnalysisContext(db);

  const rowsToAnalyze = rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => selectedSet === null || selectedSet.has(i));

  const ruleMatchByIndex = applyClassificationRules(db, rowsToAnalyze);

  const dates = rowsToAnalyze.map(({ row }) => row.date).sort();
  const earliestDate = dates[0] ?? new Date().toISOString().split('T')[0];

  onProgress('Splitwise data ophalen...', 10);
  const splitwiseExpenses = await fetchSplitwiseExpenses(earliestDate);

  onProgress('AI-analyse uitvoeren...', 15);
  const analysisInputs: TransactionAnalysisInput[] = rowsToAnalyze.map(({ row, i }) => ({
    index: i,
    date: row.date,
    amount: row.amount,
    counterparty_iban: row.counterparty_account ?? '',
    counterparty_name: row.raw['Naam van de rekening'] ?? row.raw['Naam'] ?? row.counterparty_name ?? '',
    omschrijving: row.raw['Omschrijving'] ?? row.counterparty_name ?? '',
    detail: row.raw['Detail van de omzet'] ?? '',
    bericht: row.raw['Bericht'] ?? row.raw['Mededeling'] ?? row.description ?? '',
  }));

  const aiResults = await analyzeTransactions(analysisInputs, { categories, organizations, splitwiseExpenses, unreimbursedExpenses });
  const aiAnalyzed = aiResults !== null;

  onProgress('Transacties opslaan...', 80);

  let imported = 0;
  let skipped = 0;
  const importedRows: MatchableTx[] = [];
  const savedByIndex = new Map<number, MatchableTx>();

  for (let i = 0; i < rows.length; i++) {
    if (selectedSet !== null && !selectedSet.has(i)) continue;

    const row = rows[i];
    const existing = db.prepare('SELECT id FROM transactions WHERE ing_transaction_id = ?').get(row.ing_transaction_id);
    if (existing) { skipped++; continue; }

    const input = classifyRow(row, i, ruleMatchByIndex.get(i), aiResults, splitwiseExpenses);
    const tx = createTransaction(db, input);

    const matchable: MatchableTx = { id: tx.id, date: tx.date, amount: tx.amount, counterparty_account: row.counterparty_account };
    savedByIndex.set(i, matchable);
    importedRows.push(matchable);
    imported++;
  }

  // Use savedByIndex as indexed array for batch advance linking
  const indexedTxs: MatchableTx[] = [];
  for (const [idx, tx] of savedByIndex) {
    indexedTxs[idx] = tx;
  }

  const { nmbs_matched, ai_matched } = await linkAndMatchTransactions({
    db, txs: indexedTxs, aiResults,
    note: 'Automatisch gedetecteerd bij import',
    onProgress,
  });

  return {
    imported, skipped,
    total: selectedSet ? selectedSet.size : rows.length,
    ai_analyzed: aiAnalyzed,
    nmbs_matched,
    ai_matched,
    transactions: importedRows,
  };
}
