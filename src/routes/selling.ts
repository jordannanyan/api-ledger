import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import { upload, fileToPath } from '../middleware/upload';
import { compressImages } from '../services/imageProcessor';
import LedgerComputeService from '../services/LedgerComputeService';

export const router = Router();
const ledger = new LedgerComputeService();

const fileUploads = upload.fields([
  { name: 'upload_invoice', maxCount: 1 },
  { name: 'upload_do',      maxCount: 1 },
]);

const SELECT_WITH_RELATIONS = `
  SELECT
    s.*,
    w.id AS warehouse__id, w.warehouse_name AS warehouse__warehouse_name, w.kth_id AS warehouse__kth_id,
    o.id AS offTaker__id,  o.offtaker_name  AS offTaker__offtaker_name,   o.entities_id AS offTaker__entities_id,
    c.id AS commodity__id, c.commodities_name AS commodity__commodities_name,
    g.id AS grade__id,     g.grade_name AS grade__grade_name
  FROM selling s
  LEFT JOIN warehouse w   ON w.id = s.warehouse_id
  LEFT JOIN offtaker o    ON o.id = s.offtaker_id
  LEFT JOIN commodities c ON c.id = s.commodities_id
  LEFT JOIN grade g       ON g.id = s.grade_id
`;

function inflate(row: any): any {
  const out: any = {};
  const rel: Record<string, any> = { warehouse: {}, offTaker: {}, commodity: {}, grade: {} };
  for (const k of Object.keys(row)) {
    const m = k.match(/^(warehouse|offTaker|commodity|grade)__(.+)$/);
    if (m) rel[m[1]][m[2]] = row[k];
    else out[k] = row[k];
  }
  out.warehouse = rel.warehouse.id ? rel.warehouse : null;
  out.offTaker  = rel.offTaker.id  ? rel.offTaker  : null;
  out.commodity = rel.commodity.id ? rel.commodity : null;
  out.grade     = rel.grade.id     ? rel.grade     : null;
  return out;
}

// Auto-derive total_delivery_cost from the 5 cost components.
function computeTotalDeliveryCost(b: any): number {
  return ['cost_packing', 'cost_loading', 'cost_transport', 'cost_consumption', 'cost_other']
    .reduce((sum, k) => sum + (Number(b[k]) || 0), 0);
}

// GET /api/selling?entities_id=
router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = SELECT_WITH_RELATIONS;
  const args: any[] = [];
  if (entitiesId) {
    sql += ` WHERE w.kth_id IN (SELECT id FROM kth WHERE entities_id = ?)`;
    args.push(entitiesId);
  }
  sql += ' ORDER BY s.date DESC, s.id DESC';
  const [rows] = await pool.query(sql, args);
  return res.json((rows as any[]).map(inflate));
});

// GET /api/selling/:id
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE s.id = ? LIMIT 1', [req.params.id]);
  const list = rows as any[];
  if (!list.length) return res.status(404).json({ message: 'Selling record not found' });
  return res.json({ message: 'Selling record fetched successfully', data: inflate(list[0]) });
});

// GET /api/selling/by-kth/:kth_id  (also legacy alias: /kth/:kth_id)
router.get(['/by-kth/:kth_id', '/kth/:kth_id'], authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE w.kth_id = ? ORDER BY s.date DESC, s.id DESC', [req.params.kth_id]);
  const data = (rows as any[]).map(inflate);
  if (!data.length) return res.status(404).json({ status: 'error', message: 'No selling records found for the specified KTH ID.' });
  return res.json({ status: 'success', data });
});

