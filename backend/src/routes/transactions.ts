import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import {
  getTransactions, getTransactionById,
  createTransaction, updateTransaction, deleteTransaction
} from '../queries/transactions';

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

router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const tx = getTransactionById(db, Number(req.params['id']));
  if (!tx) return res.status(404).json({ error: 'Not found' });
  res.json(tx);
});

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { description, amount, date, type, category_id, organization_id,
          payment_method, notes, splitwise_expense_id } = req.body;

  if (!description || amount === undefined || !date || !type) {
    return res.status(400).json({ error: 'description, amount, date, type are required' });
  }
  const validTypes = ['personal', 'reimbursable', 'income'];
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
