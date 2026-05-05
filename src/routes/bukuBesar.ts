import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';
import LedgerComputeService from '../services/LedgerComputeService';

export const router = Router();
const ledger = new LedgerComputeService();

/**
 * GET /api/buku-besar
 *   ?year=2025
 *   ?month=6
 *   ?process=Purchasing|Processing|Delivery
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns ledger entries from the pre-computed `ledger_entries` table.
 * The first column `entry_number` is computed as a 1-based row index in the
 * filtered result set (matches Excel's "Entry Number" column).
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
  const where: string[] = [];
  const args: any[] = [];

  const year   = req.query.year   ? Number(req.query.year)  : undefined;
  const month  = req.query.month  ? Number(req.query.month) : undefined;
  const proc   = req.query.process as string | undefined;
  const from   = req.query.from   as string | undefined;
  const to     = req.query.to     as string | undefined;

  if (year)  { where.push('year = ?');  args.push(year); }
  if (month) { where.push('month = ?'); args.push(month); }
  if (proc)  { where.push('process = ?'); args.push(proc); }
  if (from)  { where.push('entry_date >= ?'); args.push(from); }
  if (to)    { where.push('entry_date <= ?'); args.push(to); }

  const sql = `
    SELECT * FROM ledger_entries
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY entry_date ASC, id ASC
  `;
  const [rows] = await pool.query(sql, args);
  const data = (rows as any[]).map((r, i) => ({ entry_number: i + 1, ...r }));
  return res.json({ count: data.length, data });
});

/**
 * POST /api/buku-besar/rebuild
 * Manually trigger a full rebuild of `ledger_entries` from purchasing/processing/selling.
 * Useful when source data was modified out-of-band (e.g., via Laravel API).
 */
router.post('/rebuild', authenticate, async (_req: Request, res: Response) => {
  try {
    const result = await ledger.rebuild();
    return res.json({ message: 'Ledger rebuilt successfully', ...result });
  } catch (err: any) {
    return res.status(500).json({ message: 'Rebuild failed', error: err.message });
  }
});

/**
 * GET /api/buku-besar/summary?year=2025&month=6
 * Period summary: BoP/EoP, totals, margin.
 * Reads the pre-computed period accumulators from the last entry in the period.
 */
router.get('/summary', authenticate, async (req: Request, res: Response) => {
  const year  = req.query.year  ? Number(req.query.year)  : undefined;
  const month = req.query.month ? Number(req.query.month) : undefined;
  if (!year) return res.status(422).json({ message: 'year is required' });

  const where: string[] = ['year = ?'];
  const args: any[] = [year];
  if (month) { where.push('month = ?'); args.push(month); }

  const [rows] = await pool.query(
    `SELECT * FROM ledger_entries WHERE ${where.join(' AND ')} ORDER BY entry_date DESC, id DESC LIMIT 1`,
    args
  );
  const list = rows as any[];
  if (!list.length) return res.json({ message: 'No entries in this period', data: null });

  const last = list[0];
  return res.json({
    year, month: month ?? null,
    fresh_bean: {
      bop_stock:  last.bop_stock_fresh_bean,
      bop_value:  last.bop_value_fresh_bean,
      eop_stock:  last.eop_stock_fresh_bean,
      eop_value:  last.eop_value_fresh_bean,
      purchasing_value: last.purchasing_value_fresh_bean,
      cogm:       last.cogm_fresh_bean,
      value_available: last.value_available_fresh_bean,
    },
    dried_bean: {
      bop_stock:  last.bop_stock_dried_bean,
      bop_value:  last.bop_value_dried_bean,
      eop_stock:  last.eop_stock_dried_bean,
      eop_value:  last.eop_value_dried_bean,
      cogs:       last.cogs_dried_bean,
      value_available: last.value_available_dried_bean,
    },
  });
});

export default router;
