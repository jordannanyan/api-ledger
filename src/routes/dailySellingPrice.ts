import { Router, Request, Response } from 'express';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

// Parse multipart fields (no files) — for PHP web client (cURL array → multipart).
const parseFields = multer().none();

const SELECT_WITH_RELATIONS = `
  SELECT d.*,
    c.id AS commodities__id, c.commodities_name AS commodities__commodities_name,
    g.id AS grade__id, g.grade_name AS grade__grade_name
  FROM daily_selling_price d
  LEFT JOIN commodities c ON c.id = d.commodities_id
  LEFT JOIN grade g       ON g.id = d.grade_id
`;

function inflate(row: any): any {
  if (!row) return row;
  const out: any = {};
  const com: any = {}, grade: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('commodities__')) com[k.slice('commodities__'.length)] = row[k];
    else if (k.startsWith('grade__'))  grade[k.slice('grade__'.length)] = row[k];
    else                               out[k] = row[k];
  }
  out.commodities = com.id ? com : null;
  out.grade       = grade.id ? grade : null;
  return out;
}

router.get('/', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' ORDER BY d.date DESC, d.id DESC');
  return res.json((rows as any[]).map(inflate));
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE d.id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Daily Selling Price not found' });
  return res.json({ message: 'Daily Selling Price fetched successfully', data: inflate(list[0]) });
});

router.post('/', authenticate, parseFields, async (req: Request, res: Response) => {
  const b = req.body || {};
  if (!b.commodities_id) return res.status(422).json({ message: 'commodities_id is required' });
  if (!b.grade_id)       return res.status(422).json({ message: 'grade_id is required' });

  const [result] = await pool.query(
    'INSERT INTO daily_selling_price (commodities_id, grade_id, date, price, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
    [Number(b.commodities_id), Number(b.grade_id), b.date ?? null, b.price != null ? Number(b.price) : null]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE d.id = ?', [id]);
  return res.status(201).json({ message: 'Daily Selling Price created successfully', data: inflate((rows as any[])[0]) });
});

router.put('/:id', authenticate, parseFields, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM daily_selling_price WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Daily Selling Price not found' });

  const b = req.body || {};
  const updates: Record<string, any> = {};
  if (b.commodities_id !== undefined) updates.commodities_id = Number(b.commodities_id);
  if (b.grade_id !== undefined)       updates.grade_id       = Number(b.grade_id);
  if (b.date !== undefined)           updates.date           = b.date;
  if (b.price !== undefined)          updates.price          = Number(b.price);

  const keys = Object.keys(updates);
  if (keys.length) {
    keys.push('updated_at'); updates.updated_at = new Date();
    await pool.query(
      `UPDATE daily_selling_price SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => updates[k]), id]
    );
  }
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE d.id = ?', [id]);
  return res.json({ message: 'Daily Selling Price updated successfully', data: inflate((rows as any[])[0]) });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM daily_selling_price WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Daily Selling Price not found' });
  return res.json({ message: 'Daily Selling Price deleted successfully' });
});

export default router;
