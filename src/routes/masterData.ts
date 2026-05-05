import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

/**
 * Read-only endpoints for spreadsheet dropdowns / lookups.
 * Phase 1 deliberately exposes READ only — full CRUD lives in Laravel for now.
 *
 * All endpoints accept ?entities_id= to filter by entity scope where applicable.
 */
export const router = Router();

// Commodities
router.get('/commodities', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT id, commodities_name FROM commodities ORDER BY commodities_name');
  return res.json(rows);
});

// Grades
router.get('/grades', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT id, grade_name FROM grade ORDER BY grade_name');
  return res.json(rows);
});

// Sapropdi (saprodi)
router.get('/sapropdi', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT id, sapropdi_name, unit FROM sapropdi ORDER BY sapropdi_name');
  return res.json(rows);
});

// Warehouses (filterable by entities_id via kth)
router.get('/warehouses', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = `
    SELECT w.id, w.warehouse_name, w.address, w.kth_id, k.kth_name, k.entities_id
    FROM warehouse w
    LEFT JOIN kth k ON k.id = w.kth_id
  `;
  const args: any[] = [];
  if (entitiesId) { sql += ' WHERE k.entities_id = ?'; args.push(entitiesId); }
  sql += ' ORDER BY w.warehouse_name';
  const [rows] = await pool.query(sql, args);
  return res.json(rows);
});

// Offtakers (filterable by entities_id)
router.get('/offtakers', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = 'SELECT id, offtaker_name, location, entities_id FROM offtaker';
  const args: any[] = [];
  if (entitiesId) { sql += ' WHERE entities_id = ?'; args.push(entitiesId); }
  sql += ' ORDER BY offtaker_name';
  const [rows] = await pool.query(sql, args);
  return res.json(rows);
});

// KTH (filterable by entities_id)
router.get('/kth', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  let sql = 'SELECT id, kth_name, address, regency, partnership_period, entities_id FROM kth';
  const args: any[] = [];
  if (entitiesId) { sql += ' WHERE entities_id = ?'; args.push(entitiesId); }
  sql += ' ORDER BY kth_name';
  const [rows] = await pool.query(sql, args);
  return res.json(rows);
});

// Farmers (filterable by entities_id via kth)
router.get('/farmers', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  const kthId = req.query.kth_id as string | undefined;
  let sql = `
    SELECT f.id, f.farmer_name, f.no_hp, f.nik, f.address, f.kth_id, k.kth_name, k.entities_id
    FROM farmers f
    LEFT JOIN kth k ON k.id = f.kth_id
  `;
  const where: string[] = [];
  const args: any[] = [];
  if (entitiesId) { where.push('k.entities_id = ?'); args.push(entitiesId); }
  if (kthId)      { where.push('f.kth_id = ?');     args.push(kthId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY f.farmer_name';
  const [rows] = await pool.query(sql, args);
  return res.json(rows);
});

// Plots (filterable by entities_id, farmer_id)
router.get('/plots', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  const farmerId   = req.query.farmer_id   as string | undefined;
  let sql = `
    SELECT pl.id, pl.plot_name, pl.land_area, pl.number_of_plants, pl.farmer_id,
           f.farmer_name, f.kth_id, k.kth_name, k.entities_id
    FROM plot pl
    LEFT JOIN farmers f ON f.id = pl.farmer_id
    LEFT JOIN kth k     ON k.id = f.kth_id
  `;
  const where: string[] = [];
  const args: any[] = [];
  if (entitiesId) { where.push('k.entities_id = ?'); args.push(entitiesId); }
  if (farmerId)   { where.push('pl.farmer_id = ?');  args.push(farmerId); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY pl.plot_name';
  const [rows] = await pool.query(sql, args);
  return res.json(rows);
});

// Entities (typically just one — the logged-in user's entity)
router.get('/entities', authenticate, async (_req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT id, entities_name, location FROM entities ORDER BY entities_name');
  return res.json(rows);
});

export default router;
