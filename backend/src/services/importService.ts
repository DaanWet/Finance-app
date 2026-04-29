import type Database from 'better-sqlite3';
import { createTransaction, type CreateTransactionInput } from '../queries/transactions';
import {
  analyzeTransactions,
  classifyTransactions,
  matchReimbursements as matchReimbursementsAI,
  type TransactionAnalysisInput,
  type TransactionAnalysisResult,
  type TokenUsage,
  type ClassificationResult,
  type MatchCandidate,
  type UnreimbursedExpense,
} from './aiAnalysis';
import { fetchSplitwiseExpenses } from './splitwiseClient';
import { loadAnalysisContext, selectFewShotExamples, formatFewShotForPrompt, resolveSplitwise, linkAndMatchTransactions } from './analysisHelpers';
import type { AnalysisContext } from './aiAnalysis';
import type { ParsedIngRow } from './csvParser';
import type { MatchableTx } from '../helpers/types';
import { getMerchantProfiles, findMatchingProfiles, formatProfilesForPrompt } from './merchantProfiles';
import { matchSplitwiseDeterministic, matchObviousAdvances } from './deterministicMatching';

export interface ImportProgress {
  message: string;
  progress: number;
}

// ─── Classification passed from frontend ─────────────────────────────────────

export interface PreviewClassification {
  index: number;
  readable_name: string;
  category_id: number | null;
  organization_id: number | null;
  type: 'personal' | 'reimbursable' | 'income' | 'savings';
  classification_confidence: number;
  splitwise_expense_id: string | null;
  splitwise_owed_share: number | null;
  notes: string | null;
  user_modified?: boolean;
}

// ─── Classification rules (unchanged) ────────────────────────────────────────

type RuleMatch = { type: 'personal' | 'reimbursable' | 'income' | 'savings'; organization_id: number | null; category_id: number | null };

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

// ─── Row classification (merge rule + AI) ────────────────────────────────────

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

// ─── Row classification from preview classifications ─────────────────────────

function classifyRowFromPreview(
  row: ParsedIngRow,
  classification: PreviewClassification,
): CreateTransactionInput {
  return {
    description: classification.readable_name || row.description,
    amount: row.amount,
    date: row.date,
    type: classification.type,
    category_id: classification.category_id,
    organization_id: classification.organization_id,
    ing_transaction_id: row.ing_transaction_id,
    splitwise_expense_id: classification.splitwise_expense_id,
    splitwise_owed_share: classification.splitwise_owed_share,
    notes: classification.notes,
    counterparty_account: row.counterparty_account,
    counterparty_name: row.counterparty_name,
    original_description: row.description,
    category_confirmed: classification.user_modified ? 1 : 0,
  };
}

// ─── Build analysis inputs ───────────────────────────────────────────────────

function buildAnalysisInputs(
  rowsToAnalyze: { row: ParsedIngRow; i: number }[]
): TransactionAnalysisInput[] {
  return rowsToAnalyze.map(({ row, i }) => ({
    index: i,
    date: row.date,
    amount: row.amount,
    counterparty_iban: row.counterparty_account ?? '',
    counterparty_name: row.raw['Naam van de rekening'] ?? row.raw['Naam'] ?? row.counterparty_name ?? '',
    omschrijving: row.raw['Omschrijving'] ?? row.counterparty_name ?? '',
    detail: row.raw['Detail van de omzet'] ?? '',
    bericht: row.raw['Bericht'] ?? row.raw['Mededeling'] ?? row.description ?? '',
  }));
}

// ─── Classify Preview (new: AI Call 1 only, no saving) ───────────────────────

