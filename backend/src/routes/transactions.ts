import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import {
  getTransactions, getTransactionById, getTransactionsByIds,
  createTransaction, updateTransaction, deleteTransaction,
  confirmAllTransactions, confirmTransactions, deleteTransactions
} from '../queries/transactions';
import { analyzeTransactions, TransactionAnalysisInput } from '../services/aiAnalysis';
import { fetchSplitwiseExpenses } from './import';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const filters = {
    type: req.query['type'] as string | undefined,
    category_id: req.query['category_id'] ? Number(req.query['category_id']) : undefined,
    organization_id: req.query['organization_id'] ? Number(req.query['organization_id']) : undefined,
    date_from: req.query['date_from'] as string | undefined,
    date_to: req.query['date_to'] as string | undefined,
    search: req.query['search'] as string | undefined,
  };
  res.json(getTransactions(db, filters));
});

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { description, amount, date, type, category_id, organization_id,
          payment_method, notes, splitwise_expense_id } = req.body;

  if (!description || amount === undefined || !date || !type) {
    return res.status(400).json({ error: 'description, amount, date, type are required' });
  }
  const validTypes = ['personal', 'reimbursable', 'income', 'savings'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  const tx = createTransaction(db, {
    description, amount: Number(amount), date, type,
    category_id: category_id ?? null,
    organization_id: organization_id ?? null,
    payment_method: payment_method ?? null,
    notes: notes ?? null,
    splitwise_expense_id: splitwise_expense_id ?? null,
  });
  res.status(201).json(tx);
});

router.post('/confirm-all', (req: Request, res: Response) => {
  const db = getDb();
  const count = confirmAllTransactions(db);
  res.json({ confirmed: count });
});

router.post('/bulk-confirm', (req: Request, res: Response) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  const confirmed = confirmTransactions(db, ids.map(Number));
  res.json({ confirmed });
});

router.post('/bulk-delete', (req: Request, res: Response) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  const deleted = deleteTransactions(db, ids.map(Number));
  res.json({ deleted });
});

router.post('/bulk-reanalyze', async (req: Request, res: Response) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const txs = getTransactionsByIds(db, ids.map(Number));
  if (txs.length === 0) {
    return res.status(404).json({ error: 'No transactions found' });
  }

  const categories = db.prepare('SELECT id, name FROM categories ORDER BY id').all() as { id: number; name: string }[];
  const organizations = db.prepare('SELECT id, name FROM organizations ORDER BY id').all() as { id: number; name: string }[];

  const earliestDate = txs.reduce((min, tx) => tx.date < min ? tx.date : min, txs[0].date);
  const splitwiseExpenses = await fetchSplitwiseExpenses(earliestDate);

  const inputs: TransactionAnalysisInput[] = txs.map((tx, idx) => ({
    index: idx,
    date: tx.date,
    amount: tx.amount,
    counterparty_iban: tx.counterparty_account ?? '',
    counterparty_name: '',
    omschrijving: tx.description,
    detail: '',
    bericht: '',
  }));

  const aiResults = await analyzeTransactions(inputs, { categories, organizations, splitwiseExpenses });
  if (!aiResults || aiResults.length === 0) {
    return res.status(500).json({ error: 'AI analyse mislukt' });
  }

  for (const ai of aiResults) {
    const tx = txs[ai.index];
    if (!tx) continue;

    let splitwise_owed_share: number | null = null;
    if (ai.splitwise_expense_id) {
      const swExpense = splitwiseExpenses.find(e => String(e.id) === ai.splitwise_expense_id);
      if (swExpense) splitwise_owed_share = swExpense.my_owed_share;
    }

    updateTransaction(db, tx.id, {
      description: ai.readable_name || tx.description,
      type: ai.type,
      category_id: ai.category_id,
      organization_id: ai.organization_id,
      splitwise_expense_id: ai.splitwise_expense_id,
      splitwise_owed_share,
      notes: ai.notes,
      category_confirmed: 0,
    });

    if (tx.amount > 0 && tx.counterparty_account) {
      const match = db.prepare(`
        SELECT id, amount FROM transactions
        WHERE type = 'reimbursable'
          AND reimbursed_at IS NULL
          AND counterparty_account = ?
          AND ABS(amount + ?) < ABS(?) * 0.1
          AND id != ?
        ORDER BY date DESC LIMIT 1
      `).get(tx.counterparty_account, tx.amount, tx.amount, tx.id) as { id: number; amount: number } | undefined;

      if (match) {
        db.prepare(`
          UPDATE transactions SET reimbursed_at = ?, reimbursed_note = 'Automatisch gedetecteerd bij heranalyse'
          WHERE id = ?
        `).run(tx.date, match.id);

        db.prepare(`
          UPDATE transactions SET reimbursed_note = 'Terugbetaling'
          WHERE id = ? AND reimbursed_note IS NULL
        `).run(tx.id);
      }
    }
  }

  // Within-batch advance linking (via AI advance_repaid_by_index)
  for (const ai of aiResults) {
    if (ai.advance_repaid_by_index === null) continue;
    const advanceTx = txs[ai.index];
    const repaymentTx = txs[ai.advance_repaid_by_index];
    if (!advanceTx || !repaymentTx) continue;

    db.prepare(`
      UPDATE transactions SET
        reimbursed_at = ?,
        reimbursed_note = 'Automatisch gedetecteerd bij heranalyse (zelfde batch)'
      WHERE id = ? AND reimbursed_at IS NULL
    `).run(repaymentTx.date, advanceTx.id);

    db.prepare(`
      UPDATE transactions SET reimbursed_note = 'Terugbetaling'
      WHERE id = ? AND reimbursed_note IS NULL
    `).run(repaymentTx.id);
  }

  const updated = getTransactionsByIds(db, txs.map(t => t.id));
  res.json({ reanalyzed: updated.length, transactions: updated });
});

