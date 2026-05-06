import { Router, Request, Response } from 'express';
import pool from '../db/connection';
import { authenticate } from '../middleware/auth';

export const router = Router();

/**
 * Plot CRUD + plot_commodities + plot_polygon_points + polygon WKT.
 * Polygon column type is `POLYGON`. We round-trip via ST_GeomFromText / ST_AsText.
 *
 * Payload supports two ways to define polygon:
 *   1. `polygon` — raw WKT, e.g. "POLYGON((lng lat, lng lat, ...))"
 *   2. `points` — array of {seq, latitude, longitude, captured_at, accuracy_m?, source?}
 *      → polygon WKT auto-built from points (closed ring).
 * If `points` provided, `polygon` is ignored.
 */

const POLYGON_WKT_RE = /^\s*POLYGON\s*\(\s*\(.*\)\s*\)\s*$/i;

function buildPolygonWktFromPoints(points: any[]): string | null {
  const valid = points.filter(p => p.latitude != null && p.longitude != null);
  if (valid.length < 3) return null;
  const coords = valid.map(p => `${Number(p.longitude)} ${Number(p.latitude)}`);
  coords.push(coords[0]); // close the ring
  return `POLYGON((${coords.join(', ')}))`;
}

async function fetchPlotFull(id: number): Promise<any | null> {
  const [plotRows] = await pool.query(
    `SELECT p.*, ST_AsText(p.polygon) AS polygon_wkt,
            f.id AS farmer__id, f.farmer_name AS farmer__farmer_name, f.kth_id AS farmer__kth_id,
            k.id AS farmer__kth__id, k.kth_name AS farmer__kth__kth_name, k.entities_id AS farmer__kth__entities_id
     FROM plot p
     LEFT JOIN farmers f ON f.id = p.farmer_id
     LEFT JOIN kth k     ON k.id = f.kth_id
     WHERE p.id = ?`,
    [id]
  );
  const list = plotRows as any[];
  if (!list.length) return null;
  const row = list[0];
  delete row.polygon;

  const out: any = {};
  const farmer: any = {}; const kth: any = {};
  for (const k of Object.keys(row)) {
    if (k.startsWith('farmer__kth__')) kth[k.slice('farmer__kth__'.length)] = row[k];
    else if (k.startsWith('farmer__')) farmer[k.slice('farmer__'.length)]   = row[k];
    else                               out[k] = row[k];
  }
  if (farmer.id) {
    if (kth.id) farmer.kth = kth;
    out.farmer = farmer;
  } else out.farmer = null;

  // Load commodities
  const [comRows] = await pool.query(
    `SELECT pc.id, pc.plot_id, pc.commodities_id, pc.number_of_plants,
            c.id AS commodity__id, c.commodities_name AS commodity__commodities_name
     FROM plot_commodities pc
     LEFT JOIN commodities c ON c.id = pc.commodities_id
     WHERE pc.plot_id = ?`,
    [id]
  );
  out.commodities = (comRows as any[]).map(r => {
    const co: any = { id: r.id, plot_id: r.plot_id, commodities_id: r.commodities_id, number_of_plants: r.number_of_plants };
    if (r.commodity__id) co.commodity = { id: r.commodity__id, commodities_name: r.commodity__commodities_name };
    return co;
  });

  // Load polygon points
  const [ptRows] = await pool.query(
    'SELECT * FROM plot_polygon_points WHERE plot_id = ? ORDER BY seq ASC',
    [id]
  );
  out.polygon_points = ptRows;

  return out;
}

async function syncCommodities(plotId: number, commodities: any[], merge = false): Promise<void> {
  if (!merge) {
    await pool.query('DELETE FROM plot_commodities WHERE plot_id = ?', [plotId]);
  }
  for (const c of commodities) {
    if (!c.commodities_id) continue;
    await pool.query(
      `INSERT INTO plot_commodities (plot_id, commodities_id, number_of_plants, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE number_of_plants = VALUES(number_of_plants), updated_at = NOW()`,
      [plotId, Number(c.commodities_id), c.number_of_plants != null ? Number(c.number_of_plants) : null]
    );
  }
}

