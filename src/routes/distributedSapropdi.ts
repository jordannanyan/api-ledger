import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

const SAPROPDI_PROOF_DIR = path.resolve(process.env.UPLOAD_PATH || './storage/proofs', '../sapropdi_proofs');
fs.mkdirSync(SAPROPDI_PROOF_DIR, { recursive: true });

const proofStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SAPROPDI_PROOF_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const proofUpload = multer({ storage: proofStorage, limits: { fileSize: 5 * 1024 * 1024 } }).single('upload_proof');

function proofToPath(file?: Express.Multer.File | null): string | null {
  if (!file) return null;
  const base = (process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs').replace(/\/proofs$/, '/sapropdi_proofs');
  return `${base}/${file.filename}`.replace(/\\/g, '/');
}

const SELECT_WITH_RELATIONS = `
  SELECT d.*,
    s.id AS sapropdi__id, s.sapropdi_name AS sapropdi__sapropdi_name, s.unit AS sapropdi__unit,
    pl.id AS plot__id, pl.plot_name AS plot__plot_name, pl.farmer_id AS plot__farmer_id,
    f.id AS plot__farmer__id, f.farmer_name AS plot__farmer__farmer_name, f.kth_id AS plot__farmer__kth_id,
    k.id AS plot__farmer__kth__id, k.kth_name AS plot__farmer__kth__kth_name, k.entities_id AS plot__farmer__kth__entities_id,
    e.id AS plot__farmer__kth__entity__id, e.entities_name AS plot__farmer__kth__entity__entities_name,
    c.id AS commodities__id, c.commodities_name AS commodities__commodities_name
  FROM distributed_sapropdi d
  LEFT JOIN sapropdi s    ON s.id = d.sapropdi_id
  LEFT JOIN plot pl       ON pl.id = d.plot_id
  LEFT JOIN farmers f     ON f.id = pl.farmer_id
  LEFT JOIN kth k         ON k.id = f.kth_id
  LEFT JOIN entities e    ON e.id = k.entities_id
  LEFT JOIN commodities c ON c.id = d.commodities_id
`;

function inflate(row: any): any {
  if (!row) return row;
  const out: any = {};
  const sap: any = {}, plot: any = {}, farmer: any = {}, kth: any = {}, entity: any = {}, com: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('sapropdi__'))                       sap[k.slice('sapropdi__'.length)] = row[k];
    else if (k.startsWith('commodities__'))               com[k.slice('commodities__'.length)] = row[k];
    else if (k.startsWith('plot__farmer__kth__entity__')) entity[k.slice('plot__farmer__kth__entity__'.length)] = row[k];
    else if (k.startsWith('plot__farmer__kth__'))         kth[k.slice('plot__farmer__kth__'.length)] = row[k];
    else if (k.startsWith('plot__farmer__'))              farmer[k.slice('plot__farmer__'.length)] = row[k];
    else if (k.startsWith('plot__'))                      plot[k.slice('plot__'.length)] = row[k];
    else                                                  out[k] = row[k];
  }
  if (plot.id) {
    if (farmer.id) {
      if (kth.id) {
        if (entity.id) kth.entity = entity;
        farmer.kth = kth;
      }
      plot.farmer = farmer;
    }
    out.plot = plot;
  } else out.plot = null;
  out.sapropdi    = sap.id ? sap : null;
  out.commodities = com.id ? com : null;
  return out;
}

// GET /api/distributed-sapropdi?entities_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = SELECT_WITH_RELATIONS;
  const args: any[] = [];
  if (entitiesId) { sql += ' WHERE k.entities_id = ?'; args.push(entitiesId); }
  sql += ' ORDER BY d.date DESC, d.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflate));
});

// GET /api/distributed-sapropdi/by-plot/:plot_id  (also legacy alias: /plot/:plot_id)
router.get(['/by-plot/:plot_id', '/plot/:plot_id'], authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE d.plot_id = ?', [req.params.plot_id]);
  const data = (rows as any[]).map(inflate);
  if (!data.length) return res.status(404).json({ status: 'error', message: 'No distributed sapropdi found for the specified plot_id.' });
  return res.json({ status: 'success', data });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE d.id = ?', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Distributed Sapropdi not found' });
  return res.json({ message: 'Distributed Sapropdi fetched successfully', data: inflate(list[0]) });
});

router.post('/', authenticate, proofUpload, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.plot_id)        return res.status(422).json({ message: 'plot_id is required' });
    if (!b.commodities_id) return res.status(422).json({ message: 'commodities_id is required' });
    if (!b.sapropdi_id)    return res.status(422).json({ message: 'sapropdi_id is required' });

    const [result] = await pool.query(
      `INSERT INTO distributed_sapropdi
        (date, plot_id, commodities_id, sapropdi_id, quantity, price_per_unit, total_price, upload_proof, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        b.date ?? null,
        Number(b.plot_id), Number(b.commodities_id), Number(b.sapropdi_id),
        b.quantity != null ? Number(b.quantity) : null,
        b.price_per_unit != null ? Number(b.price_per_unit) : null,
        b.total_price != null ? Number(b.total_price) : null,
        proofToPath(req.file as any),
      ]
    );
    const id = (result as any).insertId;
    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE d.id = ?', [id]);
    return res.status(201).json({ message: 'Distributed Sapropdi created successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

const updateDistSapropdi = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [exists] = await pool.query('SELECT id FROM distributed_sapropdi WHERE id = ?', [id]);
    if (!(exists as any[]).length) return res.status(404).json({ message: 'Distributed Sapropdi not found' });

    const b = req.body || {};
    const updates: Record<string, any> = {};
    const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
    set('date',           b.date);
    set('plot_id',        b.plot_id != null ? Number(b.plot_id) : undefined);
    set('commodities_id', b.commodities_id != null ? Number(b.commodities_id) : undefined);
    set('sapropdi_id',    b.sapropdi_id != null ? Number(b.sapropdi_id) : undefined);
    set('quantity',       b.quantity != null ? Number(b.quantity) : undefined);
    set('price_per_unit', b.price_per_unit != null ? Number(b.price_per_unit) : undefined);
    set('total_price',    b.total_price != null ? Number(b.total_price) : undefined);
    if (req.file) updates.upload_proof = proofToPath(req.file as any);

    const keys = Object.keys(updates);
    if (keys.length) {
      keys.push('updated_at'); updates.updated_at = new Date();
      await pool.query(
        `UPDATE distributed_sapropdi SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
        [...keys.map(k => updates[k]), id]
      );
    }
    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE d.id = ?', [id]);
    return res.json({ message: 'Distributed Sapropdi updated successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

router.put('/:id', authenticate, proofUpload, updateDistSapropdi);

// Laravel method-spoofing compatibility: POST /:id with body or query _method=PUT
router.post('/:id', authenticate, proofUpload, (req: Request, res: Response) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') {
    return updateDistSapropdi(req, res);
  }
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM distributed_sapropdi WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Distributed Sapropdi not found' });
  return res.json({ message: 'Distributed Sapropdi deleted successfully' });
});

export default router;
