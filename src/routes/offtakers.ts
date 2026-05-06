import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

const SELECT_WITH_ENTITY = `
  SELECT o.*,
    e.id AS entity__id, e.entities_name AS entity__entities_name
  FROM offtaker o
  LEFT JOIN entities e ON e.id = o.entities_id
`;

function inflate(row: any): any {
  if (!row) return row;
  const out: any = {};
  const entity: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('entity__')) entity[k.slice('entity__'.length)] = row[k];
    else out[k] = row[k];
  }
  out.entity = entity.id ? entity : null;
  return out;
}

router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = SELECT_WITH_ENTITY;
  const args: any[] = [];
  if (entitiesId) { sql += ' WHERE o.entities_id = ?'; args.push(entitiesId); }
  sql += ' ORDER BY o.offtaker_name';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflate));
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_ENTITY + ' WHERE o.id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Offtaker not found' });
  return res.json({ message: 'Offtaker fetched successfully', data: inflate(list[0]) });
});

router.post('/', authenticate, async (req: Request, res: Response) => {
  const b = req.body || {};
  if (b.entities_id === undefined || b.entities_id === '')
    return res.status(422).json({ message: 'entities_id is required' });

  const [result] = await pool.query(
    'INSERT INTO offtaker (offtaker_name, location, entities_id, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
    [b.offtaker_name ?? null, b.location ?? null, Number(b.entities_id)]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query(SELECT_WITH_ENTITY + ' WHERE o.id = ?', [id]);
  return res.status(201).json({ message: 'Offtaker created successfully', data: inflate((rows as any[])[0]) });
});

router.put('/:id', authenticate, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM offtaker WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Offtaker not found' });

  const b = req.body || {};
  const updates: Record<string, any> = {};
  if (b.offtaker_name !== undefined) updates.offtaker_name = b.offtaker_name;
  if (b.location !== undefined)      updates.location      = b.location;
  if (b.entities_id !== undefined)   updates.entities_id   = Number(b.entities_id);

  const keys = Object.keys(updates);
  if (keys.length) {
    keys.push('updated_at'); updates.updated_at = new Date();
    await pool.query(
      `UPDATE offtaker SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => updates[k]), id]
    );
  }
  const [rows] = await pool.query(SELECT_WITH_ENTITY + ' WHERE o.id = ?', [id]);
  return res.json({ message: 'Offtaker updated successfully', data: inflate((rows as any[])[0]) });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM offtaker WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Offtaker not found' });
  return res.json({ message: 'Offtaker deleted successfully' });
});

export default router;
