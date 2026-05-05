import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

import authRoutes        from './routes/auth';
import purchasingRoutes  from './routes/purchasing';
import sellingRoutes     from './routes/selling';
import processingRoutes  from './routes/processing';
import bukuBesarRoutes   from './routes/bukuBesar';
import masterDataRoutes  from './routes/masterData';

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files at the configured public path (default /storage/proofs)
const uploadPath = process.env.UPLOAD_PATH || './storage/proofs';
const publicBase = process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs';
app.use(publicBase, express.static(path.resolve(uploadPath)));

// Healthcheck
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'traceability-api-ts', ts: new Date().toISOString() }));

// Mount routes
app.use('/api',                authRoutes);          // /api/login/entity, /api/me, /api/logout, ...
app.use('/api/purchasing',     purchasingRoutes);
app.use('/api/selling',        sellingRoutes);
app.use('/api/processing',     processingRoutes);
app.use('/api/buku-besar',     bukuBesarRoutes);
app.use('/api',                masterDataRoutes);    // /api/commodities, /api/grades, /api/farmers, ...

// 404 fallback
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
