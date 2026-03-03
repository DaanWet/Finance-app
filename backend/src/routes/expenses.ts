import { Router, Request, Response } from 'express';
import multer from 'multer';
import { getDb } from '../db';
import { getAuthUrl, exchangeCode, isGmailConnected, fetchNmbsTickets } from '../services/gmailService';
import { generateExpenseExcel, classifyExpense, TransportExpense, OtherExpense } from '../services/excelExport';
import { combineReceiptsPdf, ReceiptData } from '../services/pdfExport';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function upsertSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);
}

function getSetting(key: string): string | undefined {
  return (getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
}

/** Parse YYYY-MM from query param, default to current month */
function parseMonth(raw: string | undefined): string {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) return raw;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ─── GET /api/expenses ────────────────────────────────────────────────────────
// Returns all work-expense transactions: open (unreimbursed) + reimbursed.

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const workOrgId = getSetting('work_organization_id');

  if (!workOrgId) {
    return res.json({ transactions: [], reimbursed: [], gmail_connected: isGmailConnected(), work_org_configured: false });
  }

  const baseQuery = `
    SELECT
      t.id, t.description, t.amount, t.date, t.type,
      t.category_id, t.organization_id, t.notes,
      t.counterparty_account, t.ing_transaction_id,
      t.reimbursed_at, t.reimbursed_note,
      c.name  AS category_name,  c.color AS category_color, c.icon AS category_icon,
      o.name  AS organization_name, o.color AS organization_color
    FROM transactions t
    LEFT JOIN categories    c ON c.id = t.category_id
    LEFT JOIN organizations o ON o.id = t.organization_id
    WHERE t.type = 'reimbursable'
      AND t.organization_id = ?`;

  const openTxs = db.prepare(`${baseQuery} AND t.reimbursed_at IS NULL ORDER BY t.date DESC, t.created_at DESC`)
    .all(Number(workOrgId)) as Record<string, unknown>[];

  const reimbursedTxs = db.prepare(`${baseQuery} AND t.reimbursed_at IS NOT NULL ORDER BY t.reimbursed_at DESC, t.date DESC`)
    .all(Number(workOrgId)) as Record<string, unknown>[];

  // Attach receipt metadata (no data blob) per transaction
  const allTxs = [...openTxs, ...reimbursedTxs];
  const receipts = allTxs.length > 0
    ? db.prepare(`
        SELECT id, transaction_id, filename, content_type, gmail_message_id, created_at
        FROM expense_receipts
        WHERE transaction_id IN (${allTxs.map(() => '?').join(',')})
      `).all(...allTxs.map(t => t['id'])) as Record<string, unknown>[]
    : [];

  const receiptsByTx = new Map<number, Record<string, unknown>[]>();
  for (const r of receipts) {
    const tid = r['transaction_id'] as number;
    if (!receiptsByTx.has(tid)) receiptsByTx.set(tid, []);
    receiptsByTx.get(tid)!.push(r);
  }

  const attachReceipts = (txs: Record<string, unknown>[]) =>
    txs.map(t => ({ ...t, receipts: receiptsByTx.get(t['id'] as number) ?? [] }));

  res.json({
    transactions: attachReceipts(openTxs),
    reimbursed: attachReceipts(reimbursedTxs),
    gmail_connected: isGmailConnected(),
    work_org_configured: true,
  });
});

// ─── POST /api/expenses/:id/receipt ───────────────────────────────────────────
// Upload a receipt (PDF / JPEG / PNG) for a transaction.

router.post('/:id/receipt', upload.single('file'), (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params['id']);

  if (!req.file) return res.status(400).json({ error: 'Geen bestand ontvangen' });

  const tx = db.prepare('SELECT id FROM transactions WHERE id=?').get(id);
  if (!tx) return res.status(404).json({ error: 'Transactie niet gevonden' });

  const result = db.prepare(`
    INSERT INTO expense_receipts (transaction_id, filename, content_type, data)
    VALUES (?, ?, ?, ?)
  `).run(id, req.file.originalname, req.file.mimetype, req.file.buffer);

  res.status(201).json({
    id: result.lastInsertRowid,
    transaction_id: id,
    filename: req.file.originalname,
    content_type: req.file.mimetype,
    created_at: new Date().toISOString(),
  });
});

// ─── GET /api/expenses/:id/receipt/:receiptId ─────────────────────────────────
// Serve the receipt file (PDF / image) for inline viewing.

router.get('/:id/receipt/:receiptId', (req: Request, res: Response) => {
  const db = getDb();
  const txId = Number(req.params['id']);
  const receiptId = Number(req.params['receiptId']);

  const row = db.prepare(
    'SELECT filename, content_type, data FROM expense_receipts WHERE id=? AND transaction_id=?'
  ).get(receiptId, txId) as { filename: string; content_type: string; data: Buffer } | undefined;

  if (!row) return res.status(404).json({ error: 'Bijlage niet gevonden' });

  res.setHeader('Content-Type', row.content_type);
  res.setHeader('Content-Disposition', `inline; filename="${row.filename}"`);
  res.send(row.data);
});

