import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

router.get('/', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM sapropdi ORDER BY sapropdi_name');
  return res.json(rows);
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM sapropdi WHERE id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Sapropdi not found' });
  return res.json({ message: 'Sapropdi fetched successfully', data: list[0] });
});

router.post('/', authenticate, async (req: Request, res: Response) => {
  const { sapropdi_name, unit } = req.body || {};
  const [result] = await pool.query(
    'INSERT INTO sapropdi (sapropdi_name, unit, created_at, updated_at) VALUES (?, ?, NOW(), NOW())',
    [sapropdi_name ?? null, unit ?? null]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query('SELECT * FROM sapropdi WHERE id = ?', [id]);
  return res.status(201).json({ message: 'Sapropdi created successfully', data: (rows as any[])[0] });
});

router.put('/:id', authenticate, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM sapropdi WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Sapropdi not found' });

  const updates: Record<string, any> = {};
  if (req.body?.sapropdi_name !== undefined) updates.sapropdi_name = req.body.sapropdi_name;
  if (req.body?.unit !== undefined)          updates.unit          = req.body.unit;
  const keys = Object.keys(updates);
  if (keys.length) {
    keys.push('updated_at'); updates.updated_at = new Date();
    await pool.query(
      `UPDATE sapropdi SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => updates[k]), id]
    );
  }
  const [rows] = await pool.query('SELECT * FROM sapropdi WHERE id = ?', [id]);
  return res.json({ message: 'Sapropdi updated successfully', data: (rows as any[])[0] });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM sapropdi WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Sapropdi not found' });
  return res.json({ message: 'Sapropdi deleted successfully' });
});

export default router;
