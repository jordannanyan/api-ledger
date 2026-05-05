import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import LedgerComputeService from '../services/LedgerComputeService';

export const router = Router();
const ledger = new LedgerComputeService();

const proofUpload = upload.single('upload_proof');

const SELECT_WITH_RELATIONS = `
  SELECT
    pr.*,
    w.id AS warehouse__id, w.warehouse_name AS warehouse__warehouse_name, w.kth_id AS warehouse__kth_id,
    c.id AS commodity__id, c.commodities_name AS commodity__commodities_name
  FROM processing pr
  LEFT JOIN warehouse w   ON w.id = pr.warehouse_id
  LEFT JOIN commodities c ON c.id = pr.commodities_id
`;

function inflate(row: any): any {
  const out: any = {};
  const rel: Record<string, any> = { warehouse: {}, commodity: {} };
  for (const k of Object.keys(row)) {
    const m = k.match(/^(warehouse|commodity)__(.+)$/);
    if (m) rel[m[1]][m[2]] = row[k];
    else out[k] = row[k];
  }
  out.warehouse = rel.warehouse.id ? rel.warehouse : null;
  out.commodity = rel.commodity.id ? rel.commodity : null;
  // Derived: processing_cost_per_kg = total_processing_cost / volume_input
  out.processing_cost_per_kg = Number(out.volume_input) > 0
    ? Number(out.total_processing_cost) / Number(out.volume_input)
    : 0;
  return out;
}

// GET /api/processing?entities_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = SELECT_WITH_RELATIONS;
  const args: any[] = [];
  if (entitiesId) {
    sql += ` WHERE w.kth_id IN (SELECT id FROM kth WHERE entities_id = ?)`;
    args.push(entitiesId);
  }
  sql += ' ORDER BY pr.date DESC, pr.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflate));
});

// GET /api/processing/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE pr.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Processing record not found' });
  return res.json({ message: 'Processing record fetched successfully', data: inflate(list[0]) });
});

// GET /api/processing/by-kth/:kth_id
router.get('/by-kth/:kth_id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE w.kth_id = ? ORDER BY pr.date DESC, pr.id DESC', [req.params.kth_id]);
  const data = (rows as any[]).map(inflate);
  if (!data.length) return res.status(404).json({ status: 'error', message: 'No processing records found for the specified KTH ID.' });
  return res.json({ status: 'success', data });
});

// POST /api/processing
router.post('/', authenticate, proofUpload, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    if (b.warehouse_id === undefined || b.warehouse_id === '')
      return res.status(422).json({ message: 'warehouse_id is required' });
    if (b.commodities_id === undefined || b.commodities_id === '')
      return res.status(422).json({ message: 'commodities_id is required' });

    const cols = {
      receipt_invoice:        b.receipt_invoice ?? null,
      date:                   b.date ?? null,
      warehouse_id:           Number(b.warehouse_id),
      commodities_id:         Number(b.commodities_id),
      volume_input:           Number(b.volume_input) || 0,
      volume_output:          Number(b.volume_output) || 0,
      total_processing_cost:  Number(b.total_processing_cost) || 0,
      upload_proof:           fileToPath(req.file as any),
      notes:                  b.notes ?? null,
      created_at:             new Date(),
      updated_at:             new Date(),
    };

    const keys = Object.keys(cols);
    const sql = `INSERT INTO processing (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const [result] = await pool.query(sql, keys.map(k => (cols as any)[k]));
    const id = (result as any).insertId;

    ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));

    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE pr.id = ? LIMIT 1', [id]);
    return res.status(201).json({ message: 'Processing record created successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/processing/:id
router.put('/:id', authenticate, proofUpload, async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [exists] = await pool.query('SELECT id FROM processing WHERE id = ? LIMIT 1', [id]);
    if (!(exists as any[]).length) return res.status(404).json({ message: 'Processing record not found' });

    const b = req.body || {};
    const updates: Record<string, any> = {};
    const setIf = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };

    setIf('receipt_invoice',       b.receipt_invoice);
    setIf('date',                  b.date);
    setIf('warehouse_id',          b.warehouse_id != null ? Number(b.warehouse_id) : undefined);
    setIf('commodities_id',        b.commodities_id != null ? Number(b.commodities_id) : undefined);
    setIf('volume_input',          b.volume_input != null ? Number(b.volume_input) : undefined);
    setIf('volume_output',         b.volume_output != null ? Number(b.volume_output) : undefined);
    setIf('total_processing_cost', b.total_processing_cost != null ? Number(b.total_processing_cost) : undefined);
    setIf('notes',                 b.notes);

    if (req.file) updates.upload_proof = fileToPath(req.file as any);

    const keys = Object.keys(updates);
    if (keys.length) {
      keys.push('updated_at');
      updates.updated_at = new Date();
      const sql = `UPDATE processing SET ${keys.map(k => `\`${k}\`= ?`).join(', ')} WHERE id = ?`;
      await pool.query(sql, [...keys.map(k => updates[k]), id]);
    }

    ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));

    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE pr.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Processing record updated successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// DELETE /api/processing/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM processing WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Processing record not found' });
  ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));
  return res.json({ message: 'Processing record deleted successfully' });
});

export default router;
