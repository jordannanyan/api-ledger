import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

const SELECT_WITH_KTH = `
  SELECT w.*,
    k.id AS kth__id, k.kth_name AS kth__kth_name, k.entities_id AS kth__entities_id
  FROM warehouse w
  LEFT JOIN kth k ON k.id = w.kth_id
`;

function inflate(row: any): any {
  if (!row) return row;
  const out: any = {};
  const kth: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('kth__')) kth[k.slice('kth__'.length)] = row[k];
    else out[k] = row[k];
  }
  out.kth = kth.id ? kth : null;
  return out;
}

router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = SELECT_WITH_KTH;
  const args: any[] = [];
  if (entitiesId) { sql += ' WHERE k.entities_id = ?'; args.push(entitiesId); }
  sql += ' ORDER BY w.warehouse_name';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflate));
});

router.get('/by-kth/:kth_id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE w.kth_id = ?', [req.params.kth_id]);
  const data = (rows as any[]).map(inflate);
  if (!data.length) return res.status(404).json({ message: 'No warehouses found for the given KTH ID' });
  return res.json({ message: 'Warehouses fetched successfully', data });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE w.id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Warehouse not found' });
  return res.json({ message: 'Warehouse fetched successfully', data: inflate(list[0]) });
});

router.post('/', authenticate, async (req: Request, res: Response) => {
  const b = req.body || {};
  if (b.kth_id === undefined || b.kth_id === '')
    return res.status(422).json({ message: 'kth_id is required' });

  const [result] = await pool.query(
    'INSERT INTO warehouse (warehouse_name, address, kth_id, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
    [b.warehouse_name ?? null, b.address ?? null, Number(b.kth_id)]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE w.id = ?', [id]);
  return res.status(201).json({ message: 'Warehouse created successfully', data: inflate((rows as any[])[0]) });
});

router.put('/:id', authenticate, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM warehouse WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Warehouse not found' });

  const b = req.body || {};
  const updates: Record<string, any> = {};
  if (b.warehouse_name !== undefined) updates.warehouse_name = b.warehouse_name;
  if (b.address !== undefined)        updates.address        = b.address;
  if (b.kth_id !== undefined)         updates.kth_id         = Number(b.kth_id);

  const keys = Object.keys(updates);
  if (keys.length) {
    keys.push('updated_at'); updates.updated_at = new Date();
    await pool.query(
      `UPDATE warehouse SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => updates[k]), id]
    );
  }
  const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE w.id = ?', [id]);
  return res.json({ message: 'Warehouse updated successfully', data: inflate((rows as any[])[0]) });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM warehouse WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Warehouse not found' });
  return res.json({ message: 'Warehouse deleted successfully' });
});

export default router;
