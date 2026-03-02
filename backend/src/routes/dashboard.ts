import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import { getDashboardSummary } from '../queries/dashboard';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const now = new Date();
  const defaultStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

  const startDate = (req.query['start'] as string) ?? defaultStart;
  const endDate = (req.query['end'] as string) ?? defaultEnd;

  res.json(getDashboardSummary(getDb(), startDate, endDate));
});

export default router;