async function replacePolygonPoints(plotId: number, points: any[]): Promise<void> {
  await pool.query('DELETE FROM plot_polygon_points WHERE plot_id = ?', [plotId]);
  for (const p of points) {
    await pool.query(
      `INSERT INTO plot_polygon_points
        (plot_id, seq, latitude, longitude, photo_path, captured_at, accuracy_m, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        plotId,
        Number(p.seq),
        Number(p.latitude),
        Number(p.longitude),
        p.photo_path ?? null,
        p.captured_at ?? null,
        p.accuracy_m != null ? Number(p.accuracy_m) : null,
        p.source || 'mobile',
      ]
    );
  }
}

async function applyPolygonWkt(plotId: number, wkt: string | null): Promise<void> {
  if (!wkt) {
    await pool.query('UPDATE plot SET polygon = NULL, updated_at = NOW() WHERE id = ?', [plotId]);
    return;
  }
  await pool.query('UPDATE plot SET polygon = ST_GeomFromText(?), updated_at = NOW() WHERE id = ?', [wkt, plotId]);
}

function validatePoints(points: any[]): { ok: boolean; sorted?: any[]; error?: string } {
  if (!Array.isArray(points) || points.length < 3) return { ok: false, error: 'points must have ≥ 3 entries' };
  for (const p of points) {
    if (!p.seq || !p.captured_at) return { ok: false, error: 'each point needs seq and captured_at' };
    if (p.latitude == null || p.longitude == null) return { ok: false, error: 'each point needs latitude and longitude' };
    if (Number(p.latitude) < -90 || Number(p.latitude) > 90) return { ok: false, error: 'latitude out of range' };
    if (Number(p.longitude) < -180 || Number(p.longitude) > 180) return { ok: false, error: 'longitude out of range' };
  }
  const seqs = points.map(p => Number(p.seq));
  if (new Set(seqs).size !== seqs.length) return { ok: false, error: 'duplicate seq' };
  const sorted = [...points].sort((a, b) => Number(a.seq) - Number(b.seq));
  return { ok: true, sorted };
}

// =============================================================================
// Routes
// =============================================================================

router.get('/', authenticate, async (req: Request, res: Response) => {
  const entitiesId = req.query.entities_id as string | undefined;
  const where: string[] = [];
  const args: any[] = [];
  if (entitiesId) { where.push('k.entities_id = ?'); args.push(entitiesId); }

  const [rows] = await pool.query(
    `SELECT p.id FROM plot p
     LEFT JOIN farmers f ON f.id = p.farmer_id
     LEFT JOIN kth k     ON k.id = f.kth_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.plot_name`,
    args
  );
  const data = await Promise.all((rows as any[]).map(r => fetchPlotFull(r.id)));
  return res.json({ status: 'success', data });
});

router.get('/by-kth/:kth_id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query(
    `SELECT p.id FROM plot p
     LEFT JOIN farmers f ON f.id = p.farmer_id
     WHERE f.kth_id = ?`,
    [req.params.kth_id]
  );
  if (!(rows as any[]).length) return res.status(404).json({ status: 'error', message: 'No plots found for the specified KTH ID.' });
  const data = await Promise.all((rows as any[]).map(r => fetchPlotFull(r.id)));
  return res.json({ status: 'success', data });
});

router.get('/by-farmer/:farmer_id', authenticate, async (req: Request, res: Response) => {
  const [rows] = await pool.query('SELECT id FROM plot WHERE farmer_id = ?', [req.params.farmer_id]);
  if (!(rows as any[]).length) return res.status(404).json({ status: 'error', message: 'No plots found for the specified farmer_id.' });
  const data = await Promise.all((rows as any[]).map(r => fetchPlotFull(r.id)));
  return res.json({ status: 'success', data });
});

router.get('/:id', authenticate, async (req: Request, res: Response) => {
  const data = await fetchPlotFull(Number(req.params.id));
  if (!data) return res.status(404).json({ message: 'Plot not found' });
  return res.json({ message: 'Plot fetched successfully', data });
});

router.post('/', authenticate, async (req: Request, res: Response) => {
  const b = req.body || {};
  if (!b.farmer_id) return res.status(422).json({ message: 'farmer_id is required' });

  const [result] = await pool.query(
    `INSERT INTO plot (plot_name, land_area, latitude, longitude, farmer_id, number_of_plants, exp_cin_plants, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [
      b.plot_name ?? null,
      b.land_area != null ? Number(b.land_area) : null,
      b.latitude != null ? Number(b.latitude) : null,
      b.longitude != null ? Number(b.longitude) : null,
      Number(b.farmer_id),
      b.number_of_plants != null ? Number(b.number_of_plants) : null,
      b.exp_cin_plants != null ? Number(b.exp_cin_plants) : null,
    ]
  );
  const plotId = (result as any).insertId;

  if (Array.isArray(b.commodities) && b.commodities.length) {
    await syncCommodities(plotId, b.commodities);
  }

  let wkt: string | null = null;
  if (Array.isArray(b.points) && b.points.length) {
    const v = validatePoints(b.points);
    if (!v.ok) return res.status(422).json({ message: v.error });
    await replacePolygonPoints(plotId, v.sorted!);
    wkt = buildPolygonWktFromPoints(v.sorted!);
  } else if (typeof b.polygon === 'string' && b.polygon.trim()) {
    if (!POLYGON_WKT_RE.test(b.polygon)) return res.status(422).json({ message: 'Invalid polygon WKT. Expect: POLYGON((lng lat, ...))' });
    wkt = b.polygon.trim();
  }
  if (wkt) await applyPolygonWkt(plotId, wkt);

  const data = await fetchPlotFull(plotId);
  return res.status(201).json({ message: 'Plot created successfully', data });
});

router.put('/:id', authenticate, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const [exists] = await pool.query('SELECT id FROM plot WHERE id = ?', [id]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Plot not found' });

  const b = req.body || {};
  const updates: Record<string, any> = {};
  const set = (k: string, v: any) => { if (v !== undefined) updates[k] = v; };
  set('plot_name',        b.plot_name);
  set('land_area',        b.land_area != null ? Number(b.land_area) : undefined);
  set('latitude',         b.latitude != null ? Number(b.latitude) : undefined);
  set('longitude',        b.longitude != null ? Number(b.longitude) : undefined);
  set('farmer_id',        b.farmer_id != null ? Number(b.farmer_id) : undefined);
  set('number_of_plants', b.number_of_plants != null ? Number(b.number_of_plants) : undefined);
  set('exp_cin_plants',   b.exp_cin_plants != null ? Number(b.exp_cin_plants) : undefined);

  const keys = Object.keys(updates);
  if (keys.length) {
    keys.push('updated_at'); updates.updated_at = new Date();
    await pool.query(
      `UPDATE plot SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`,
      [...keys.map(k => updates[k]), id]
    );
  }

  if (Array.isArray(b.commodities)) {
    await syncCommodities(id, b.commodities, !!b.commodities_merge);
  }

  if (Array.isArray(b.points)) {
    const v = validatePoints(b.points);
    if (!v.ok) return res.status(422).json({ message: v.error });
    await replacePolygonPoints(id, v.sorted!);
    await applyPolygonWkt(id, buildPolygonWktFromPoints(v.sorted!));
  } else if (b.polygon !== undefined) {
    if (b.polygon === null || b.polygon === '') {
      await applyPolygonWkt(id, null);
    } else {
      if (typeof b.polygon !== 'string' || !POLYGON_WKT_RE.test(b.polygon)) {
        return res.status(422).json({ message: 'Invalid polygon WKT. Expect: POLYGON((lng lat, ...))' });
      }
      await applyPolygonWkt(id, b.polygon.trim());
    }
  }

  const data = await fetchPlotFull(id);
  return res.json({ message: 'Plot updated successfully', data });
});

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const [result] = await pool.query('DELETE FROM plot WHERE id = ?', [req.params.id]);
  if (!(result as any).affectedRows) return res.status(404).json({ message: 'Plot not found' });
  return res.json({ message: 'Plot deleted successfully' });
});

// -----------------------------------------------------------------------------
// Polygon points sub-routes
// -----------------------------------------------------------------------------
router.get('/:plotId/polygon-points', authenticate, async (req: Request, res: Response) => {
  const [exists] = await pool.query('SELECT id FROM plot WHERE id = ?', [req.params.plotId]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Plot not found' });
  const [rows] = await pool.query(
    'SELECT * FROM plot_polygon_points WHERE plot_id = ? ORDER BY seq ASC',
    [req.params.plotId]
  );
  return res.json({ status: 'success', data: rows });
});

router.put('/:plotId/polygon-points', authenticate, async (req: Request, res: Response) => {
  const plotId = Number(req.params.plotId);
  const [exists] = await pool.query('SELECT id FROM plot WHERE id = ?', [plotId]);
  if (!(exists as any[]).length) return res.status(404).json({ message: 'Plot not found' });

  const v = validatePoints(req.body?.points || []);
  if (!v.ok) return res.status(422).json({ message: v.error });

  await replacePolygonPoints(plotId, v.sorted!);
  await applyPolygonWkt(plotId, buildPolygonWktFromPoints(v.sorted!));
  const data = await fetchPlotFull(plotId);
  return res.json({ message: 'Polygon points replaced successfully', data });
});

export default router;
