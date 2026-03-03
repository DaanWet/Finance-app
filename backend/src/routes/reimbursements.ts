import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { getOutstandingReimbursements, getReceivedReimbursements, markReimbursed } from '../queries/reimbursements';

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

export default router;
