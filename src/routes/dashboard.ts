import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

/**
 * Dashboard summary for an entity. Mirrors Laravel DashboardController.
 * Query: entityId or body.entityId
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
  const entityId = (req.query.entityId || req.body?.entityId) as string | undefined;
  try {
    let totalFarmers = 0, totalKth = 0;
    if (entityId) {
      const [fr] = await pool.query(
        'SELECT COUNT(*) AS total FROM farmers f JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ?',
        [entityId]
      );
      totalFarmers = Number((fr as any[])[0]?.total || 0);

      const [kr] = await pool.query('SELECT COUNT(*) AS total FROM kth WHERE entities_id = ?', [entityId]);
      totalKth = Number((kr as any[])[0]?.total || 0);
    }

    const [sp] = await pool.query('SELECT price FROM daily_selling_price ORDER BY date DESC, id DESC LIMIT 1');
    const [pp] = await pool.query('SELECT price FROM daily_purchasing_price ORDER BY date DESC, id DESC LIMIT 1');

    return res.json({
      total_farmers: totalFarmers,
      total_kth: totalKth,
      daily_selling_price: (sp as any[])[0]?.price ?? null,
      daily_purchasing_price: (pp as any[])[0]?.price ?? null,
    });
  } catch (err: any) {
    return res.status(500).json({ message: 'An error occurred while fetching dashboard data', error: err.message });
  }
});

router.get('/total-farmers', authenticate, async (req: Request, res: Response) => {
  const entityId = req.query.entityId as string | undefined;
  if (!entityId) return res.status(422).json({ message: 'entityId is required' });
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS total FROM farmers f JOIN kth k ON k.id = f.kth_id WHERE k.entities_id = ?',
    [entityId]
  );
  return res.json({ total_farmers: Number((rows as any[])[0]?.total || 0) });
});

router.get('/total-kth', authenticate, async (req: Request, res: Response) => {
  const entityId = req.query.entityId as string | undefined;
  if (!entityId) return res.status(422).json({ message: 'entityId is required' });
  const [rows] = await pool.query('SELECT COUNT(*) AS total FROM kth WHERE entities_id = ?', [entityId]);
  return res.json({ total_kth: Number((rows as any[])[0]?.total || 0) });
});

router.get('/daily-selling-price', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT price FROM daily_selling_price ORDER BY date DESC, id DESC LIMIT 1');
  return res.json({ daily_selling_price: (rows as any[])[0]?.price ?? null });
});

router.get('/daily-purchasing-price', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT price FROM daily_purchasing_price ORDER BY date DESC, id DESC LIMIT 1');
  return res.json({ daily_purchasing_price: (rows as any[])[0]?.price ?? null });
});

export default router;