router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const tx = getTransactionById(db, Number(req.params['id']));
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json(tx);
});

router.post('/:id/reanalyze', async (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params['id']);
  const tx = getTransactionById(db, id);
  if (!tx) return res.status(404).json({ error: 'Not found' });

  const categories = db.prepare('SELECT id, name FROM categories ORDER BY id').all() as { id: number; name: string }[];
  const organizations = db.prepare('SELECT id, name FROM organizations ORDER BY id').all() as { id: number; name: string }[];
  const splitwiseExpenses = await fetchSplitwiseExpenses(tx.date);

  const input: TransactionAnalysisInput = {
    index: 0,
    date: tx.date,
    amount: tx.amount,
    counterparty_iban: tx.counterparty_account ?? '',
    counterparty_name: '',
    omschrijving: tx.description,
    detail: '',
    bericht: '',
  };

  const aiResults = await analyzeTransactions([input], { categories, organizations, splitwiseExpenses });
  if (!aiResults || aiResults.length === 0) {
    return res.status(500).json({ error: 'AI analyse mislukt' });
  }

  const ai = aiResults[0];
  let splitwise_owed_share: number | null = null;
  if (ai.splitwise_expense_id) {
    const swExpense = splitwiseExpenses.find(e => String(e.id) === ai.splitwise_expense_id);
    if (swExpense) splitwise_owed_share = swExpense.my_owed_share;
  }
  updateTransaction(db, id, {
    description: ai.readable_name || tx.description,
    type: ai.type,
    category_id: ai.category_id,
    organization_id: ai.organization_id,
    splitwise_expense_id: ai.splitwise_expense_id,
    splitwise_owed_share,
    notes: ai.notes,
    category_confirmed: 0,
  });

  // Pass 3: DB-niveau voorschot-matching als positief bedrag
  if (tx.amount > 0 && tx.counterparty_account) {
    const match = db.prepare(`
      SELECT id, amount FROM transactions
      WHERE type = 'reimbursable'
        AND reimbursed_at IS NULL
        AND counterparty_account = ?
        AND ABS(amount + ?) < ABS(?) * 0.1
        AND id != ?
      ORDER BY date DESC
      LIMIT 1
    `).get(tx.counterparty_account, tx.amount, tx.amount, id) as { id: number; amount: number } | undefined;

    if (match) {
      db.prepare(`
        UPDATE transactions SET
          reimbursed_at = ?,
          reimbursed_note = 'Automatisch gedetecteerd bij heranalyse'
        WHERE id = ?
      `).run(tx.date, match.id);

      db.prepare(`
        UPDATE transactions SET reimbursed_note = 'Terugbetaling'
        WHERE id = ? AND reimbursed_note IS NULL
      `).run(id);
    }
  }

  // Omgekeerde matching: negatieve transactie zoekt positieve terugbetaling in DB
  if (tx.amount < 0 && tx.counterparty_account) {
    const match = db.prepare(`
      SELECT id, date FROM transactions
      WHERE amount > 0
        AND counterparty_account = ?
        AND ABS(amount + ?) < ABS(?) * 0.1
        AND id != ?
      ORDER BY date DESC
      LIMIT 1
    `).get(tx.counterparty_account, tx.amount, tx.amount, id) as { id: number; date: string } | undefined;

    if (match) {
      db.prepare(`
        UPDATE transactions SET
          reimbursed_at = ?,
          reimbursed_note = 'Automatisch gedetecteerd bij heranalyse'
        WHERE id = ? AND reimbursed_at IS NULL
      `).run(match.date, id);

      db.prepare(`
        UPDATE transactions SET reimbursed_note = 'Terugbetaling'
        WHERE id = ? AND reimbursed_note IS NULL
      `).run(match.id);
    }
  }

  res.json(getTransactionById(db, id));
});

router.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params['id']);
  const tx = updateTransaction(db, id, req.body);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json(tx);
});

router.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const deleted = deleteTransaction(db, Number(req.params['id']));
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

export default router;
