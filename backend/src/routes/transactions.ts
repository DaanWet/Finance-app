import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import {
  getTransactions, getTransactionById, getTransactionsByIds,
  createTransaction, updateTransaction, deleteTransaction,
  confirmAllTransactions, confirmTransactions, deleteTransactions
} from '../queries/transactions';
import { initStreamResponse, sendProgress, sendResult, sendStreamError } from './import';
import { cleanupLinksForDeletedTransaction, cleanupLinksForTypeChange } from '../queries/reimbursementLinks';
import { TRANSACTION_TYPES } from '../helpers/constants';
import { reanalyzeBulk, reanalyzeSingle } from '../services/reanalyzeService';
import { errorMessage } from '../helpers/errors';

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
    source: req.query['source'] as string | undefined,
  };
  res.json(getTransactions(db, filters));
});

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { description, amount, date, type, category_id, organization_id,
          notes, splitwise_expense_id } = req.body;

  if (!description || amount === undefined || !date || !type) {
    return res.status(400).json({ error: 'description, amount, date, type are required' });
  }
  if (!TRANSACTION_TYPES.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${TRANSACTION_TYPES.join(', ')}` });
  }

  const tx = createTransaction(db, {
    description, amount: Number(amount), date, type,
    category_id: category_id ?? null,
    organization_id: organization_id ?? null,
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
  for (const id of ids) cleanupLinksForDeletedTransaction(db, Number(id));
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

  initStreamResponse(res);

  try {
    const result = await reanalyzeBulk(db, txs, (msg, progress, tokens) => {
      sendProgress(res, msg, progress, tokens);
    });

    if (!result) {
      return sendStreamError(res, 'AI analyse mislukt');
    }

    sendResult(res, result);
  } catch (err) {
    sendStreamError(res, 'Heranalyse mislukt: ' + errorMessage(err));
  }
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

  const result = await reanalyzeSingle(db, tx);
  if (!result) {
    return res.status(500).json({ error: 'AI analyse mislukt' });
  }

  res.json(getTransactionById(db, id));
});

router.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params['id']);
  if (req.body.type) {
    const existing = getTransactionById(db, id);
    if (existing && existing.type !== req.body.type) {
      cleanupLinksForTypeChange(db, id, existing.type, req.body.type);
    }
  }
  const tx = updateTransaction(db, id, req.body);
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json(tx);
});

router.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params['id']);
  cleanupLinksForDeletedTransaction(db, id);
  const deleted = deleteTransaction(db, id);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

export default router;
