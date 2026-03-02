import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { getDb } from '../db';
import { createTransaction } from '../queries/transactions';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

interface ParsedIngRow {
  date: string;
  description: string;
  amount: number;
  ing_transaction_id: string;
  raw: Record<string, string>;
}

function parseIngCsv(content: string): ParsedIngRow[] {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  // Detecteer separator: ING België gebruikt puntkomma
  const header = lines[0].replace(/\r/, '');
  const sep = header.includes(';') ? ';' : ',';
  const headers = header.split(sep).map(h => h.trim().replace(/^"|"$/g, ''));

  const rows: ParsedIngRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r/, '').trim();
    if (!line) continue;

    const values = splitCsvLine(line, sep);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = (values[idx] ?? '').trim().replace(/^"|"$/g, ''); });

    // ING België kolommen: Datum;Naam;Rekening;Tegenrekening;Code;Afschrijving;Bijschrijving;Mededeling
    const dateRaw = row['Datum'] ?? row['Date'] ?? '';
    const nameRaw = row['Naam'] ?? row['Name'] ?? '';
    const debitRaw = row['Afschrijving'] ?? row['Debit'] ?? '0';
    const creditRaw = row['Bijschrijving'] ?? row['Credit'] ?? '0';
    const memoRaw = row['Mededeling'] ?? row['Communication'] ?? '';

    if (!dateRaw) continue;

    // Datum: DD/MM/YYYY → YYYY-MM-DD
    const dateParts = dateRaw.split('/');
    let isoDate = dateRaw;
    if (dateParts.length === 3) {
      isoDate = `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}`;
    }

    // Bedrag: komma als decimaalteken in BE
    const debit = parseFloat(debitRaw.replace(',', '.') || '0');
    const credit = parseFloat(creditRaw.replace(',', '.') || '0');
    const amount = credit > 0 ? credit : -debit;

    const description = memoRaw || nameRaw || 'Onbekend';

    // Stabiel ID: hash van datum + bedrag + beschrijving
    const hashInput = `${isoDate}|${amount}|${description}`;
    const ing_transaction_id = crypto.createHash('sha256').update(hashInput).digest('hex').substring(0, 16);

    rows.push({ date: isoDate, description, amount, ing_transaction_id, raw: row });
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

// POST /api/import/ing-csv
router.post('/ing-csv', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const content = req.file.buffer.toString('utf-8');
  const rows = parseIngCsv(content);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Could not parse CSV. Check file format.' });
  }

  const db = getDb();
  let imported = 0;
  let skipped = 0;
  const importedRows = [];

  for (const row of rows) {
    // Check voor duplicaat
    const existing = db.prepare('SELECT id FROM transactions WHERE ing_transaction_id = ?').get(row.ing_transaction_id);
    if (existing) {
      skipped++;
      continue;
    }

    // Classificeer automatisch op basis van rules
    let type: 'personal' | 'reimbursable' | 'income' = row.amount > 0 ? 'income' : 'personal';
    let organization_id: number | null = null;
    let category_id: number | null = null;

    const rules = db.prepare('SELECT * FROM classification_rules ORDER BY id').all() as Array<{
      id: number; pattern: string; type: 'personal' | 'reimbursable' | 'income';
      organization_id: number | null; category_id: number | null;
    }>;

    for (const rule of rules) {
      if (row.description.toLowerCase().includes(rule.pattern.toLowerCase())) {
        type = rule.type;
        organization_id = rule.organization_id;
        category_id = rule.category_id;
        break;
      }
    }

    const tx = createTransaction(db, {
      description: row.description,
      amount: row.amount,
      date: row.date,
      type,
      category_id,
      organization_id,
      ing_transaction_id: row.ing_transaction_id,
    });

    importedRows.push(tx);
    imported++;
  }

  res.json({
    imported,
    skipped,
    total: rows.length,
    transactions: importedRows,
  });
});

export default router;
