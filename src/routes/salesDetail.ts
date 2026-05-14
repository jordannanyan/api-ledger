import { Router, Request, Response } from 'express';
import pool from '../db/connection';

export const router = Router();

/**
 * GET /api/sales-detail/:id  — mirrors Laravel SalesDetailController.show().
 * Public endpoint (matches Laravel routes — outside auth middleware group).
 * Returns the selling record + offtaker + kth (via warehouse) + all farmers
 * whose plots have purchasing records into the same warehouse, plus their plots.
 */
router.get('/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  try {
    const [sellRows] = await pool.query(
      `SELECT s.*,
              o.offtaker_name AS offtaker_name,
              k.kth_name AS kth_name,
              c.commodities_name AS commodity_name,
              g.grade_name AS grade_name
       FROM selling s
       LEFT JOIN offtaker o    ON o.id = s.offtaker_id
       LEFT JOIN warehouse w   ON w.id = s.warehouse_id
       LEFT JOIN kth k         ON k.id = w.kth_id
       LEFT JOIN commodities c ON c.id = s.commodities_id
       LEFT JOIN grade g       ON g.id = s.grade_id
       WHERE s.id = ?`,
      [id]
    );
    const sellList = sellRows as any[];
    if (!sellList.length) return res.status(404).json({ message: 'Selling record not found' });
    const selling = sellList[0];

    // Find unique farmer IDs from purchasing rows for this warehouse
    const [farmerRows] = await pool.query(
      `SELECT DISTINCT pl.farmer_id AS farmer_id
       FROM purchasing p
       LEFT JOIN plot pl ON pl.id = p.plot_id
       WHERE p.warehouse_id = ? AND pl.farmer_id IS NOT NULL`,
      [selling.warehouse_id]
    );
    const farmerIds = (farmerRows as any[]).map(r => r.farmer_id);

    let farmers: any[] = [];
    if (farmerIds.length) {
      const placeholders = farmerIds.map(() => '?').join(',');
      const [fRows] = await pool.query(
        `SELECT * FROM farmers WHERE id IN (${placeholders})`,
        farmerIds
      );
      farmers = fRows as any[];
      for (const f of farmers) delete f.password;

      const [plotRows] = await pool.query(
        `SELECT * FROM plot WHERE farmer_id IN (${placeholders})`,
        farmerIds
      );
      const plotsByFarmer = new Map<number, any[]>();
      for (const pl of plotRows as any[]) {
        if (!plotsByFarmer.has(pl.farmer_id)) plotsByFarmer.set(pl.farmer_id, []);
        plotsByFarmer.get(pl.farmer_id)!.push(pl);
      }
      for (const f of farmers) f.plots = plotsByFarmer.get(f.id) || [];
    }

    return res.json({
      message: 'Sales detail fetched successfully',
      data: {
        selling: {
          date:            selling.date,
          commodity:       selling.commodity_name,
          grade:           selling.grade_name,
          quantity:        selling.quantity,
          total_net_sales: selling.total_net_sales,
        },
        offtaker_name: selling.offtaker_name,
        kth_name:      selling.kth_name,
        farmers,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: 'An error occurred while retrieving the sales detail', error: err.message });
  }
});

export default router;