// POST /api/selling
router.post('/', authenticate, fileUploads, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;

    for (const k of ['warehouse_id', 'offtaker_id', 'commodities_id', 'grade_id']) {
      if (b[k] === undefined || b[k] === '') return res.status(422).json({ message: `${k} is required` });
    }

    await compressImages([
      files?.upload_invoice?.[0]?.path,
      files?.upload_do?.[0]?.path,
    ]);

    const total_delivery_cost = b.total_delivery_cost != null
      ? Number(b.total_delivery_cost)
      : computeTotalDeliveryCost(b);

    const cols = {
      receipt_invoice:     b.receipt_invoice ?? null,
      date:                b.date ?? null,
      warehouse_id:        Number(b.warehouse_id),
      offtaker_id:         Number(b.offtaker_id),
      commodities_id:      Number(b.commodities_id),
      grade_id:            Number(b.grade_id),
      quantity:            b.quantity != null ? Number(b.quantity) : null,
      price_per_kg:        b.price_per_kg != null ? Number(b.price_per_kg) : null,
      total_price:         b.total_price != null ? Number(b.total_price) : null,
      cost_packing:        Number(b.cost_packing) || 0,
      cost_loading:        Number(b.cost_loading) || 0,
      cost_transport:      Number(b.cost_transport) || 0,
      cost_consumption:    Number(b.cost_consumption) || 0,
      cost_other:          Number(b.cost_other) || 0,
      total_delivery_cost,
      tax_pph:             Number(b.tax_pph) || 0,
      taxes_or_deductions: b.taxes_or_deductions != null ? Number(b.taxes_or_deductions) : null,
      total_net_sales:     b.total_net_sales != null ? Number(b.total_net_sales) : null,
      upload_invoice:      fileToPath(files?.upload_invoice?.[0]),
      upload_do:           fileToPath(files?.upload_do?.[0]),
      created_at:          new Date(),
      updated_at:          new Date(),
    };

    const keys = Object.keys(cols);
    const sql = `INSERT INTO selling (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
    const [result] = await pool.query(sql, keys.map(k => (cols as any)[k]));
    const id = (result as any).insertId;

    ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));

    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE s.id = ? LIMIT 1', [id]);
    return res.status(201).json({ message: 'Selling record created successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// PUT /api/selling/:id  (Flutter uses POST /:id + _method=PUT — see route below)
const updateSelling = async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const [exists] = await pool.query('SELECT id FROM selling WHERE id = ? LIMIT 1', [id]);
    if (!(exists as any[]).length) return res.status(404).json({ message: 'Selling record not found' });

    const b = req.body || {};
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;

    const updates: Record<string, any> = {};
    const setIf = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };

    setIf('receipt_invoice',     b.receipt_invoice);
    setIf('date',                b.date);
    setIf('warehouse_id',        b.warehouse_id != null ? Number(b.warehouse_id) : undefined);
    setIf('offtaker_id',         b.offtaker_id != null ? Number(b.offtaker_id) : undefined);
    setIf('commodities_id',      b.commodities_id != null ? Number(b.commodities_id) : undefined);
    setIf('grade_id',            b.grade_id != null ? Number(b.grade_id) : undefined);
    setIf('quantity',            b.quantity != null ? Number(b.quantity) : undefined);
    setIf('price_per_kg',        b.price_per_kg != null ? Number(b.price_per_kg) : undefined);
    setIf('total_price',         b.total_price != null ? Number(b.total_price) : undefined);
    setIf('cost_packing',        b.cost_packing != null ? Number(b.cost_packing) : undefined);
    setIf('cost_loading',        b.cost_loading != null ? Number(b.cost_loading) : undefined);
    setIf('cost_transport',      b.cost_transport != null ? Number(b.cost_transport) : undefined);
    setIf('cost_consumption',    b.cost_consumption != null ? Number(b.cost_consumption) : undefined);
    setIf('cost_other',          b.cost_other != null ? Number(b.cost_other) : undefined);
    setIf('tax_pph',             b.tax_pph != null ? Number(b.tax_pph) : undefined);
    setIf('taxes_or_deductions', b.taxes_or_deductions != null ? Number(b.taxes_or_deductions) : undefined);
    setIf('total_net_sales',     b.total_net_sales != null ? Number(b.total_net_sales) : undefined);

    // Recompute total_delivery_cost when any cost field is touched OR when explicit value given.
    const costFieldTouched = ['cost_packing', 'cost_loading', 'cost_transport', 'cost_consumption', 'cost_other']
      .some(k => b[k] !== undefined);
    if (b.total_delivery_cost !== undefined) {
      updates.total_delivery_cost = Number(b.total_delivery_cost);
    } else if (costFieldTouched) {
      // Fetch existing values for fields not in this update, then recompute
      const [existing] = await pool.query(
        'SELECT cost_packing, cost_loading, cost_transport, cost_consumption, cost_other FROM selling WHERE id = ?',
        [id]
      );
      const cur = (existing as any[])[0] || {};
      const merged = {
        cost_packing:     updates.cost_packing     ?? Number(cur.cost_packing)     ?? 0,
        cost_loading:     updates.cost_loading     ?? Number(cur.cost_loading)     ?? 0,
        cost_transport:   updates.cost_transport   ?? Number(cur.cost_transport)   ?? 0,
        cost_consumption: updates.cost_consumption ?? Number(cur.cost_consumption) ?? 0,
        cost_other:       updates.cost_other       ?? Number(cur.cost_other)       ?? 0,
      };
      updates.total_delivery_cost = computeTotalDeliveryCost(merged);
    }

    await compressImages([
      files?.upload_invoice?.[0]?.path,
      files?.upload_do?.[0]?.path,
    ]);
    if (files?.upload_invoice?.[0]) updates.upload_invoice = fileToPath(files.upload_invoice[0]);
    if (files?.upload_do?.[0])      updates.upload_do      = fileToPath(files.upload_do[0]);

    const keys = Object.keys(updates);
    if (keys.length) {
      keys.push('updated_at');
      updates.updated_at = new Date();
      const sql = `UPDATE selling SET ${keys.map(k => `\`${k}\`= ?`).join(', ')} WHERE id = ?`;
      await pool.query(sql, [...keys.map(k => updates[k]), id]);
    }

    ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));

    const [rows] = await pool.query(SELECT_WITH_RELATIONS + ' WHERE s.id = ? LIMIT 1', [id]);
    return res.json({ message: 'Selling record updated successfully', data: inflate((rows as any[])[0]) });
  } catch (err: any) {
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

router.put('/:id', authenticate, fileUploads, updateSelling);

// Laravel method-spoofing compatibility: POST /:id with body _method=PUT
router.post('/:id', authenticate, fileUploads, (req: Request, res: Response) => {
  if (String(req.body?._method || req.query?._method || '').toUpperCase() === 'PUT') {
    return updateSelling(req, res);
  }
  return res.status(404).json({ message: `Not found: POST ${req.originalUrl}` });
});

// DELETE /api/selling/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM selling WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Selling record not found' });
  ledger.rebuild().catch(err => console.error('[ledger.rebuild] failed:', err.message));
  return res.json({ message: 'Selling record deleted successfully' });
});

export default router;
