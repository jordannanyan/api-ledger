import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { compressImage } from '../services/imageProcessor';

export const router = Router();

const MON_PHOTO_DIR = path.resolve(process.env.UPLOAD_PATH || './storage/proofs', '../tree_monitorings');
fs.mkdirSync(MON_PHOTO_DIR, { recursive: true });

const monStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MON_PHOTO_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const monUpload = multer({ storage: monStorage, limits: { fileSize: 5 * 1024 * 1024 } }).single('photo');

function monPhotoToPath(file?: Express.Multer.File | null): string | null {
  if (!file) return null;
  const base = (process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs').replace(/\/proofs$/, '/tree_monitorings');
  return `${base}/${file.filename}`.replace(/\\/g, '/');
}

const HEALTH_STATUSES = ['Sehat', 'Tidak Sehat', 'Mati'] as const;

const SELECT_WITH_RELATIONS = `
  SELECT m.*,
    t.id AS tree__id, t.tree_name AS tree__tree_name, t.species AS tree__species,
    t.plot_id AS tree__plot_id, t.farmer_id AS tree__farmer_id,
    p.id AS tree__plot__id, p.plot_name AS tree__plot__plot_name, p.farmer_id AS tree__plot__farmer_id,
    f.id AS tree__farmer__id, f.farmer_name AS tree__farmer__farmer_name, f.kth_id AS tree__farmer__kth_id,
    k.id AS kth__id, k.kth_name AS kth__kth_name, k.entities_id AS kth__entities_id
  FROM tree_monitoring m
  LEFT JOIN trees t   ON t.id = m.tree_id
  LEFT JOIN plot p    ON p.id = t.plot_id
  LEFT JOIN farmers f ON f.id = t.farmer_id
  LEFT JOIN kth k     ON k.id = m.recorded_by_kth_id
`;

function inflate(row: any): any {
  if (!row) return row;
  const out: any = {};
  const tree: any = {}, plot: any = {}, farmer: any = {}, kth: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('tree__plot__'))   plot[k.slice('tree__plot__'.length)]     = row[k];
    else if (k.startsWith('tree__farmer__')) farmer[k.slice('tree__farmer__'.length)] = row[k];
    else if (k.startsWith('tree__'))    tree[k.slice('tree__'.length)] = row[k];
    else if (k.startsWith('kth__'))     kth[k.slice('kth__'.length)]   = row[k];
    else                                out[k] = row[k];
  }
  if (tree.id) {
    if (plot.id) tree.plot = plot;
    if (farmer.id) tree.farmer = farmer;
    out.tree = tree;
  } else out.tree = null;
  out.kth = kth.id ? kth : null;
  return out;
}

// GET /api/tree-monitorings?entities_id=&kth_id=&farmer_id=&tree_id=&per_page=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const treeId     = req.query.tree_id as string | undefined;
  const farmerId   = req.query.farmer_id as string | undefined;
  const kthId      = req.query.kth_id as string | undefined;
  const entitiesId = req.query.entities_id as string | undefined;
  const perPage    = Number(req.query.per_page || 20);
  const page       = Number(req.query.page || 1);

  const where: string[] = [];
  const args: any[] = [];
  if (treeId)     { where.push('m.tree_id = ?'); args.push(treeId); }
  if (farmerId)   { where.push('(t.farmer_id = ? OR p.farmer_id = ?)'); args.push(farmerId, farmerId); }
  if (kthId)      { where.push('f.kth_id = ?'); args.push(kthId); }
  if (entitiesId) { where.push('(SELECT entities_id FROM kth WHERE kth.id = f.kth_id) = ?'); args.push(entitiesId); }

  const offset = (page - 1) * perPage;
  const [rows] = await pool.query(
    SELECT_WITH_RELATIONS + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY m.measured_at DESC, m.id DESC LIMIT ? OFFSET ?',
    [...args, perPage, offset]
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM tree_monitoring m
     LEFT JOIN trees t ON t.id = m.tree_id
     LEFT JOIN plot p  ON p.id = t.plot_id
     LEFT JOIN farmers f ON f.id = t.farmer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`,
    args
  );
  const total = Number((countRows as any[])[0]?.total || 0);
  return res.json({
    current_page: page, per_page: perPage, total,
    last_page: Math.max(1, Math.ceil(total / perPage)),
    data: (rows as any[]).map(inflate),
  });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE m.id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Monitoring tidak ditemukan' });
  return res.json(inflate(list[0]));
});

const updateTreeMonitoring = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [existsRows] = await pool.query('SELECT * FROM tree_monitoring WHERE id = ?', [id]);
    const existing = (existsRows as any[])[0];
    if (!existing) return res.status(404).json({ message: 'Monitoring tidak ditemukan' });

    const b = req.body || {};
    if (b.health_status !== undefined && !HEALTH_STATUSES.includes(b.health_status)) {
      return res.status(422).json({ message: 'health_status invalid' });
    }
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('measured_at',        b.measured_at);
    set('circumference_cm',   b.circumference_cm != null ? Number(b.circumference_cm) : undefined);
    set('health_status',      b.health_status);
    set('health_desc',        b.health_desc);
    set('latitude',           b.latitude != null ? Number(b.latitude) : undefined);
    set('longitude',          b.longitude != null ? Number(b.longitude) : undefined);
    set('accuracy_m',         b.accuracy_m != null ? Number(b.accuracy_m) : undefined);
    set('recorded_by_kth_id', b.recorded_by_kth_id != null ? Number(b.recorded_by_kth_id) : undefined);

    if (req.file) {
      if (existing.photo_path) {
        const oldName = String(existing.photo_path).split('/').pop();
        if (oldName) {
          const oldPath = path.join(MON_PHOTO_DIR, oldName);
          if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
        }
      }
      await compressImage((req.file as any).path);
      updates.photo_path = monPhotoToPath(req.file as any);
    }

    const keys = Object.keys(updates);
    if (keys.length) {
      keys.push('updated_at'); updates.updated_at = new Date();
      await pool.query(
        `UPDATE tree_monitoring SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(k => updates[k]), id]
      );
    }
    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE m.id = ?', [id]);
    return res.json({ message: 'Monitoring berhasil diperbarui', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

router.put('/:id', authenticate, monUpload, updateTreeMonitoring);

// Laravel method-spoofing compatibility: POST /:id with body or query _method=PUT
router.post('/:id', authenticate, monUpload, (req: Request, res: Response) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') {
    return updateTreeMonitoring(req, res);
  }
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [existsRows] = await pool.query('SELECT photo_path FROM tree_monitoring WHERE id = ?', [req.params.id]);
  const existing = (existsRows as any[])[0];
  if (!existing) return res.status(404).json({ message: 'Monitoring tidak ditemukan' });

  if (existing.photo_path) {
    const oldName = String(existing.photo_path).split('/').pop();
    if (oldName) {
      const oldPath = path.join(MON_PHOTO_DIR, oldName);
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch (_) {} }
    }
  }
  await pool.query('DELETE FROM tree_monitoring WHERE id = ?', [req.params.id]);
  return res.json({ message: 'Monitoring berhasil dihapus' });
});