// ─── DELETE /api/expenses/:id/receipt/:receiptId ──────────────────────────────

router.delete('/:id/receipt/:receiptId', (req: Request, res: Response) => {
  const db = getDb();
  const txId = Number(req.params['id']);
  const receiptId = Number(req.params['receiptId']);

  const info = db.prepare('DELETE FROM expense_receipts WHERE id=? AND transaction_id=?').run(receiptId, txId);
  if (info.changes === 0) return res.status(404).json({ error: 'Bijlage niet gevonden' });
  res.json({ deleted: true });
});

// ─── GET /api/expenses/gmail/auth ─────────────────────────────────────────────
// Redirect browser to Google OAuth consent screen.

router.get('/gmail/auth', (_req: Request, res: Response) => {
  if (!process.env['GOOGLE_CLIENT_ID'] || !process.env['GOOGLE_CLIENT_SECRET']) {
    return res.status(503).json({ error: 'Google OAuth niet geconfigureerd. Voeg GOOGLE_CLIENT_ID en GOOGLE_CLIENT_SECRET toe aan .env' });
  }
  const url = getAuthUrl();
  res.redirect(url);
});

// ─── GET /api/expenses/gmail/callback ─────────────────────────────────────────
// OAuth2 callback. Exchanges code for tokens and redirects back to frontend.

router.get('/gmail/callback', async (req: Request, res: Response) => {
  const code = req.query['code'] as string | undefined;
  if (!code) return res.status(400).send('Geen authorisatiecode ontvangen.');

  try {
    await exchangeCode(code);
    res.redirect('http://localhost:4222/expenses?gmail=connected');
  } catch (err) {
    console.error('Gmail OAuth callback error:', err);
    res.redirect('http://localhost:4222/expenses?gmail=error');
  }
});

// ─── GET /api/expenses/gmail/status ───────────────────────────────────────────

router.get('/gmail/status', (_req: Request, res: Response) => {
  res.json({ connected: isGmailConnected() });
});

// ─── POST /api/expenses/gmail/fetch ───────────────────────────────────────────
// Fetch NMBS tickets from Gmail for a given month and auto-match to transactions.

router.post('/gmail/fetch', async (req: Request, res: Response) => {
  if (!isGmailConnected()) {
    return res.status(401).json({ error: 'Gmail niet verbonden. Koppel eerst uw Google-account.' });
  }

  const workOrgId = getSetting('work_organization_id');
  if (!workOrgId) {
    return res.status(400).json({ error: 'Werkorganisatie niet geconfigureerd. Ga naar Instellingen.' });
  }

  const month = parseMonth(req.body?.month as string | undefined);
  const [year, mon] = month.split('-');
  const dateFrom = `${year}-${mon}-01`;
  // Last day of month
  const lastDay = new Date(Number(year), Number(mon), 0).getDate();
  const dateTo = `${year}-${mon}-${String(lastDay).padStart(2, '0')}`;

  try {
    const tickets = await fetchNmbsTickets(dateFrom, dateTo);
    const db = getDb();
    const linked: number[] = [];
    const unmatched: string[] = [];

    for (const { ticket, pdfBuffer, messageId } of tickets) {
      // Find a matching transaction: exact date and amount within 5%
      const candidates = db.prepare(`
        SELECT id, amount, date FROM transactions
        WHERE date = ?
          AND amount < 0
          AND type = 'reimbursable'
          AND organization_id = ?
        ORDER BY ABS(amount - ?) ASC
        LIMIT 5
      `).all(ticket.date, Number(workOrgId), -ticket.amount) as { id: number; amount: number; date: string }[];

      let matchedId: number | null = null;
      for (const cand of candidates) {
        const diff = Math.abs(Math.abs(cand.amount) - ticket.amount) / ticket.amount;
        if (diff <= 0.05) { matchedId = cand.id; break; }
      }

      if (matchedId) {
        // Save receipt linked to transaction
        db.prepare(`
          INSERT INTO expense_receipts (transaction_id, filename, content_type, data, gmail_message_id)
          VALUES (?, ?, 'application/pdf', ?, ?)
        `).run(matchedId, `ticket_${ticket.date}_${ticket.from}-${ticket.to}.pdf`, pdfBuffer, messageId);

        // Store traject in transaction notes so Excel export can use it
        if (ticket.from && ticket.to) {
          const existing = db.prepare('SELECT notes FROM transactions WHERE id=?').get(matchedId) as { notes: string | null };
          const tripType = ticket.roundTrip ? 'heen en terug' : 'enkel';
          const trajNote = `Van: ${ticket.from} → Naar: ${ticket.to} (${tripType})`;
          if (!existing.notes?.includes('Van:')) {
            const newNotes = existing.notes ? `${existing.notes}\n${trajNote}` : trajNote;
            db.prepare("UPDATE transactions SET notes=?, updated_at=datetime('now') WHERE id=?").run(newNotes, matchedId);
          }
        }

        linked.push(matchedId);
      } else {
        // Save unmatched receipt linked to a placeholder: store with transaction_id=-1 is not possible
        // Instead: just return info so user can manually assign
        unmatched.push(`${ticket.date} ${ticket.from}→${ticket.to} €${ticket.amount.toFixed(2)}`);
      }
    }

    res.json({
      fetched: tickets.length,
      linked: linked.length,
      unmatched,
    });
  } catch (err: any) {
    console.error('Gmail fetch error:', err);
    const is403 = err?.status === 403 || err?.code === 403;
    const detail = is403
      ? 'Gmail API is niet ingeschakeld in uw Google Cloud project. Ga naar Google Cloud Console en schakel de Gmail API in.'
      : String(err);
    res.status(500).json({ error: 'Fout bij ophalen Gmail-tickets', detail });
  }
});

