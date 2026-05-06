import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate, hashPassword } from '../middleware/auth';
import { fileToPath } from '../middleware/upload';

export const router = Router();

const FARMER_PHOTO_DIR = path.resolve(process.env.UPLOAD_PATH || './storage/proofs', '../farmers_photos');
fs.mkdirSync(FARMER_PHOTO_DIR, { recursive: true });

const farmerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, FARMER_PHOTO_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const farmerUpload = multer({ storage: farmerStorage, limits: { fileSize: 5 * 1024 * 1024 } }).single('foto');

function farmerPhotoToPath(file?: Express.Multer.File | null): string | null {
  if (!file) return null;
  const base = (process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs').replace(/\/proofs$/, '/farmers_photos');
  return `${base}/${file.filename}`.replace(/\\/g, '/');
}

const SELECT_WITH_KTH = `
  SELECT f.*,
    k.id AS kth__id, k.kth_name AS kth__kth_name, k.entities_id AS kth__entities_id,
    e.id AS kth__entity__id, e.entities_name AS kth__entity__entities_name
  FROM farmers f
  LEFT JOIN kth k       ON k.id = f.kth_id
  LEFT JOIN entities e  ON e.id = k.entities_id
`;

function inflate(row: any): any {
  if (!row) return row;
  delete row.password;
  const out: any = {};
  const kth: any = {}; const entity: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('kth__entity__')) entity[k.slice('kth__entity__'.length)] = row[k];
    else if (k.startsWith('kth__'))    kth[k.slice('kth__'.length)] = row[k];
    else                               out[k] = row[k];
  }
  if (kth.id) {
    kth.entity = entity.id ? entity : null;
    out.kth = kth;
  } else out.kth = null;
  return out;
}

// GET /api/farmers?entities_id=&kth_id=&search=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  const kthId      = req.query.kth_id as string | undefined;
  const search     = req.query.search as string | undefined;

  const where: string[] = [];
  const args: any[] = [];
  if (entitiesId) { where.push('k.entities_id = ?'); args.push(entitiesId); }
  if (kthId)      { where.push('f.kth_id = ?');     args.push(kthId); }
  if (search) {
    where.push('(f.farmer_name LIKE ? OR f.nik LIKE ? OR f.no_hp LIKE ?)');
    const kw = `%${search}%`; args.push(kw, kw, kw);
  }
  const sql = SELECT_WITH_KTH + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY f.farmer_name';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflate));
});

router.get('/by-entity/:entityId', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE k.entities_id = ?', [req.params.entityId]);
  return res.json({ message: 'Farmers fetched successfully', data: (rows as any[]).map(inflate) });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE f.id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Farmer not found' });
  return res.json({ message: 'Farmer fetched successfully', data: inflate(list[0]) });
});

router.post('/', authenticate, farmerUpload, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.nik)      return res.status(422).json({ message: 'nik is required' });
    if (!b.password || b.password.length < 8)
      return res.status(422).json({ message: 'password is required (min 8 chars)' });
    if (!b.kth_id)   return res.status(422).json({ message: 'kth_id is required' });

    // Uniqueness checks
    const [dupNik] = await pool.query('SELECT id FROM farmers WHERE nik = ?', [b.nik]);
    if ((dupNik as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { nik: ['already taken'] } });
    if (b.no_hp) {
      const [dupHp] = await pool.query('SELECT id FROM farmers WHERE no_hp = ?', [b.no_hp]);
      if ((dupHp as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { no_hp: ['already taken'] } });
    }

    const cols = {
      farmer_name:        b.farmer_name ?? null,
      no_hp:              b.no_hp ?? null,
      nik:                b.nik,
      password:           await hashPassword(b.password),
      address:            b.address ?? null,
      previous_income:    b.previous_income != null ? Number(b.previous_income) : null,
      kth_id:             Number(b.kth_id),
      number_of_children: b.number_of_children != null ? Number(b.number_of_children) : null,
      date_of_birth:      b.date_of_birth ?? null,
      pre_finance:        b.pre_finance != null ? (b.pre_finance === 'true' || b.pre_finance === true || Number(b.pre_finance) === 1 ? 1 : 0) : 0,
      no_rek:             b.no_rek ?? null,
      foto:               farmerPhotoToPath(req.file as any),
      created_at:         new Date(),
      updated_at:         new Date(),
    };
    const keys = Object.keys(cols);
    const sql = `INSERT INTO farmers (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const [result] = await pool.query(sql, keys.map(k => (cols as any)[k]));
    const id = (result as any).insertId;
    const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE f.id = ?', [id]);
    return res.status(201).json({ message: 'Farmer created successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.put('/:id', authenticate, farmerUpload, async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [existsRows] = await pool.query('SELECT * FROM farmers WHERE id = ?', [id]);
    const existing = (existsRows as any[])[0];
    if (!existing) return res.status(404).json({ message: 'Farmer not found' });

    const b = req.body || {};
    if (b.nik !== undefined) {
      const [dup] = await pool.query('SELECT id FROM farmers WHERE nik = ? AND id != ?', [b.nik, id]);
      if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { nik: ['already taken'] } });
    }
    if (b.no_hp !== undefined && b.no_hp) {
      const [dup] = await pool.query('SELECT id FROM farmers WHERE no_hp = ? AND id != ?', [b.no_hp, id]);
      if ((dup as any[]).length) return res.status(422).json({ message: 'Validation error', errors: { no_hp: ['already taken'] } });
    }
    if (b.password !== undefined && b.password.length < 8) {
      return res.status(422).json({ message: 'Validation error', errors: { password: ['min 8 characters'] } });
    }

    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('farmer_name',        b.farmer_name);
    set('no_hp',              b.no_hp);
    set('nik',                b.nik);
    set('address',            b.address);
    set('previous_income',    b.previous_income != null ? Number(b.previous_income) : undefined);
    set('kth_id',             b.kth_id != null ? Number(b.kth_id) : undefined);
    set('number_of_children', b.number_of_children != null ? Number(b.number_of_children) : undefined);
    set('date_of_birth',      b.date_of_birth);
    set('pre_finance',        b.pre_finance != null ? (b.pre_finance === 'true' || b.pre_finance === true || Number(b.pre_finance) === 1 ? 1 : 0) : undefined);
    set('no_rek',             b.no_rek);
    if (b.password !== undefined) updates.password = await hashPassword(b.password);

    if (req.file) {
      // Delete old photo if exists & lives in our farmers_photos dir
      if (existing.foto) {
        const oldName = String(existing.foto).split('/').pop();
        if (oldName) {
          const oldPath = path.join(FARMER_PHOTO_DIR, oldName);
          if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
        }
      }
      updates.foto = farmerPhotoToPath(req.file as any);
    }

    const keys = Object.keys(updates);
    if (keys.length) {
      keys.push('updated_at'); updates.updated_at = new Date();
      await pool.query(
        `UPDATE farmers SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(k => updates[k]), id]
      );
    }
    const [rows] = await pool.query(SELECT_WITH_KTH + ' WHERE f.id = ?', [id]);
    return res.json({ message: 'Farmer updated successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM farmers WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Farmer not found' });
  return res.json({ message: 'Farmer deleted successfully' });
});

export default router;