// -----------------------------------------------------------------------------
// Sub-routes mounted under /api/trees/:treeId/monitorings (see server.ts)
// -----------------------------------------------------------------------------
export const subRouter = Router({ mergeParams: true });

subRouter.get('/', authenticate, async (req: Request, res: Response) => {
  const treeId = (req as any).params.treeId;
  const perPage = Number(req.query.per_page || 20);
  const page    = Number(req.query.page || 1);
  const offset  = (page - 1) * perPage;

  const [rows] = await pool.query(
    SELECT_WITH_RELATIONS + ' WHERE m.tree_id = ? ORDER BY m.measured_at DESC, m.id DESC LIMIT ? OFFSET ?',
    [treeId, perPage, offset]
  );
  const [countRows] = await pool.query('SELECT COUNT(*) AS total FROM tree_monitoring WHERE tree_id = ?', [treeId]);
  const total = Number((countRows as any[])[0]?.total || 0);
  return res.json({
    current_page: page, per_page: perPage, total,
    last_page: Math.max(1, Math.ceil(total / perPage)),
    data: (rows as any[]).map(inflate),
  });
});

subRouter.get('/latest', authenticate, async (req: Request, res: Response) => {
  const treeId = (req as any).params.treeId;
  const [rows] = await pool.query(
    SELECT_WITH_RELATIONS + ' WHERE m.tree_id = ? ORDER BY m.measured_at DESC, m.id DESC LIMIT 1',
    [treeId]
  );
  const list = rows as any[];
  return res.json(list.length ? inflate(list[0]) : null);
});

subRouter.post('/', authenticate, monUpload, async (req: Request, res: Response) => {
  try {
    const treeId = (req as any).params.treeId;
    const [tr] = await pool.query('SELECT id FROM trees WHERE id = ?', [treeId]);
    if (!(tr as any[]).length) return res.status(404).json({ message: 'Pohon tidak ditemukan' });

    const b = req.body || {};
    if (!b.measured_at)     return res.status(422).json({ message: 'measured_at is required' });
    if (!b.health_status || !HEALTH_STATUSES.includes(b.health_status))
      return res.status(422).json({ message: 'health_status required (Sehat|Tidak Sehat|Mati)' });

    if (req.file) await compressImage((req.file as any).path);

    const [result] = await pool.query(
      `INSERT INTO tree_monitoring
        (tree_id, measured_at, circumference_cm, health_status, health_desc,
         photo_path, latitude, longitude, accuracy_m, recorded_by_kth_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        Number(treeId), b.measured_at,
        b.circumference_cm != null ? Number(b.circumference_cm) : null,
        b.health_status, b.health_desc ?? null,
        monPhotoToPath(req.file as any),
        b.latitude != null ? Number(b.latitude) : null,
        b.longitude != null ? Number(b.longitude) : null,
        b.accuracy_m != null ? Number(b.accuracy_m) : null,
        b.recorded_by_kth_id != null ? Number(b.recorded_by_kth_id) : null,
      ]
    );
    const id = (result as any).insertId;
    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE m.id = ?', [id]);
    return res.status(201).json({ message: 'Monitoring berhasil ditambahkan', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

export default router;