// ─── GET /api/expenses/export/excel ───────────────────────────────────────────

router.get('/export/excel', async (req: Request, res: Response) => {
  const db = getDb();
  const workOrgId = getSetting('work_organization_id');
  if (!workOrgId) {
    return res.status(400).json({ error: 'Werkorganisatie niet geconfigureerd. Ga naar Instellingen.' });
  }

  const month = parseMonth(req.query['month'] as string | undefined);
  const [year, mon] = month.split('-');
  const dateFrom = `${year}-${mon}-01`;
  const dateTo   = `${year}-${mon}-31`;

  const transactions = db.prepare(`
    SELECT t.id, t.description, t.amount, t.date, t.notes
    FROM transactions t
    WHERE t.type = 'reimbursable' AND t.organization_id = ? AND t.date BETWEEN ? AND ?
    ORDER BY t.date ASC
  `).all(Number(workOrgId), dateFrom, dateTo) as { id: number; description: string; amount: number; date: string; notes: string | null }[];

  if (transactions.length === 0) {
    return res.status(404).json({ error: 'Geen werkuitgaven gevonden voor deze maand.' });
  }

  // Classify each expense into the right template section
  const transportExpenses: TransportExpense[] = [];
  const otherExpenses: OtherExpense[] = [];

  for (const t of transactions) {
    const { type, traject } = classifyExpense(t.description, t.notes);
    const amount = Math.abs(t.amount);

    if (type === 'train') {
      transportExpenses.push({ date: t.date, traject, other: amount });
    } else if (type === 'parking') {
      transportExpenses.push({ date: t.date, traject: '', parking: amount });
    } else {
      otherExpenses.push({ description: t.description, amount });
    }
  }

  // Period label: "Maart 2026"
  const periodLabel = new Date(Number(year), Number(mon) - 1)
    .toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });

  try {
    const buffer = await generateExpenseExcel(transportExpenses, otherExpenses, periodLabel, Number(year));
    const filename = `onkostennota_${month}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('Excel export error:', err);
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ─── GET /api/expenses/export/pdf ─────────────────────────────────────────────

router.get('/export/pdf', async (req: Request, res: Response) => {
  const db = getDb();
  const workOrgId = getSetting('work_organization_id');
  if (!workOrgId) {
    return res.status(400).json({ error: 'Werkorganisatie niet geconfigureerd. Ga naar Instellingen.' });
  }

  const month = parseMonth(req.query['month'] as string | undefined);
  const [year, mon] = month.split('-');
  const dateFrom = `${year}-${mon}-01`;
  const dateTo   = `${year}-${mon}-31`;

  const receipts = db.prepare(`
    SELECT r.id, r.filename, r.content_type, r.data, t.date AS transaction_date, t.description AS transaction_description
    FROM expense_receipts r
    JOIN transactions t ON t.id = r.transaction_id
    WHERE t.type = 'reimbursable' AND t.organization_id = ? AND t.date BETWEEN ? AND ?
    ORDER BY t.date ASC, r.created_at ASC
  `).all(Number(workOrgId), dateFrom, dateTo) as { id: number; filename: string; content_type: string; data: Buffer; transaction_date: string; transaction_description: string }[];

  if (receipts.length === 0) {
    return res.status(404).json({ error: 'Geen bewijsstukken gevonden voor deze maand.' });
  }

  const receiptData: ReceiptData[] = receipts.map(r => ({
    data: r.data,
    content_type: r.content_type,
    filename: r.filename,
    transaction_date: r.transaction_date,
    transaction_description: r.transaction_description,
  }));

  try {
    const buffer = await combineReceiptsPdf(receiptData, month);
    const filename = `bewijsstukken_${month}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error('PDF export error:', err);
    res.status(500).json({ error: 'Fout bij genereren PDF-bestand' });
  }
});

export default router;
