import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(getDb().prepare(`
    SELECT r.*, o.name AS organization_name, c.name AS category_name
    FROM classification_rules r
    LEFT JOIN organizations o ON r.organization_id = o.id
    LEFT JOIN categories c ON r.category_id = c.id
    ORDER BY r.id
  `).all());
});

router.post('/', (req: Request, res: Response) => {
  const { pattern, type, organization_id, category_id } = req.body;
  if (!pattern || !type) return res.status(400).json({ error: 'pattern and type are required' });
  const validTypes = ['personal', 'reimbursable', 'income'];
  if (!validTypes.includes(type)) return res.status(400).json({ error: 'invalid type' });

  const result = getDb().prepare(
    'INSERT INTO classification_rules (pattern, type, organization_id, category_id) VALUES (?, ?, ?, ?)'
  ).run(pattern, type, organization_id ?? null, category_id ?? null);

  res.status(201).json(getDb().prepare('SELECT * FROM classification_rules WHERE id = ?').get(result.lastInsertRowid));
});

router.delete('/:id', (req: Request, res: Response) => {
  const result = getDb().prepare('DELETE FROM classification_rules WHERE id = ?').run(Number(req.params['id']));
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.status(204).send();
});

export default router;
