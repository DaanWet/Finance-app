import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { getDb } from '../db';
import { createTransaction } from '../queries/transactions';
import { analyzeTransactions, TransactionAnalysisInput, AnalysisContext } from '../services/aiAnalysis';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

interface ParsedIngRow {
  date: string;
  description: string;
  amount: number;
  ing_transaction_id: string;
  counterparty_account: string | null;
  counterparty_name: string | null;
  raw: Record<string, string>;
}

function parseIngCsv(content: string): ParsedIngRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  // Detecteer separator: tab, puntkomma of komma
  const header = lines[0].replace(/\r/, '');
  const sep = header.includes('\t') ? '\t' : header.includes(';') ? ';' : ',';
  const headers = header.split(sep).map(h => h.trim().replace(/^"|"$/g, ''));

  const rows: ParsedIngRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/, '').trim();
    if (!line) continue;

    const values = splitCsvLine(line, sep);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] ?? '').trim().replace(/^"|"$/g, ''); });

    // Nieuw ING-formaat: Rekeningnummer;Naam van de rekening;Rekening tegenpartij;Omzetnummer;Boekingsdatum;Valutadatum;Bedrag;Munteenheid;Omschrijving;Detail van de omzet;Bericht
    // Oud ING-formaat: Datum;Naam;Rekening;Tegenrekening;Code;Afschrijving;Bijschrijving;Mededeling
    const isNewFormat = 'Boekingsdatum' in row || 'Omzetnummer' in row;

    let dateRaw: string;
    let description: string;
    let amount: number;
    let ing_transaction_id: string;
    let counterparty_account: string | null = null;
    let counterparty_name: string | null = null;

    if (isNewFormat) {
      dateRaw = row['Boekingsdatum'] ?? '';
      if (!dateRaw) continue;

      // Bedrag: negatief = debet, positief = credit; komma als decimaalteken
      const bedragRaw = (row['Bedrag'] ?? '0').replace(',', '.');
      amount = parseFloat(bedragRaw) || 0;

      description = row['Bericht'] || row['Detail van de omzet'] || row['Omschrijving'] || 'Onbekend';
      counterparty_account = row['Rekening tegenpartij'] || null;
      counterparty_name = row['Omschrijving'] || null;

      // Gebruik Omzetnummer als stabiel ID indien aanwezig
      const omzetnummer = row['Omzetnummer'] ?? '';
      if (omzetnummer) {
        ing_transaction_id = omzetnummer;
      } else {
        const hashInput = `${dateRaw}|${amount}|${description}`;
        ing_transaction_id = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
      }
    } else {
      // Oud formaat
      dateRaw = row['Datum'] ?? row['Date'] ?? '';
      if (!dateRaw) continue;

      const nameRaw = row['Naam'] ?? row['Name'] ?? '';
      const debitRaw = row['Afschrijving'] ?? row['Debit'] ?? '0';
      const creditRaw = row['Bijschrijving'] ?? row['Credit'] ?? '0';
      const memoRaw = row['Mededeling'] ?? row['Communication'] ?? '';

      const debit = parseFloat(debitRaw.replace(',', '.') || '0');
      const credit = parseFloat(creditRaw.replace(',', '.') || '0');
      amount = credit > 0 ? credit : -debit;

      description = memoRaw || nameRaw || 'Onbekend';
      counterparty_account = row['Tegenrekening'] || null;
      counterparty_name = nameRaw || null;

      const hashInput = `${dateRaw}|${amount}|${description}`;
      ing_transaction_id = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);
    }

    // Datum normaliseren naar YYYY-MM-DD
    // Ondersteunt: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
    let isoDate = dateRaw;
    const slashParts = dateRaw.split('/');
    const dashParts = dateRaw.split('-');
    if (slashParts.length === 3) {
      isoDate = `${slashParts[2]}-${slashParts[1].padStart(2, '0')}-${slashParts[0].padStart(2, '0')}`;
    } else if (dashParts.length === 3 && dashParts[0].length === 2) {
      // DD-MM-YYYY
      isoDate = `${dashParts[2]}-${dashParts[1].padStart(2, '0')}-${dashParts[0].padStart(2, '0')}`;
    }

    rows.push({ date: isoDate, description, amount, ing_transaction_id, counterparty_account, counterparty_name, raw: row });
  }

  return rows;
}

