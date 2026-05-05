import dotenv from 'dotenv';
dotenv.config();

import LedgerComputeService from '../services/LedgerComputeService';
import pool from '../db/connection';

async function main() {
  const t0 = Date.now();
  console.log('[rebuildLedger] starting full rebuild...');
  const svc = new LedgerComputeService();
  const result = await svc.rebuild();
  const ms = Date.now() - t0;
  console.log(`[rebuildLedger] done. inserted=${result.inserted} took=${ms}ms`);
  await pool.end();
}

main().catch(err => {
  console.error('[rebuildLedger] FAILED:', err);
  process.exit(1);
});
