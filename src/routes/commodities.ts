import { Router, Request, Response } from 'express';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

// Parse multipart fields (no files) — for PHP web client (cURL array → multipart).
const parseFields = multer().none();

router.get('/', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM commodities ORDER BY commodities_name');
  return res.json({ message: 'Commodities fetched successfully', data: rows });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT * FROM commodities WHERE id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Commodity not found' });
  return res.json({ message: 'Commodity fetched successfully', data: list[0] });
});

router.post('/', authenticate, parseFields, async (req: Request, res: Response) => {
  const { commodities_name } = req.body || {};
  const [result] = await pool.query(
    'INSERT INTO commodities (commodities_name, created_at, updated_at) VALUES (?, NOW(), NOW())',
    [commodities_name ?? null]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query('SELECT * FROM commodities WHERE id = ?', [id]);
  return res.status(201).json({ message: 'Commodity created successfully', data: (rows as any[])[0] });
});

router.put('/:id', authenticate, parseFields, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM commodities WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Commodity not found' });

  const { commodities_name } = req.body || {};
  if (commodities_name === undefined) return res.json({ message: 'Nothing to update' });
  await pool.query('UPDATE commodities SET commodities_name = ?, updated_at = NOW() WHERE id = ?', [commodities_name, id]);
  const [rows] = await pool.query('SELECT * FROM commodities WHERE id = ?', [id]);
  return res.json({ message: 'Commodity updated successfully', data: (rows as any[])[0] });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM commodities WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Commodity not found' });
  return res.json({ message: 'Commodity deleted successfully' });
});

export default router;
