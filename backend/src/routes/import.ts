import { Router, Request, Response } from 'express';
import multer from 'multer';
import { getDb } from '../db';
import { parseIngCsv } from '../services/csvParser';
import { parsePluxeeCsv } from '../services/pluxeeCsvParser';
import { executeImport, executeClassifyPreview } from '../services/importService';
import { errorMessage } from '../helpers/errors';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// --- NDJSON streaming helpers (used by import + transactions routes) ---
export function initStreamResponse(res: Response): void {
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function sendProgress(res: Response, message: string, progress: number, tokens?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; total_cost_usd: number }): void {
  const data: Record<string, unknown> = { message, progress };
  if (tokens) data.tokens = tokens;
  res.write(JSON.stringify(data) + '\n');
}

export function sendResult<T>(res: Response, result: T): void {
  res.write(JSON.stringify({ message: 'Klaar', progress: 100, result }) + '\n');
  res.end();
}

export function sendStreamError(res: Response, message: string): void {
  res.write(JSON.stringify({ message, error: true }) + '\n');
  res.end();
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

  const selectedSet: Set<number> | null = req.body.selectedIndices
    ? new Set<number>(JSON.parse(req.body.selectedIndices) as number[])
    : null;

  const preClassifications = req.body.classifications
    ? JSON.parse(req.body.classifications)
    : undefined;

  initStreamResponse(res);

  try {
    const db = getDb();
    const result = await executeImport(db, rows, selectedSet, (msg, progress, tokens) => {
      sendProgress(res, msg, progress, tokens);
    }, preClassifications);
    sendResult(res, result);
  } catch (err) {
    sendStreamError(res, 'Import mislukt: ' + errorMessage(err));
  }
});

// POST /api/import/classify-preview — AI classification without saving
router.post('/classify-preview', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const content = req.file.buffer.toString('utf-8');
  const importType = req.body.importType as 'ing' | 'pluxee' || 'ing';
  const rows = importType === 'pluxee' ? parsePluxeeCsv(content) : parseIngCsv(content);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Could not parse CSV. Check file format.' });
  }

  const selectedSet: Set<number> | null = req.body.selectedIndices
    ? new Set<number>(JSON.parse(req.body.selectedIndices) as number[])
    : null;

  initStreamResponse(res);

  try {
    const db = getDb();
    const result = await executeClassifyPreview(db, rows, selectedSet, (msg, progress, tokens) => {
      sendProgress(res, msg, progress, tokens);
    });
    sendResult(res, result);
  } catch (err) {
    sendStreamError(res, 'Classificatie mislukt: ' + errorMessage(err));
  }
});

// POST /api/import/pluxee-csv/preview
router.post('/pluxee-csv/preview', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const content = req.file.buffer.toString('utf-8');
  const rows = parsePluxeeCsv(content);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Geen uitgaven gevonden in CSV. Controleer het bestandsformaat.' });
  }

  const db = getDb();

  const previewRows = rows.map((row, index) => {
    const existing = db.prepare('SELECT id FROM transactions WHERE ing_transaction_id = ?').get(row.ing_transaction_id);
    return {
      index,
      date: row.date,
      description: row.counterparty_name || row.description,
      amount: row.amount,
      counterparty_account: row.counterparty_account,
      ing_transaction_id: row.ing_transaction_id,
      duplicate: !!existing,
    };
  });

  return res.json({ rows: previewRows });
});

// POST /api/import/pluxee-csv
router.post('/pluxee-csv', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const content = req.file.buffer.toString('utf-8');
  const rows = parsePluxeeCsv(content);

  if (rows.length === 0) {
    return res.status(400).json({ error: 'Geen uitgaven gevonden in CSV. Controleer het bestandsformaat.' });
  }

  const selectedSet: Set<number> | null = req.body.selectedIndices
    ? new Set<number>(JSON.parse(req.body.selectedIndices) as number[])
    : null;

  const preClassifications = req.body.classifications
    ? JSON.parse(req.body.classifications)
    : undefined;

  initStreamResponse(res);

  try {
    const db = getDb();
    const result = await executeImport(db, rows, selectedSet, (msg, progress, tokens) => {
      sendProgress(res, msg, progress, tokens);
    }, preClassifications);
    sendResult(res, result);
  } catch (err) {
    sendStreamError(res, 'Import mislukt: ' + errorMessage(err));
  }
});

export default router;
