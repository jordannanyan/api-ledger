import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import LedgerComputeService from '../services/LedgerComputeService';

export const router = Router();
const ledger = new LedgerComputeService();

const STATUSES = ['verified', 'not_verified', 'failed'] as const;
const PAYMENT_STATUSES = ['paid', 'unpaid'] as const;

const proofUploads = upload.fields([
  { name: 'upload_proof_value',     maxCount: 1 },
  { name: 'upload_proof_deduction', maxCount: 1 },
  { name: 'upload_proof_payment',   maxCount: 1 },
  { name: 'signature_image',        maxCount: 1 },
]);

// Mirror Laravel PurchasingController: same eager-loaded relations.
const SELECT_WITH_RELATIONS = `
  SELECT
    p.*,
    pl.id AS plot__id, pl.plot_name AS plot__plot_name, pl.farmer_id AS plot__farmer_id,
    w.id  AS warehouse__id,  w.warehouse_name AS warehouse__warehouse_name, w.kth_id AS warehouse__kth_id,
    c.id  AS commodity__id,  c.commodities_name AS commodity__commodities_name,
    g.id  AS grade__id,      g.grade_name AS grade__grade_name
  FROM purchasing p
  LEFT JOIN plot pl       ON pl.id = p.plot_id
  LEFT JOIN warehouse w   ON w.id  = p.warehouse_id
  LEFT JOIN commodities c ON c.id  = p.commodities_id
  LEFT JOIN grade g       ON g.id  = p.grade_id
`;

function inflateRelations(row: any): any {
  const out: any = {};
  const rel: Record<string, any> = { plot: {}, warehouse: {}, commodity: {}, grade: {} };
  for (const k of Object.keys(row)) {
    const m = k.match(/^(plot|warehouse|commodity|grade)__(.+)$/);
    if (m) rel[m[1]][m[2]] = row[k];
    else out[k] = row[k];
  }
  out.plot      = rel.plot.id      ? rel.plot      : null;
  out.warehouse = rel.warehouse.id ? rel.warehouse : null;
  out.commodity = rel.commodity.id ? rel.commodity : null;
  out.grade     = rel.grade.id     ? rel.grade     : null;
  return out;
}

// GET /api/purchasing?entities_id=&status=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  const status     = req.query.status as string | undefined;

  if (status && !STATUSES.includes(status as any)) {
    return res.status(422).json({ message: 'Invalid status filter. Allowed: verified, not_verified, failed.' });
  }

  const where: string[] = [];
  const args: any[] = [];

  if (entitiesId) {
    where.push(`pl.farmer_id IN (
      SELECT f.id FROM farmers f
      JOIN kth k ON k.id = f.kth_id
      WHERE k.entities_id = ?
    )`);
    args.push(entitiesId);
  }
  if (status) { where.push('p.STATUS = ?'); args.push(status); }

  const sql = SELECT_WITH_RELATIONS + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY p.date DESC, p.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflateRelations));
});

// GET /api/purchasing/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE p.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Purchasing record not found' });
  return res.json({ message: 'Purchasing record fetched successfully', data: inflateRelations(list[0]) });
});

// GET /api/purchasing/by-kth/:kth_id  (also legacy alias: /kth/:kth_id)
router.get(['/by-kth/:kth_id', '/kth/:kth_id'], authenticate, async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(422).json({ status: 'error', message: 'Invalid status filter.' });
  }
  const args: any[] = [req.params.kth_id];
  let sql = SELECT_WITH_RELATIONS + ' WHERE w.kth_id = ?';
  if (status) { sql += ' AND p.STATUS = ?'; args.push(status); }
  sql += ' ORDER BY p.date DESC, p.id DESC';
  const [rows] = await pool.query(sql, args);
  const data = (rows as any[]).map(inflateRelations);
  if (!data.length) return res.status(404).json({ status: 'error', message: 'No purchasing records found for the specified KTH ID.' });
  return res.json({ status: 'success', data });
});

// GET /api/purchasing/by-farmer/:farmer_id  (also legacy alias: /farmer/:farmer_id)
router.get(['/by-farmer/:farmer_id', '/farmer/:farmer_id'], authenticate, async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  if (status && !STATUSES.includes(status as any)) {
    return res.status(422).json({ status: 'error', message: 'Invalid status filter.' });
  }
  const args: any[] = [req.params.farmer_id];
  let sql = SELECT_WITH_RELATIONS + ' WHERE pl.farmer_id = ?';
  if (status) { sql += ' AND p.STATUS = ?'; args.push(status); }
  sql += ' ORDER BY p.date DESC, p.id DESC';
  const [rows] = await pool.query(sql, args);
  const data = (rows as any[]).map(inflateRelations);
  if (!data.length) return res.status(404).json({ status: 'error', message: 'No purchasing records found for the specified farmer_id.' });
  return res.json({ status: 'success', data });
});

