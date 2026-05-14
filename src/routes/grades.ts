import { Router, Request, Response } from 'express';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

// Parse multipart fields (no files) — for PHP web client (cURL array → multipart).
const parseFields = multer().none();

router.get('/', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM grade ORDER BY grade_name');
  return res.json(rows);
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM grade WHERE id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Grade not found' });
  return res.json({ message: 'Grade fetched successfully', data: list[0] });
});

router.post('/', authenticate, parseFields, async (req: Request, res: Response) => {
  const { grade_name } = req.body || {};
  if (grade_name) {
    const [dup] = await pool.query('SELECT id FROM grade WHERE grade_name = ?', [grade_name]);
    if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { grade_name: ['already taken'] } });
  }
  const [result] = await pool.query(
    'INSERT INTO grade (grade_name, created_at, updated_at) VALUES (?, NOW(), NOW())',
    [grade_name ?? null]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query('SELECT * FROM grade WHERE id = ?', [id]);
  return res.status(201).json({ message: 'Grade created successfully', data: (rows as any[])[0] });
});

router.put('/:id', authenticate, parseFields, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM grade WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Grade not found' });

  const { grade_name } = req.body || {};
  if (grade_name === undefined) return res.json({ message: 'Nothing to update' });
  const [dup] = await pool.query('SELECT id FROM grade WHERE grade_name = ? AND id != ?', [grade_name, id]);
  if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { grade_name: ['already taken'] } });

  await pool.query('UPDATE grade SET grade_name = ?, updated_at = NOW() WHERE id = ?', [grade_name, id]);
  const [rows] = await pool.query('SELECT * FROM grade WHERE id = ?', [id]);
  return res.json({ message: 'Grade updated successfully', data: (rows as any[])[0] });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM grade WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Grade not found' });
  return res.json({ message: 'Grade deleted successfully' });
});

export default router;
