import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import {
  listSeries, getSummary, getSeriesMemberTransactions, updateSeries,
} from '../queries/recurring';
import { scanRecurringSeries } from '../services/recurringScan';
import { errorMessage } from '../helpers/errors';

const router = Router();

// GET /api/recurring — lijst + summary
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  res.json({ series: listSeries(db), summary: getSummary(db) });
});

// GET /api/recurring/summary — enkel summary (dashboard-kaart)
router.get('/summary', (_req: Request, res: Response) => {
  res.json(getSummary(getDb()));
});

// POST /api/recurring/scan — detectie draaien
router.post('/scan', async (_req: Request, res: Response) => {
  try {
    res.json(await scanRecurringSeries(getDb()));
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// GET /api/recurring/:id/transactions — transacties van een reeks
router.get('/:id/transactions', (req: Request, res: Response) => {
  res.json(getSeriesMemberTransactions(getDb(), Number(req.params.id)));
});

// PUT /api/recurring/:id — status en/of custom_name aanpassen
router.put('/:id', (req: Request, res: Response) => {
  const { status, custom_name } = req.body as { status?: string; custom_name?: string | null };
  const updated = updateSeries(getDb(), Number(req.params.id), {
    status: status as 'suggested' | 'confirmed' | 'ignored' | undefined,
    custom_name,
  });
  if (!updated) return res.status(404).json({ error: 'Reeks niet gevonden of ongeldige status' });
  return res.json(updated);
});

export default router;
