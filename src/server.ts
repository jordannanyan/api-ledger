import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

import authRoutes                   from './routes/auth';
import purchasingRoutes             from './routes/purchasing';
import sellingRoutes                from './routes/selling';
import processingRoutes             from './routes/processing';
import bukuBesarRoutes              from './routes/bukuBesar';
import commoditiesRoutes            from './routes/commodities';
import gradesRoutes                 from './routes/grades';
import sapropdiRoutes               from './routes/sapropdi';
import entitiesRoutes               from './routes/entities';
import kthRoutes                    from './routes/kth';
import offtakersRoutes              from './routes/offtakers';
import warehousesRoutes             from './routes/warehouses';
import farmersRoutes                from './routes/farmers';
import plotsRoutes                  from './routes/plots';
import treesRoutes                  from './routes/trees';
import treeMonitoringRoutes,
       { subRouter as treeMonSubRoutes } from './routes/treeMonitoring';
import dailyPurchasingPriceRoutes   from './routes/dailyPurchasingPrice';
import dailySellingPriceRoutes      from './routes/dailySellingPrice';
import distributedSapropdiRoutes    from './routes/distributedSapropdi';
import dashboardRoutes              from './routes/dashboard';
import salesDetailRoutes            from './routes/salesDetail';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files. Default `/storage/proofs`; sibling dirs used for other types.
const uploadPath = process.env.UPLOAD_PATH || './storage/proofs';
const publicBase = process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs';
const storageRoot = path.resolve(uploadPath, '..'); // parent of /proofs
app.use(publicBase, express.static(path.resolve(uploadPath)));
// Other upload subdirs: farmers_photos, trees, tree_monitorings, sapropdi_proofs
const storageBase = publicBase.replace(/\/proofs$/, '');
app.use(`${storageBase}/farmers_photos`,  express.static(path.join(storageRoot, 'farmers_photos')));
app.use(`${storageBase}/trees`,           express.static(path.join(storageRoot, 'trees')));
app.use(`${storageBase}/tree_monitorings`, express.static(path.join(storageRoot, 'tree_monitorings')));
app.use(`${storageBase}/sapropdi_proofs`, express.static(path.join(storageRoot, 'sapropdi_proofs')));

// Health
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'traceability-api-ts', ts: new Date().toISOString() }));

// Auth + me + logout
app.use('/api', authRoutes);

// Buku besar feature
app.use('/api/purchasing',     purchasingRoutes);
app.use('/api/selling',        sellingRoutes);
app.use('/api/processing',     processingRoutes);
app.use('/api/buku-besar',     bukuBesarRoutes);

// Master data (full CRUD)
app.use('/api/commodities',                  commoditiesRoutes);
app.use('/api/grades',                       gradesRoutes);
app.use('/api/sapropdi',                     sapropdiRoutes);
app.use('/api/entities',                     entitiesRoutes);
app.use('/api/kth',                          kthRoutes);
app.use('/api/offtakers',                    offtakersRoutes);
app.use('/api/warehouses',                   warehousesRoutes);
app.use('/api/farmers',                      farmersRoutes);
app.use('/api/plots',                        plotsRoutes);
app.use('/api/daily-purchasing-prices',      dailyPurchasingPriceRoutes);
app.use('/api/daily-selling-prices',         dailySellingPriceRoutes);
app.use('/api/distributed-sapropdi',         distributedSapropdiRoutes);

// Trees + tree monitoring (sub-router under /api/trees/:treeId/monitorings)
app.use('/api/trees/:treeId/monitorings', treeMonSubRoutes);
app.use('/api/trees',                     treesRoutes);
app.use('/api/tree-monitorings',          treeMonitoringRoutes);

// Aggregations
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/sales-detail',  salesDetailRoutes);

// 404
app.use((req, res) => res.status(404).json({ message: `Not found: ${req.method} ${req.path}` }));

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

const PORT = Number(process.env.PORT || 3001);
app.listen(PORT, () => {
  console.log(`✓ traceability-api-ts listening on http://localhost:${PORT}`);
});

export default app;
