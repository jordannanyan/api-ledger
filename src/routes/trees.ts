import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { compressImage } from '../services/imageProcessor';

export const router = Router();

const TREE_PHOTO_DIR = path.resolve(process.env.UPLOAD_PATH || './storage/proofs', '../trees');
fs.mkdirSync(TREE_PHOTO_DIR, { recursive: true });

const treeStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TREE_PHOTO_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const treeUpload = multer({ storage: treeStorage, limits: { fileSize: 10 * 1024 * 1024 } }).single('photo');

function treePhotoToPath(file?: Express.Multer.File | null): string | null {
  if (!file) return null;
  const base = (process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs').replace(/\/proofs$/, '/trees');
  return `${base}/${file.filename}`.replace(/\\/g, '/');
}

const SELECT_WITH_RELATIONS = `
  SELECT t.*,
    p.id AS plot__id, p.plot_name AS plot__plot_name, p.farmer_id AS plot__farmer_id,
    p.latitude AS plot__latitude, p.longitude AS plot__longitude,
    f.id AS farmer__id, f.farmer_name AS farmer__farmer_name, f.kth_id AS farmer__kth_id
  FROM trees t
  LEFT JOIN plot p    ON p.id = t.plot_id
  LEFT JOIN farmers f ON f.id = t.farmer_id
`;

function inflate(row: any): any {
  if (!row) return row;
  const out: any = {};
  const plot: any = {}, farmer: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('plot__'))   plot[k.slice('plot__'.length)]     = row[k];
    else if (k.startsWith('farmer__')) farmer[k.slice('farmer__'.length)] = row[k];
    else                          out[k] = row[k];
  }
  out.plot   = plot.id   ? plot   : null;
  out.farmer = farmer.id ? farmer : null;
  return out;
}

async function attachLatestMonitoring(trees: any[]): Promise<void> {
  if (!trees.length) return;
  const ids = trees.map(t => t.id);
  const [rows] = await pool.query(
    `SELECT m.* FROM tree_monitoring m
     INNER JOIN (
       SELECT tree_id, MAX(measured_at) AS max_measured FROM tree_monitoring
       WHERE tree_id IN (${ids.map(() => '?').join(',')}) GROUP BY tree_id
     ) latest ON latest.tree_id = m.tree_id AND latest.max_measured = m.measured_at`,
    ids
  );
  const map = new Map<number, any>();
  for (const r of rows as any[]) map.set(r.tree_id, r);
  for (const t of trees) t.latestMonitoring = map.get(t.id) || null;
}

// GET /api/trees?entities_id=&kth_id=&farmer_id=&plot_id=&search=&per_page=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  const kthId      = req.query.kth_id as string | undefined;
  const farmerId   = req.query.farmer_id as string | undefined;
  const plotId     = req.query.plot_id as string | undefined;
  const search     = req.query.search as string | undefined;
  const perPage    = Number(req.query.per_page || 20);
  const page       = Number(req.query.page || 1);

  const where: string[] = [];
  const args: any[] = [];
  let join = SELECT_WITH_RELATIONS;
  if (kthId || entitiesId) {
    join += ' LEFT JOIN kth k ON k.id = f.kth_id';
  }
  if (plotId)     { where.push('t.plot_id = ?');     args.push(plotId); }
  if (farmerId)   { where.push('(t.farmer_id = ? OR p.farmer_id = ?)'); args.push(farmerId, farmerId); }
  if (kthId)      { where.push('k.id = ?'); args.push(kthId); }
  if (entitiesId) { where.push('k.entities_id = ?'); args.push(entitiesId); }
  if (search)     { where.push('(t.tree_name LIKE ? OR t.species LIKE ?)'); const kw = `%${search}%`; args.push(kw, kw); }

  const offset = (page - 1) * perPage;
  const [rows] = await pool.query(
    join + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY t.tree_name LIMIT ? OFFSET ?',
    [...args, perPage, offset]
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM trees t
     LEFT JOIN plot p ON p.id = t.plot_id
     LEFT JOIN farmers f ON f.id = t.farmer_id
     ${(kthId || entitiesId) ? 'LEFT JOIN kth k ON k.id = f.kth_id' : ''}
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    args
  );
  const total = Number((countRows as any[])[0]?.total || 0);
  const data = (rows as any[]).map(inflate);
  await attachLatestMonitoring(data);

  return res.json({
    current_page: page,
    per_page: perPage,
    total,
    last_page: Math.max(1, Math.ceil(total / perPage)),
    data,
  });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE t.id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Pohon tidak ditemukan' });
  const data = inflate(list[0]);
  await attachLatestMonitoring([data]);
  return res.json({ message: 'Detail pohon berhasil diambil', data });
});

