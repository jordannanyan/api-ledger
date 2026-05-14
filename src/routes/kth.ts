import { Router, Request, Response } from 'express';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate, hashPassword } from '../middleware/auth';

export const router = Router();

// Parse multipart fields (no files) — for PHP web client (cURL array → multipart).
const parseFields = multer().none();

const SELECT_WITH_ENTITY = `
  SELECT k.*,
    e.id AS entity__id, e.entities_name AS entity__entities_name, e.location AS entity__location
  FROM kth k
  LEFT JOIN entities e ON e.id = k.entities_id
`;

function inflate(row: any): any {
  if (!row) return row;
  delete row.password;
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
  if (entitiesId) { sql += ' WHERE k.entities_id = ?'; args.push(entitiesId); }
  sql += ' ORDER BY k.kth_name';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflate));
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_ENTITY + ' WHERE k.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'KTH not found' });
  return res.json({ message: 'KTH fetched successfully', data: inflate(list[0]) });
});

router.post('/', authenticate, parseFields, async (req: Request, res: Response) => {
  const b = req.body || {};
  if (b.entities_id === undefined || b.entities_id === '')
    return res.status(422).json({ message: 'entities_id is required' });
  if (b.username) {
    const [dup] = await pool.query('SELECT id FROM kth WHERE username = ?', [b.username]);
    if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { username: ['already taken'] } });
  }
  if (b.password && b.password.length < 8) {
    return res.status(422).json({ message: 'Validation error', errors: { password: ['min 8 characters'] } });
  }
  const hash = b.password ? await hashPassword(b.password) : null;
  const [result] = await pool.query(
    `INSERT INTO kth (kth_name, address, regency, partnership_period, entities_id, username, password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [b.kth_name ?? null, b.address ?? null, b.regency ?? null, b.partnership_period ?? null, Number(b.entities_id), b.username ?? null, hash]
  );
  const id = (result as any).insertId;
  const [rows] = await pool.query(SELECT_WITH_ENTITY + ' WHERE k.id = ?', [id]);
  return res.status(201).json({ message: 'KTH created successfully', data: inflate((rows as any[])[0]) });
});

router.put('/:id', authenticate, parseFields, async (req: Request, res: Response) => {
  const id = req.params.id;
  const [exists] = await pool.query('SELECT id FROM kth WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'KTH not found' });

  const b = req.body || {};
  if (b.username !== undefined) {
    const [dup] = await pool.query('SELECT id FROM kth WHERE username = ? AND id != ?', [b.username, id]);
    if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { username: ['already taken'] } });
  }
  if (b.password !== undefined && b.password.length < 8) {
    return res.status(422).json({ message: 'Validation error', errors: { password: ['min 8 characters'] } });
  }
  const updates: Record<string, any> = {};
  for (const k of ['kth_name','address','regency','partnership_period','entities_id','username']) {
    if (b[k] !== undefined) updates[k] = k === 'entities_id' ? Number(b[k]) : b[k];
  }
  if (b.password !== undefined) updates.password = await hashPassword(b.password);

  const keys = Object.keys(updates);
  if (keys.length) {
    keys.push('updated_at'); updates.updated_at = new Date();
    await pool.query(
      `UPDATE kth SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => updates[k]), id]
    );
  }
  const [rows] = await pool.query(SELECT_WITH_ENTITY + ' WHERE k.id = ?', [id]);
  return res.json({ message: 'KTH updated successfully', data: inflate((rows as any[])[0]) });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM kth WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'KTH not found' });
  return res.json({ message: 'KTH deleted successfully' });
});

export default router;