// POST /api/purchasing
router.post('/', authenticate, proofUploads, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;

    const required = ['plot_id', 'warehouse_id', 'commodities_id', 'grade_id'];
    for (const k of required) {
      if (b[k] === undefined || b[k] === null || b[k] === '') {
        return res.status(422).json({ message: `${k} is required` });
      }
    }
    if (b.status && !STATUSES.includes(b.status)) {
      return res.status(422).json({ message: 'Invalid status' });
    }
    if (b.payment_status && !PAYMENT_STATUSES.includes(b.payment_status)) {
      return res.status(422).json({ message: 'Invalid payment_status' });
    }

    const cols = {
      receipt_invoice:        b.receipt_invoice ?? null,
      date:                   b.date ?? null,
      plot_id:                Number(b.plot_id),
      warehouse_id:           Number(b.warehouse_id),
      commodities_id:         Number(b.commodities_id),
      quantity:               b.quantity != null ? Number(b.quantity) : null,
      grade_id:               Number(b.grade_id),
      price_per_kg:           b.price_per_kg != null ? Number(b.price_per_kg) : null,
      value_purchased:        b.value_purchased != null ? Number(b.value_purchased) : null,
      upload_proof_value:     fileToPath(files?.upload_proof_value?.[0]),
      deduction:              b.deduction != null ? Number(b.deduction) : null,
      upload_proof_deduction: fileToPath(files?.upload_proof_deduction?.[0]),
      net_payment:            b.net_payment != null ? Number(b.net_payment) : null,
      payment_status:         b.payment_status ?? 'unpaid',
      upload_proof_payment:   fileToPath(files?.upload_proof_payment?.[0]),
      signature_image:        fileToPath(files?.signature_image?.[0]),
      STATUS:                 b.status ?? 'not_verified',
      created_at:             new Date(),
      updated_at:             new Date(),
    };

    const keys = Object.keys(cols);
    const sql = `INSERT INTO purchasing (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const [result] = await pool.query(sql, keys.map(k => (cols as any)[k]));
    const id = (result as any).insertId;

    // Recompute ledger (best-effort, non-blocking)
    ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));

    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE p.id = ? LIMIT 1', [id]);
    return res.status(201).json({ message: 'Purchasing record created successfully', data: inflateRelations((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/purchasing/:id  (Flutter uses POST /:id + _method=PUT — see route below)
const updatePurchasing = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [exists] = await pool.query('SELECT id FROM purchasing WHERE id = ? LIMIT 1', [id]);
    if (!(exists as any[]).length) return res.status(404).json({ message: 'Purchasing record not found' });

    const b = req.body || {};
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    if (b.status && !STATUSES.includes(b.status)) {
      return res.status(422).json({ message: 'Invalid status' });
    }
    if (b.payment_status && !PAYMENT_STATUSES.includes(b.payment_status)) {
      return res.status(422).json({ message: 'Invalid payment_status' });
    }

    const updates: Record<string, any> = {};
    const setIf = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };

    setIf('receipt_invoice', b.receipt_invoice);
    setIf('date',            b.date);
    setIf('plot_id',         b.plot_id != null ? Number(b.plot_id) : undefined);
    setIf('warehouse_id',    b.warehouse_id != null ? Number(b.warehouse_id) : undefined);
    setIf('commodities_id',  b.commodities_id != null ? Number(b.commodities_id) : undefined);
    setIf('quantity',        b.quantity != null ? Number(b.quantity) : undefined);
    setIf('grade_id',        b.grade_id != null ? Number(b.grade_id) : undefined);
    setIf('price_per_kg',    b.price_per_kg != null ? Number(b.price_per_kg) : undefined);
    setIf('value_purchased', b.value_purchased != null ? Number(b.value_purchased) : undefined);
    setIf('deduction',       b.deduction != null ? Number(b.deduction) : undefined);
    setIf('net_payment',     b.net_payment != null ? Number(b.net_payment) : undefined);
    setIf('payment_status',  b.payment_status);
    setIf('STATUS',          b.status);

    const fileMap: Record<string, string> = {
      upload_proof_value: 'upload_proof_value',
      upload_proof_deduction: 'upload_proof_deduction',
      upload_proof_payment: 'upload_proof_payment',
      signature_image: 'signature_image',
    };
    for (const [field, col] of Object.entries(fileMap)) {
      const f = files?.[field]?.[0];
      if (f) updates[col] = fileToPath(f);
    }

    const keys = Object.keys(updates);
    if (keys.length) {
      keys.push('updated_at');
      updates.updated_at = new Date();
      const sql = `UPDATE purchasing SET ${keys.map(k => `\`${k}\`= ?`).join(', ')} WHERE id = ?`;
      await pool.query(sql, [...keys.map(k => updates[k]), id]);
    }

    ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));

    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE p.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Purchasing record updated successfully', data: inflateRelations((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

router.put('/:id', authenticate, proofUploads, updatePurchasing);

// Laravel method-spoofing compatibility: POST /:id with body _method=PUT
router.post('/:id', authenticate, proofUploads, (req: Request, res: Response) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') {
    return updatePurchasing(req, res);
  }
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/purchasing/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM purchasing WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Purchasing record not found' });
  ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));
  return res.json({ message: 'Purchasing record deleted successfully' });
});

export default router;