export async function executeClassifyPreview(
  db: Database.Database,
  rows: ParsedIngRow[],
  selectedSet: Set<number> | null,
  onProgress: (msg: string, progress: number, tokens?: TokenUsage) => void
) {
  onProgress('Context laden...', 5);
  const { categories, organizations } = loadAnalysisContext(db);

  const rowsToAnalyze = rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => selectedSet === null || selectedSet.has(i));

  // Merchant profiles + few-shot
  onProgress('Merchant historiek laden...', 10);
  const allProfiles = getMerchantProfiles(db);
  const profileMatches = findMatchingProfiles(
    allProfiles,
    rowsToAnalyze.map(({ row }) => ({ counterparty_account: row.counterparty_account, counterparty_name: row.counterparty_name })),
  );
  const fewShotExamples = selectFewShotExamples(db);

  // Deterministic Splitwise matching
  onProgress('Splitwise matchen...', 15);
  const dates = rowsToAnalyze.map(({ row }) => row.date).sort();
  const earliestDate = dates[0] ?? new Date().toISOString().split('T')[0];
  const splitwiseExpenses = await fetchSplitwiseExpenses(earliestDate);
  const splitwiseMatches = matchSplitwiseDeterministic(
    rowsToAnalyze.map(({ row, i }) => ({ index: i, amount: row.amount, date: row.date, description: row.description })),
    splitwiseExpenses,
  );
  const splitwiseByIndex = new Map(splitwiseMatches.map(m => [m.transactionIndex, m]));

  // Classification rules
  const ruleMatchByIndex = applyClassificationRules(db, rowsToAnalyze);

  // AI Call 1: Classification
  onProgress('AI-classificatie uitvoeren...', 20);
  const analysisInputs = buildAnalysisInputs(rowsToAnalyze);

  const { results: classificationResults, usage: tokenUsage } = await classifyTransactions(
    analysisInputs,
    { categories, organizations, merchantProfiles: profileMatches, fewShotExamples },
    (tokens) => onProgress('AI-classificatie uitvoeren...', 20, tokens),
  );

  onProgress('Resultaten verwerken...', 90, tokenUsage ?? undefined);

  // Build classified preview rows
  const classifiedRows: PreviewClassification[] = rowsToAnalyze.map(({ row, i }) => {
    const ruleMatch = ruleMatchByIndex.get(i);
    const aiResult = classificationResults?.find(r => r.index === i);
    const swMatch = splitwiseByIndex.get(i);

    // Determine classification (rule > AI > defaults)
    let type: PreviewClassification['type'] = ruleMatch?.type ?? aiResult?.type ?? (row.amount > 0 ? 'income' : 'personal');
    let category_id = ruleMatch?.category_id ?? aiResult?.category_id ?? null;
    let organization_id = ruleMatch?.organization_id ?? aiResult?.organization_id ?? null;
    let readable_name = aiResult?.readable_name ?? row.description;
    let confidence = aiResult?.classification_confidence ?? (ruleMatch ? 95 : 30);
    let notes = aiResult?.notes ?? null;

    // Apply Splitwise match
    let splitwise_expense_id: string | null = swMatch?.splitwise_expense_id ?? null;
    let splitwise_owed_share: number | null = swMatch?.splitwise_owed_share ?? null;

    return {
      index: i,
      readable_name,
      category_id,
      organization_id,
      type,
      classification_confidence: confidence,
      splitwise_expense_id,
      splitwise_owed_share,
      notes,
    };
  });

  return {
    classifications: classifiedRows,
    categories: categories.map(c => {
      const full = db.prepare('SELECT id, name, color, icon FROM categories WHERE id = ?').get(c.id) as { id: number; name: string; color: string; icon: string | null } | undefined;
      return full ?? { ...c, color: '#94a3b8', icon: null };
    }),
    organizations: organizations.map(o => {
      const full = db.prepare('SELECT id, name, color FROM organizations WHERE id = ?').get(o.id) as { id: number; name: string; color: string } | undefined;
      return full ?? { ...o, color: '#6366f1' };
    }),
    tokens: tokenUsage,
  };
}

// ─── Execute Import (supports both paths: with and without pre-classifications) ─

