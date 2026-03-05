import { Router, Request, Response } from 'express';
import { getDb } from '../db';

export interface CrudConfig {
  table: string;
  requiredFields: string[];
  defaultValues?: Record<string, unknown>;
  updateFields: string[];
}

export function createCrudRouter(config: CrudConfig): Router {
  const router = Router();
  const { table, requiredFields, defaultValues = {}, updateFields } = config;

  router.get('/', (_req: Request, res: Response) => {
    res.json(getDb().prepare(`SELECT * FROM ${table} ORDER BY name`).all());
  });

  router.post('/', (req: Request, res: Response) => {
    for (const field of requiredFields) {
      if (!req.body[field]) return res.status(400).json({ error: `${field} is required` });
    }

    const allFields = [...requiredFields, ...Object.keys(defaultValues)];
    const values = allFields.map(f => req.body[f] ?? defaultValues[f] ?? null);
    const placeholders = allFields.map(() => '?').join(', ');
    const columns = allFields.join(', ');

    const result = getDb().prepare(`INSERT INTO ${table} (${columns}) VALUES (${placeholders})`).run(...values);
    res.status(201).json(getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(result.lastInsertRowid));
  });

  router.put('/:id', (req: Request, res: Response) => {
    const setClause = updateFields.map(f => `${f} = COALESCE(?, ${f})`).join(', ');
    const values = updateFields.map(f => req.body[f] ?? null);

    const result = getDb().prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...values, Number(req.params['id']));
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.json(getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(req.params['id'])));
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const result = getDb().prepare(`DELETE FROM ${table} WHERE id = ?`).run(Number(req.params['id']));
    if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  });

  return router;
}