function splitCsvLine(line: string, sep: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

export async function fetchSplitwiseExpenses(dateFrom: string): Promise<AnalysisContext['splitwiseExpenses']> {
  try {
    const db = getDb();
    const apiKey = (db.prepare("SELECT value FROM settings WHERE key = 'splitwise_api_key'").get() as { value: string } | undefined)?.value;
    const userId = (db.prepare("SELECT value FROM settings WHERE key = 'splitwise_user_id'").get() as { value: string } | undefined)?.value;
    if (!apiKey || !userId) return [];

    const oneMonthBefore = new Date(dateFrom);
    oneMonthBefore.setMonth(oneMonthBefore.getMonth() - 1);
    const datedAfter = oneMonthBefore.toISOString().split('T')[0];

    const params = new URLSearchParams({ limit: '200', dated_after: datedAfter });
    const res = await fetch(`https://secure.splitwise.com/api/v3.0/get_expenses?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];

    const data = await res.json() as { expenses: Array<{
      id: number; description: string; cost: string; date: string;
      deleted_at: string | null;
      users: Array<{ user_id: number; paid_share: string; owed_share: string }>;
    }> };

    const userIdNum = Number(userId);
    return data.expenses
      .filter(e => !e.deleted_at)
      .map(e => {
        const myShare = e.users.find(u => u.user_id === userIdNum);
        return {
          id: e.id,
          description: e.description,
          my_paid_share: myShare ? parseFloat(myShare.paid_share) : 0,
          my_owed_share: myShare ? parseFloat(myShare.owed_share) : 0,
          date: e.date?.split('T')[0] ?? e.date,
        };
      })
      .filter(e => e.my_paid_share > 0);
  } catch {
    return [];
  }
}

// POST /api/import/ing-csv/preview
router.post('/ing-csv/preview', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const content = req.file.buffer.toString('utf-8');
  const rows = parseIngCsv(content);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Could not parse CSV. Check file format.' });
  }

  const db = getDb();

  const previewRows = rows.map((row, index) => {
    const existing = db.prepare('SELECT id FROM transactions WHERE ing_transaction_id = ?').get(row.ing_transaction_id);
    return {
      index,
      date: row.date,
      description: row.description,
      amount: row.amount,
      counterparty_account: row.counterparty_account,
      ing_transaction_id: row.ing_transaction_id,
      duplicate: !!existing,
    };
  });

  return res.json({ rows: previewRows });
});

// POST /api/import/ing-csv
router.post('/ing-csv', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const content = req.file.buffer.toString('utf-8');
  const rows = parseIngCsv(content);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Could not parse CSV. Check file format.' });
  }

  // Optionele selectie van rijen (als null → alle rijen)
  const selectedSet: Set<number> | null = req.body.selectedIndices
    ? new Set<number>(JSON.parse(req.body.selectedIndices) as number[])
    : null;

  const db = getDb();

  // Context ophalen voor AI analyse
  const categories = db.prepare('SELECT id, name FROM categories ORDER BY id').all() as { id: number; name: string }[];
  const organizations = db.prepare('SELECT id, name FROM organizations ORDER BY id').all() as { id: number; name: string }[];

  // Alleen geselecteerde rijen analyseren (met originele indices behouden)
  const rowsToAnalyze = rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => selectedSet === null || selectedSet.has(i));

  // Datum range bepalen voor Splitwise fetch
  const dates = rowsToAnalyze.map(({ row }) => row.date).sort();
  const earliestDate = dates[0] ?? new Date().toISOString().split('T')[0];

  // Splitwise expenses ophalen (best-effort)
  const splitwiseExpenses = await fetchSplitwiseExpenses(earliestDate);

  // AI analyse uitvoeren (best-effort)
  const analysisInputs: TransactionAnalysisInput[] = rowsToAnalyze.map(({ row, i }) => ({
    index: i,
    date: row.date,
    amount: row.amount,
    counterparty_iban: row.counterparty_account ?? '',
    counterparty_name: row.raw['Naam van de rekening'] ?? row.raw['Naam'] ?? '',
    omschrijving: row.raw['Omschrijving'] ?? '',
    detail: row.raw['Detail van de omzet'] ?? '',
    bericht: row.raw['Bericht'] ?? row.raw['Mededeling'] ?? '',
  }));

  const aiResults = await analyzeTransactions(analysisInputs, { categories, organizations, splitwiseExpenses });
  const aiAnalyzed = aiResults !== null;

  // Classification rules ophalen voor fallback
  const rules = db.prepare('SELECT * FROM classification_rules ORDER BY id').all() as Array<{
    id: number; pattern: string; type: 'personal' | 'reimbursable' | 'income' | 'savings';
    organization_id: number | null; category_id: number | null;
  }>;

  let imported = 0;
  let skipped = 0;
  const importedRows = [];

  // Map van batch-index → opgeslagen transactie (voor within-batch advance linking)
  const savedByIndex = new Map<number, { id: number; date: string; amount: number; counterparty_account: string | null }>();

  // Eerste pas: alle transacties opslaan
  for (let i = 0; i < rows.length; i++) {
    // Sla rijen over die niet geselecteerd zijn
    if (selectedSet !== null && !selectedSet.has(i)) continue;

    const row = rows[i];

    // Duplicaat check
    const existing = db.prepare('SELECT id FROM transactions WHERE ing_transaction_id = ?').get(row.ing_transaction_id);
    if (existing) {
      skipped++;
      continue;
    }

    // Classificatie bepalen
    let type: 'personal' | 'reimbursable' | 'income' | 'savings';
    let organization_id: number | null = null;
    let category_id: number | null = null;
    let splitwise_expense_id: string | null = null;
    let splitwise_owed_share: number | null = null;
    let notes: string | null = null;
    let description = row.description;
    let category_confirmed = 1;

    if (aiResults) {
      const ai = aiResults.find(r => r.index === i);
      if (ai) {
        description = ai.readable_name || row.description;
        type = ai.type;
        organization_id = ai.organization_id;
        category_id = ai.category_id;
        if (category_id !== null) category_confirmed = 0;
        splitwise_expense_id = ai.splitwise_expense_id != null
          ? String(parseInt(String(ai.splitwise_expense_id), 10))
          : null;
        notes = ai.notes;
        if (splitwise_expense_id) {
          const swExpense = splitwiseExpenses.find(e => String(e.id) === splitwise_expense_id);
          if (swExpense) splitwise_owed_share = swExpense.my_owed_share;
        }
      } else {
        type = row.amount > 0 ? 'income' : 'personal';
      }
    } else {
      // Fallback: classification rules
      type = row.amount > 0 ? 'income' : 'personal';
      for (const rule of rules) {
        if (row.description.toLowerCase().includes(rule.pattern.toLowerCase())) {
          type = rule.type;
          organization_id = rule.organization_id;
          category_id = rule.category_id;
          break;
        }
      }
    }

    const tx = createTransaction(db, {
      description,
      amount: row.amount,
      date: row.date,
      type,
      category_id,
      organization_id,
      ing_transaction_id: row.ing_transaction_id,
      splitwise_expense_id,
      splitwise_owed_share,
      notes,
      counterparty_account: row.counterparty_account,
      counterparty_name: row.counterparty_name,
      original_description: row.description,
      category_confirmed,
    });

    savedByIndex.set(i, { id: tx.id, date: tx.date, amount: tx.amount, counterparty_account: row.counterparty_account });
    importedRows.push(tx);
    imported++;
  }

  // Tweede pas: within-batch voorschot-linking (via AI advance_repaid_by_index)
  if (aiResults) {
    for (const ai of aiResults) {
      if (ai.advance_repaid_by_index === null) continue;

      const advanceTx = savedByIndex.get(ai.index);
      const repaymentTx = savedByIndex.get(ai.advance_repaid_by_index);
      if (!advanceTx || !repaymentTx) continue;

      db.prepare(`
        UPDATE transactions SET
          reimbursed_at = ?,
          reimbursed_note = 'Automatisch gedetecteerd bij import (zelfde batch)'
        WHERE id = ? AND reimbursed_at IS NULL
      `).run(repaymentTx.date, advanceTx.id);

      // Markeer de terugbetalingstransactie zodat frontend deze kan herkennen
      db.prepare(`
        UPDATE transactions SET reimbursed_note = 'Terugbetaling'
        WHERE id = ? AND reimbursed_note IS NULL
      `).run(repaymentTx.id);
    }
  }

  // Derde pas: DB-niveau voorschot-matching voor inkomende transacties
  for (const [, tx] of savedByIndex) {
    if (tx.amount <= 0 || !tx.counterparty_account) continue;

    // Zoek een onafgehandeld voorschot met zelfde tegenpartij en vergelijkbaar bedrag
    const match = db.prepare(`
      SELECT id, amount FROM transactions
      WHERE type = 'reimbursable'
        AND reimbursed_at IS NULL
        AND counterparty_account = ?
        AND ABS(amount + ?) < ABS(?) * 0.1
        AND id != ?
      ORDER BY date DESC
      LIMIT 1
    `).get(tx.counterparty_account, tx.amount, tx.amount, tx.id) as { id: number; amount: number } | undefined;

    if (match) {
      db.prepare(`
        UPDATE transactions SET
          reimbursed_at = ?,
          reimbursed_note = 'Automatisch gedetecteerd bij import'
        WHERE id = ?
      `).run(tx.date, match.id);

      // Markeer de terugbetalingstransactie
      db.prepare(`
        UPDATE transactions SET reimbursed_note = 'Terugbetaling'
        WHERE id = ? AND reimbursed_note IS NULL
      `).run(tx.id);
    }
  }

  res.json({
    imported,
    skipped,
    total: selectedSet ? selectedSet.size : rows.length,
    ai_analyzed: aiAnalyzed,
    transactions: importedRows,
  });
});

export default router;