export async function executeImport(
  db: Database.Database,
  rows: ParsedIngRow[],
  selectedSet: Set<number> | null,
  onProgress: (msg: string, progress: number, tokens?: TokenUsage) => void,
  preClassifications?: PreviewClassification[],
) {
  onProgress('CSV verwerken...', 5);
  const { categories, organizations, unreimbursedExpenses } = loadAnalysisContext(db);

  const rowsToAnalyze = rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => selectedSet === null || selectedSet.has(i));

  let aiResults: TransactionAnalysisResult[] | null = null;
  let splitwiseExpenses: AnalysisContext['splitwiseExpenses'] = [];
  let tokenUsage: TokenUsage | null = null;
  let totalTokenUsage: TokenUsage | null = null;

  const preClassByIndex = preClassifications
    ? new Map(preClassifications.map(c => [c.index, c]))
    : null;

  if (!preClassByIndex) {
    // ─── Path B: Legacy flow (no pre-classifications) ───────────────────
    const ruleMatchByIndex = applyClassificationRules(db, rowsToAnalyze);

    const dates = rowsToAnalyze.map(({ row }) => row.date).sort();
    const earliestDate = dates[0] ?? new Date().toISOString().split('T')[0];

    onProgress('Splitwise data ophalen...', 10);
    splitwiseExpenses = await fetchSplitwiseExpenses(earliestDate);

    onProgress('AI-analyse uitvoeren...', 15);

    // Load merchant profiles + few-shot for improved legacy prompt
    const allProfiles = getMerchantProfiles(db);
    const profileMatches = findMatchingProfiles(
      allProfiles,
      rowsToAnalyze.map(({ row }) => ({ counterparty_account: row.counterparty_account, counterparty_name: row.counterparty_name })),
    );
    const fewShotExamples = selectFewShotExamples(db);

    const analysisInputs = buildAnalysisInputs(rowsToAnalyze);

    // Use the new classifyTransactions for the legacy path too (better prompt)
    const classResult = await classifyTransactions(
      analysisInputs,
      { categories, organizations, merchantProfiles: profileMatches, fewShotExamples },
      (tokens) => onProgress('AI-classificatie uitvoeren...', 15, tokens),
    );
    tokenUsage = classResult.usage;

    // Convert ClassificationResult[] to TransactionAnalysisResult[] for legacy merge
    if (classResult.results) {
      // Also do deterministic Splitwise matching
      const splitwiseMatches = matchSplitwiseDeterministic(
        rowsToAnalyze.map(({ row, i }) => ({ index: i, amount: row.amount, date: row.date, description: row.description })),
        splitwiseExpenses,
      );
      const swByIndex = new Map(splitwiseMatches.map(m => [m.transactionIndex, m]));

      aiResults = classResult.results.map(cr => {
        const swMatch = swByIndex.get(cr.index);
        return {
          index: cr.index,
          readable_name: cr.readable_name,
          category_id: cr.category_id,
          organization_id: cr.organization_id,
          type: cr.type,
          is_advance: false,
          advance_repaid_by_index: null,
          splitwise_expense_id: swMatch?.splitwise_expense_id ?? null,
          notes: cr.notes,
          matches_existing_id: null,
          matches_existing_confidence: null,
        };
      });
    }

    // Apply rule overrides (same as before)
    if (aiResults) {
      for (const ai of aiResults) {
        const rule = ruleMatchByIndex.get(ai.index);
        if (rule) {
          ai.type = rule.type;
          if (rule.organization_id) ai.organization_id = rule.organization_id;
          if (rule.category_id) ai.category_id = rule.category_id;
        }
      }
    }
  }

  const aiAnalyzed = preClassByIndex !== null || aiResults !== null;

  onProgress('Transacties opslaan...', 80, tokenUsage ?? undefined);

  let imported = 0;
  let skipped = 0;
  const importedRows: MatchableTx[] = [];
  const savedByIndex = new Map<number, MatchableTx>();

  for (let i = 0; i < rows.length; i++) {
    if (selectedSet !== null && !selectedSet.has(i)) continue;

    const row = rows[i];
    const existing = db.prepare('SELECT id FROM transactions WHERE ing_transaction_id = ?').get(row.ing_transaction_id);
    if (existing) { skipped++; continue; }

    let input: CreateTransactionInput;
    if (preClassByIndex && preClassByIndex.has(i)) {
      input = classifyRowFromPreview(row, preClassByIndex.get(i)!);
    } else {
      const ruleMatch = !preClassByIndex ? applyClassificationRules(db, [{ row, i }]).get(i) : undefined;
      input = classifyRow(row, i, ruleMatch, aiResults, splitwiseExpenses);
    }

    const tx = createTransaction(db, input);
    const matchable: MatchableTx = { id: tx.id, date: tx.date, amount: tx.amount, counterparty_account: row.counterparty_account };
    savedByIndex.set(i, matchable);
    importedRows.push(matchable);
    imported++;
  }

  // Build indexed array for batch advance linking
  const indexedTxs: MatchableTx[] = [];
  for (const [idx, tx] of savedByIndex) {
    indexedTxs[idx] = tx;
  }

  // AI Call 2: Reimbursement matching (if there are income transactions)
  let ai_matched = 0;
  const incomeTransactions: MatchCandidate[] = [];
  const batchExpenses: MatchCandidate[] = [];

  for (const [idx, tx] of savedByIndex) {
    const row = rows[idx];
    const classification = preClassByIndex?.get(idx);
    const txType = classification?.type ?? (aiResults?.find(r => r.index === idx)?.type) ?? (tx.amount > 0 ? 'income' : 'personal');

    if (tx.amount > 0) {
      incomeTransactions.push({
        index: idx, id: tx.id, date: tx.date, amount: tx.amount,
        description: classification?.readable_name ?? row.description,
        counterparty_name: row.counterparty_name,
      });
    } else if (txType === 'reimbursable') {
      batchExpenses.push({
        index: idx, id: tx.id, date: tx.date, amount: tx.amount,
        description: classification?.readable_name ?? row.description,
        counterparty_name: row.counterparty_name,
      });
    }
  }

  if (incomeTransactions.length > 0 && (batchExpenses.length > 0 || (unreimbursedExpenses && unreimbursedExpenses.length > 0))) {
    onProgress('Terugbetalingen matchen...', 88);
    const dbExpenses: UnreimbursedExpense[] = (unreimbursedExpenses ?? []).map(e => ({
      id: e.id,
      date: e.date,
      amount: e.amount,
      description: e.description,
      counterparty_name: e.counterparty_name,
      organization_name: e.organization_name,
    }));

    const { matches, usage: matchUsage } = await matchReimbursementsAI(
      incomeTransactions,
      batchExpenses,
      dbExpenses,
      (tokens) => onProgress('Terugbetalingen matchen...', 88, tokens),
    );

    if (matchUsage && tokenUsage) {
      totalTokenUsage = {
        input_tokens: tokenUsage.input_tokens + matchUsage.input_tokens,
        output_tokens: tokenUsage.output_tokens + matchUsage.output_tokens,
        cache_read_input_tokens: tokenUsage.cache_read_input_tokens + matchUsage.cache_read_input_tokens,
        cache_creation_input_tokens: tokenUsage.cache_creation_input_tokens + matchUsage.cache_creation_input_tokens,
        total_cost_usd: tokenUsage.total_cost_usd + matchUsage.total_cost_usd,
      };
    }

    // Convert AI matches into aiResults-compatible format for linkAndMatchTransactions
    if (matches && matches.length > 0) {
      if (!aiResults) aiResults = [];
      for (const match of matches) {
        if (match.confidence >= 75) {
          // Find or create the AI result entry for this income
          let existing = aiResults.find(r => r.index === match.income_index);
          if (!existing) {
            existing = {
              index: match.income_index,
              readable_name: '',
              category_id: null,
              organization_id: null,
              type: 'income',
              is_advance: false,
              advance_repaid_by_index: null,
              splitwise_expense_id: null,
              notes: null,
              matches_existing_id: null,
              matches_existing_confidence: null,
            };
            aiResults.push(existing);
          }
          if (match.match_type === 'cross_batch') {
            existing.matches_existing_id = match.expense_id;
            existing.matches_existing_confidence = match.confidence;
          } else {
            // Within-batch: find the index of the expense in our saved transactions
            const expenseEntry = [...savedByIndex.entries()].find(([, tx]) => tx.id === match.expense_id);
            if (expenseEntry) {
              existing.advance_repaid_by_index = expenseEntry[0];
            }
          }
        }
      }
      ai_matched = matches.filter(m => m.confidence >= 75).length;
    }
  }

  // Post-import linking pipeline
  const { nmbs_matched, ai_matched: extraAiMatched } = await linkAndMatchTransactions({
    db, txs: indexedTxs, aiResults,
    note: 'Automatisch gedetecteerd bij import',
    onProgress,
  });

  return {
    imported, skipped,
    total: selectedSet ? selectedSet.size : rows.length,
    ai_analyzed: aiAnalyzed,
    nmbs_matched,
    ai_matched: ai_matched + extraAiMatched,
    transactions: importedRows,
    tokens: totalTokenUsage ?? tokenUsage,
  };
}
