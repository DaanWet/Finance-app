import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(getDb().prepare('SELECT * FROM organizations ORDER BY name').all());
});

router.post('/', (req: Request, res: Response) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const result = getDb().prepare('INSERT INTO organizations (name, color) VALUES (?, ?)').run(name, color ?? '#6366f1');
  res.status(201).json(getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/:id', (req: Request, res: Response) => {
  const { name, color } = req.body;
  const result = getDb().prepare('UPDATE organizations SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?').run(name ?? null, color ?? null, Number(req.params['id']));
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json(getDb().prepare('SELECT * FROM organizations WHERE id = ?').get(Number(req.params['id'])));
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = getDb().prepare('DELETE FROM organizations WHERE id = ?').run(Number(req.params['id']));
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

export default router;
