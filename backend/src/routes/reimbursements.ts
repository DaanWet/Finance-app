import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { errorMessage } from '../helpers/errors';
import { getOutstandingReimbursements, getReceivedReimbursements, markReimbursed } from '../queries/reimbursements';
import {
  linkIncomeToExpenses,
  unlinkExpense,
  getLinksForTransaction,
  getIncomeCandidates,
  getExpenseCandidates,
} from '../queries/reimbursementLinks';

const router = Router();

router.get('/outstanding', (_req: Request, res: Response) => {
  res.json(getOutstandingReimbursements(getDb()));
});

router.get('/received', (req: Request, res: Response) => {
  const months = req.query['months'] ? Number(req.query['months']) : undefined;
  res.json(getReceivedReimbursements(getDb(), months));
});

router.post('/:id/mark-received', (req: Request, res: Response) => {
  const id = Number(req.params['id']);
  const { note } = req.body;
  const ok = markReimbursed(getDb(), id, note);
  if (!ok) return res.status(404).json({ error: 'Transaction not found or already reimbursed' });
  res.json({ success: true });
});

// Link income to multiple expenses
router.post('/link', (req: Request, res: Response) => {
  const { income_transaction_id, expenses } = req.body;
  if (!income_transaction_id || !Array.isArray(expenses) || expenses.length === 0) {
    return res.status(400).json({ error: 'income_transaction_id and expenses[] required' });
  }
  try {
    const links = linkIncomeToExpenses(getDb(), income_transaction_id, expenses);
    res.json({ links });
  } catch (err: unknown) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// Unlink one expense from an income
router.delete('/link/:incomeId/:expenseId', (req: Request, res: Response) => {
  const incomeId = Number(req.params['incomeId']);
  const expenseId = Number(req.params['expenseId']);
  const ok = unlinkExpense(getDb(), incomeId, expenseId);
  if (!ok) return res.status(404).json({ error: 'Link not found' });
  res.json({ success: true });
});

// Get links for a transaction (works for both income and expense)
router.get('/links/:transactionId', (req: Request, res: Response) => {
  const transactionId = Number(req.params['transactionId']);
  res.json(getLinksForTransaction(getDb(), transactionId));
});

// Get income candidates for linking
router.get('/income-candidates', (req: Request, res: Response) => {
  const orgId = req.query['organization_id'] ? Number(req.query['organization_id']) : undefined;
  res.json(getIncomeCandidates(getDb(), orgId));
});

// Get expense candidates for linking
router.get('/expense-candidates', (req: Request, res: Response) => {
  const orgId = req.query['organization_id'] ? Number(req.query['organization_id']) : undefined;
  res.json(getExpenseCandidates(getDb(), orgId));
});

export default router;
