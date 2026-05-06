import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

const stripPwd = (row: any) => { if (row) delete row.password; return row; };

router.get('/', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM entities ORDER BY entities_name');
  const list = (rows as any[]).map(stripPwd);
  return res.json({ message: 'Entities fetched successfully', data: list });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM entities WHERE id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Entity not found' });
  return res.json({ message: 'Entity fetched successfully', data: stripPwd(list[0]) });
});

router.post('/', authenticate, async (req: Request, res: Response) => {
  const { entities_name, location, username, password } = req.body || {};
  if (username) {
    const [dup] = await pool.query('SELECT id FROM entities WHERE username = ?', [username]);
    if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { username: ['already taken'] } });
  }
  if (password && password.length < 8) {
    return res.status(422).json({ message: 'Validation error', errors: { password: ['min 8 characters'] } });
  }
  const hash = password ? await bcrypt.hash(password, 12) : null;
  const [result] = await pool.query(
    'INSERT INTO entities (entities_name, location, username, password, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
    [entities_name ?? null, location ?? null, username ?? null, hash]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query('SELECT * FROM entities WHERE id = ?', [id]);
  return res.status(201).json({ message: 'Entity created successfully', data: stripPwd((rows as any[])[0]) });
});

router.put('/:id', authenticate, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM entities WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Entity not found' });

  const b = req.body || {};
  if (b.username !== undefined) {
    const [dup] = await pool.query('SELECT id FROM entities WHERE username = ? AND id != ?', [b.username, id]);
    if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { username: ['already taken'] } });
  }
  if (b.password !== undefined && b.password.length < 8) {
    return res.status(422).json({ message: 'Validation error', errors: { password: ['min 8 characters'] } });
  }
  const updates: Record<string, any> = {};
  if (b.entities_name !== undefined) updates.entities_name = b.entities_name;
  if (b.location !== undefined)      updates.location      = b.location;
  if (b.username !== undefined)      updates.username      = b.username;
  if (b.password !== undefined)      updates.password      = await bcrypt.hash(b.password, 12);

  const keys = Object.keys(updates);
  if (keys.length) {
    keys.push('updated_at'); updates.updated_at = new Date();
    await pool.query(
      `UPDATE entities SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => updates[k]), id]
    );
  }
  const [rows] = await pool.query('SELECT * FROM entities WHERE id = ?', [id]);
  return res.json({ message: 'Entity updated successfully', data: stripPwd((rows as any[])[0]) });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM entities WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Entity not found' });
  return res.json({ message: 'Entity deleted successfully' });
});

export default router;