router.post('/', authenticate, treeUpload, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.plot_id)       return res.status(422).json({ message: 'plot_id is required' });
    if (!b.tree_name)     return res.status(422).json({ message: 'tree_name is required' });
    if (!b.species)       return res.status(422).json({ message: 'species is required' });
    if (!b.planting_date) return res.status(422).json({ message: 'planting_date is required' });

    let farmerId = b.farmer_id ? Number(b.farmer_id) : null;
    if (!farmerId) {
      const [pr] = await pool.query('SELECT farmer_id FROM plot WHERE id = ?', [b.plot_id]);
      if (!(pr as any[]).length) return res.status(422).json({ message: 'plot_id not found' });
      farmerId = (pr as any[])[0].farmer_id;
    }

    if (req.file) await compressImage((req.file as any).path);

    const [result] = await pool.query(
      `INSERT INTO trees (plot_id, farmer_id, tree_name, species, planting_date, qr_code, photo_path, latitude, longitude, accuracy_m, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        Number(b.plot_id), farmerId, b.tree_name, b.species, b.planting_date,
        b.qr_code ?? null,
        treePhotoToPath(req.file as any),
        b.latitude != null ? Number(b.latitude) : null,
        b.longitude != null ? Number(b.longitude) : null,
        b.accuracy_m != null ? Number(b.accuracy_m) : null,
      ]
    );
    const id = (result as any).insertId;
    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE t.id = ?', [id]);
    const data = inflate((rows as any[])[0]);
    return res.status(201).json({ message: 'Pohon berhasil dibuat', data, photo_url: data.photo_path });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

const updateTree = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [existsRows] = await pool.query('SELECT * FROM trees WHERE id = ?', [id]);
    const existing = (existsRows as any[])[0];
    if (!existing) return res.status(404).json({ message: 'Pohon tidak ditemukan' });

    const b = req.body || {};
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('plot_id',       b.plot_id != null ? Number(b.plot_id) : undefined);
    set('farmer_id',     b.farmer_id != null ? Number(b.farmer_id) : undefined);
    set('tree_name',     b.tree_name);
    set('species',       b.species);
    set('planting_date', b.planting_date);
    set('qr_code',       b.qr_code);
    set('latitude',      b.latitude != null ? Number(b.latitude) : undefined);
    set('longitude',     b.longitude != null ? Number(b.longitude) : undefined);
    set('accuracy_m',    b.accuracy_m != null ? Number(b.accuracy_m) : undefined);

    if (b.plot_id !== undefined && b.farmer_id === undefined) {
      const [pr] = await pool.query('SELECT farmer_id FROM plot WHERE id = ?', [b.plot_id]);
      if ((pr as any[]).length) updates.farmer_id = (pr as any[])[0].farmer_id;
    }

    if (req.file) {
      if (existing.photo_path) {
        const oldName = String(existing.photo_path).split('/').pop();
        if (oldName) {
          const oldPath = path.join(TREE_PHOTO_DIR, oldName);
          if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
        }
      }
      await compressImage((req.file as any).path);
      updates.photo_path = treePhotoToPath(req.file as any);
    }

    const keys = Object.keys(updates);
    if (keys.length) {
      keys.push('updated_at'); updates.updated_at = new Date();
      await pool.query(
        `UPDATE trees SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(k => updates[k]), id]
      );
    }
    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE t.id = ?', [id]);
    const data = inflate((rows as any[])[0]);
    return res.json({ message: 'Pohon berhasil diperbarui', data, photo_url: data.photo_path });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

router.put('/:id', authenticate, treeUpload, updateTree);

// Laravel method-spoofing compatibility: POST /:id with body or query _method=PUT
router.post('/:id', authenticate, treeUpload, (req: Request, res: Response) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') {
    return updateTree(req, res);
  }
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [existsRows] = await pool.query('SELECT photo_path FROM trees WHERE id = ?', [req.params.id]);
  const existing = (existsRows as any[])[0];
  if (!existing) return res.status(404).json({ message: 'Pohon tidak ditemukan' });

  if (existing.photo_path) {
    const oldName = String(existing.photo_path).split('/').pop();
    if (oldName) {
      const oldPath = path.join(TREE_PHOTO_DIR, oldName);
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
    }
  }
  await pool.query('DELETE FROM trees WHERE id = ?', [req.params.id]);
  return res.json({ message: 'Pohon berhasil dihapus' });
});

export default router;
