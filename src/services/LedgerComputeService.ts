import pool from '../db/connection';
import { PoolConnection } from 'mysql2/promise';

/**
 * LedgerComputeService
 * --------------------
 * Rebuilds `ledger_entries` from the source transactional tables:
 *   - purchasing  (Process = "Purchasing")
 *   - processing  (Process = "Processing")
 *   - selling     (Process = "Delivery")
 *
 * Accounting rules (weighted-average cost flow, mirrors SJ - Data Entry Dried Bean):
 *   Purchasing  (+Fresh Bean inflow)
 *     Δ fresh.volume += volume
 *     Δ fresh.value  += volume × purchase_price_per_kg
 *     fresh.avg       = fresh.value / fresh.volume
 *
 *   Processing  (Fresh → Dried; consumes Fresh, produces Dried)
 *     consumed.value  = volume_input × fresh.avg          (cost flow assumption)
 *     fresh.volume   -= volume_input
 *     fresh.value    -= consumed.value
 *     COGM            = consumed.value + total_processing_cost
 *     dried.volume   += volume_output (Net Processing Volume)
 *     dried.value    += COGM
 *
 *   Delivery  (-Dried Bean outflow)
 *     COGS            = volume × dried.avg                (cost flow assumption)
 *     dried.volume   -= volume
 *     dried.value    -= COGS
 *     ASP             = dried.avg (at time of sale)
 *     gross_margin    = offtake_value − COGS − total_delivery_cost − tax_pph
 *     gross_profit    = gross_margin / offtake_value      (ratio)
 *
 * BoP/EoP per (year, month) period:
 *   BoP = stock state right before first entry of the period (= prev period EoP)
 *   EoP = stock state after last entry of the period
 *   Both stamped on every row of the period.
 *
 * Strategy: full rebuild on each call.
 *   For ~3K rows this is fast (<200 ms) and trivially correct.
 *   Optimize later (incremental append / materialized) if data grows large.
 */
export class LedgerComputeService {
  async rebuild(): Promise<{ inserted: number }> {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const events = await this.collectSourceEvents(conn);
      const ledgerRows = this.computeLedger(events);

      await conn.query('DELETE FROM ledger_entries');
      if (ledgerRows.length) {
        await this.bulkInsert(conn, ledgerRows);
      }

      await conn.commit();
      return { inserted: ledgerRows.length };
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  // --------------------------------------------------------------------------
  // Step 1: Pull rows from purchasing/processing/selling and merge into a
  //         chronologically ordered list of "events".
  // --------------------------------------------------------------------------
  private async collectSourceEvents(conn: PoolConnection): Promise<RawEvent[]> {
    const [purRows] = await conn.query(`
      SELECT
        p.id, p.date, p.receipt_invoice, p.payment_status,
        p.quantity AS volume, p.price_per_kg, p.value_purchased,
        COALESCE(NULLIF(f.farmer_name, ''), k.kth_name) AS counterparty_name
      FROM purchasing p
      LEFT JOIN plot pl    ON pl.id = p.plot_id
      LEFT JOIN farmers f  ON f.id  = pl.farmer_id
      LEFT JOIN kth k      ON k.id  = f.kth_id
      WHERE p.date IS NOT NULL
    `);

    const [procRows] = await conn.query(`
      SELECT
        pr.id, pr.date, pr.receipt_invoice,
        pr.volume_input, pr.volume_output, pr.total_processing_cost,
        COALESCE(NULLIF(k.kth_name, ''), w.warehouse_name) AS counterparty_name
      FROM processing pr
      LEFT JOIN warehouse w ON w.id = pr.warehouse_id
      LEFT JOIN kth k       ON k.id = w.kth_id
      WHERE pr.date IS NOT NULL
    `);

    const [selRows] = await conn.query(`
      SELECT
        s.id, s.date, s.receipt_invoice,
        s.quantity AS volume, s.price_per_kg, s.total_price,
        s.cost_packing, s.cost_loading, s.cost_transport,
        s.cost_consumption, s.cost_other, s.total_delivery_cost, s.tax_pph,
        o.offtaker_name AS counterparty_name
      FROM selling s
      LEFT JOIN offtaker o ON o.id = s.offtaker_id
      WHERE s.date IS NOT NULL
    `);

    const events: RawEvent[] = [];
    for (const r of purRows as any[])  events.push({ kind: 'Purchasing', source: r });
    for (const r of procRows as any[]) events.push({ kind: 'Processing', source: r });
    for (const r of selRows as any[])  events.push({ kind: 'Delivery',   source: r });

    // Stable order: by date, then source id, then kind priority (Purchasing → Processing → Delivery)
    const kindOrder = { Purchasing: 0, Processing: 1, Delivery: 2 } as const;
    events.sort((a, b) => {
      const da = String(a.source.date), db = String(b.source.date);
      if (da !== db) return da < db ? -1 : 1;
      if (a.kind !== b.kind) return kindOrder[a.kind] - kindOrder[b.kind];
      return Number(a.source.id) - Number(b.source.id);
    });

    return events;
  }

  // --------------------------------------------------------------------------
  // Step 2: Walk events in order, maintain running state, emit ledger rows.
  // --------------------------------------------------------------------------
  private computeLedger(events: RawEvent[]): LedgerRow[] {
    const rows: LedgerRow[] = [];

    let freshVol = 0, freshVal = 0;
    let driedVol = 0, driedVal = 0;

    let currentPeriod = '';
    let bopFreshVol = 0, bopFreshVal = 0;
    let bopDriedVol = 0, bopDriedVal = 0;
    let cumPurchaseFresh = 0, cumPurchaseDried = 0;
    let cumCogs = 0, cumCogm = 0;

    // Group entries by period for EoP back-fill (pass 2)
    const periodIndex = new Map<string, number[]>();

    for (const ev of events) {
      const date = String(ev.source.date).slice(0, 10);
      const [yy, mm] = date.split('-').map(Number);
      const period = `${yy}-${mm}`;

      if (period !== currentPeriod) {
        bopFreshVol = freshVol;
        bopFreshVal = freshVal;
        bopDriedVol = driedVol;
        bopDriedVal = driedVal;
        cumPurchaseFresh = 0;
        cumPurchaseDried = 0;
        cumCogs = 0;
        cumCogm = 0;
        currentPeriod = period;
      }

      const row: LedgerRow = blankRow(yy, mm, date, ev.kind);
      row.counterparty_name = ev.source.counterparty_name ?? null;
      row.receipt_invoice   = ev.source.receipt_invoice   ?? null;

      if (ev.kind === 'Purchasing') {
        const s = ev.source;
        row.purchasing_id = s.id;
        row.payment_status = s.payment_status ?? null;
        row.bean_type = 'Fresh Bean';
        row.volume                = num(s.volume);
        row.purchase_price_per_kg = num(s.price_per_kg);
        row.purchase_value        = num(s.value_purchased) || row.volume * row.purchase_price_per_kg;

        freshVol += row.volume;
        freshVal += row.purchase_value;
        cumPurchaseFresh += row.purchase_value;
      } else if (ev.kind === 'Processing') {
        const s = ev.source;
        row.processing_id = s.id;
        row.bean_type = 'Dried Bean';
        row.volume                = num(s.volume_input);
        row.net_processing_volume = num(s.volume_output);
        row.total_processing_cost = num(s.total_processing_cost);
        row.processing_cost_per_kg = row.volume > 0 ? row.total_processing_cost / row.volume : 0;

        const avgFresh = freshVol > 0 ? freshVal / freshVol : 0;
        const consumedValue = row.volume * avgFresh;
        freshVol = clamp0(freshVol - row.volume);
        freshVal = clamp0(freshVal - consumedValue);

        const cogm = consumedValue + row.total_processing_cost;
        driedVol += row.net_processing_volume;
        driedVal += cogm;
        cumCogm += cogm;
      } else { // Delivery
        const s = ev.source;
        row.selling_id = s.id;
        row.bean_type = 'Dried Bean';
        row.volume                = num(s.volume);
        row.net_delivery_volume   = row.volume;
        row.offtake_price_per_kg  = num(s.price_per_kg);
        row.offtake_value         = num(s.total_price) || row.volume * row.offtake_price_per_kg;
        row.cost_packing          = num(s.cost_packing);
        row.cost_loading          = num(s.cost_loading);
        row.cost_transport        = num(s.cost_transport);
        row.cost_consumption      = num(s.cost_consumption);
        row.cost_other            = num(s.cost_other);
        row.total_delivery_cost   = num(s.total_delivery_cost) ||
          (row.cost_packing + row.cost_loading + row.cost_transport + row.cost_consumption + row.cost_other);
        row.tax_pph               = num(s.tax_pph);

        const avgDried = driedVol > 0 ? driedVal / driedVol : 0;
        const cogs = row.volume * avgDried;
        driedVol = clamp0(driedVol - row.volume);
        driedVal = clamp0(driedVal - cogs);

        row.delivery_asp_dried_bean      = avgDried;
        row.gross_cash_margin_dried_bean = row.offtake_value - cogs - row.total_delivery_cost - row.tax_pph;
        row.gross_cash_profit_dried_bean = row.offtake_value > 0
          ? row.gross_cash_margin_dried_bean / row.offtake_value
          : 0;
        cumCogs += cogs;
      }

      // Snapshot running balance AFTER this entry
      row.fresh_bean_volume          = round3(freshVol);
      row.fresh_bean_value           = round2(freshVal);
      row.fresh_bean_avg_stock_price = freshVol > 0 ? round2(freshVal / freshVol) : 0;
      row.dried_bean_volume          = round3(driedVol);
      row.dried_bean_value           = round2(driedVal);
      row.dried_bean_avg_stock_price = driedVol > 0 ? round2(driedVal / driedVol) : 0;

      // BoP fixed for the period
      row.bop_stock_fresh_bean = round3(bopFreshVol);
      row.bop_value_fresh_bean = round2(bopFreshVal);
      row.bop_stock_dried_bean = round3(bopDriedVol);
      row.bop_value_dried_bean = round2(bopDriedVal);

      // EoP placeholder = current; real EoP back-filled below
      row.eop_stock_fresh_bean = row.fresh_bean_volume;
      row.eop_value_fresh_bean = row.fresh_bean_value;
      row.eop_stock_dried_bean = row.dried_bean_volume;
      row.eop_value_dried_bean = row.dried_bean_value;

      row.purchasing_value_fresh_bean = round2(cumPurchaseFresh);
      row.purchasing_value_dried_bean = round2(cumPurchaseDried);
      row.cogs_dried_bean             = round2(cumCogs);
      row.cogm_fresh_bean             = round2(cumCogm);
      row.value_available_dried_bean  = round2(bopDriedVal + cumCogm);
      row.value_available_fresh_bean  = round2(bopFreshVal + cumPurchaseFresh);

      rows.push(row);

      const idx = rows.length - 1;
      if (!periodIndex.has(period)) periodIndex.set(period, []);
      periodIndex.get(period)!.push(idx);
    }

    // Pass 2: back-fill EoP — last entry of each period holds the canonical EoP
    for (const idxs of periodIndex.values()) {
      const last = rows[idxs[idxs.length - 1]];
      const eopFV = last.eop_stock_fresh_bean;
      const eopFVal = last.eop_value_fresh_bean;
      const eopDV = last.eop_stock_dried_bean;
      const eopDVal = last.eop_value_dried_bean;
      for (const i of idxs) {
        rows[i].eop_stock_fresh_bean = eopFV;
        rows[i].eop_value_fresh_bean = eopFVal;
        rows[i].eop_stock_dried_bean = eopDV;
        rows[i].eop_value_dried_bean = eopDVal;
      }
    }

    return rows;
  }

  // --------------------------------------------------------------------------
  // Step 3: Bulk insert ledger rows (chunked for safety).
  // --------------------------------------------------------------------------
  private async bulkInsert(conn: PoolConnection, rows: LedgerRow[]): Promise<void> {
    const cols = Object.keys(rows[0]);
    const placeholders = `(${cols.map(() => '?').join(',')})`;
    const chunkSize = 200;

    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      const values: any[] = [];
      for (const r of chunk) for (const c of cols) values.push((r as any)[c]);
      const sql = `INSERT INTO ledger_entries (${cols.map(c => `\`${c}\``).join(',')}) VALUES ${chunk.map(() => placeholders).join(',')}`;
      await conn.query(sql, values);
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================
type ProcessKind = 'Purchasing' | 'Processing' | 'Delivery';
interface RawEvent { kind: ProcessKind; source: any; }

interface LedgerRow {
  year: number; month: number; entry_date: string; process: ProcessKind;
  purchasing_id: number | null; processing_id: number | null; selling_id: number | null;
  counterparty_name: string | null; receipt_invoice: string | null; payment_status: string | null;
  bean_type: 'Fresh Bean' | 'Dried Bean' | null;
  volume: number; purchase_price_per_kg: number; purchase_value: number;
  net_processing_volume: number; processing_cost_per_kg: number; total_processing_cost: number;
  net_delivery_volume: number; offtake_price_per_kg: number; offtake_value: number;
  cost_packing: number; cost_loading: number; cost_transport: number;
  cost_consumption: number; cost_other: number; total_delivery_cost: number; tax_pph: number;
  fresh_bean_volume: number; fresh_bean_value: number; fresh_bean_avg_stock_price: number;
  dried_bean_volume: number; dried_bean_value: number; dried_bean_avg_stock_price: number;
  delivery_asp_dried_bean: number; gross_cash_margin_dried_bean: number; gross_cash_profit_dried_bean: number;
  bop_stock_fresh_bean: number; bop_value_fresh_bean: number;
  eop_stock_fresh_bean: number; eop_value_fresh_bean: number;
  bop_stock_dried_bean: number; bop_value_dried_bean: number;
  eop_stock_dried_bean: number; eop_value_dried_bean: number;
  purchasing_value_fresh_bean: number; purchasing_value_dried_bean: number;
  cogs_dried_bean: number; value_available_dried_bean: number;
  cogm_fresh_bean: number; value_available_fresh_bean: number;
}

function blankRow(year: number, month: number, entry_date: string, process: ProcessKind): LedgerRow {
  return {
    year, month, entry_date, process,
    purchasing_id: null, processing_id: null, selling_id: null,
    counterparty_name: null, receipt_invoice: null, payment_status: null, bean_type: null,
    volume: 0, purchase_price_per_kg: 0, purchase_value: 0,
    net_processing_volume: 0, processing_cost_per_kg: 0, total_processing_cost: 0,
    net_delivery_volume: 0, offtake_price_per_kg: 0, offtake_value: 0,
    cost_packing: 0, cost_loading: 0, cost_transport: 0, cost_consumption: 0, cost_other: 0,
    total_delivery_cost: 0, tax_pph: 0,
    fresh_bean_volume: 0, fresh_bean_value: 0, fresh_bean_avg_stock_price: 0,
    dried_bean_volume: 0, dried_bean_value: 0, dried_bean_avg_stock_price: 0,
    delivery_asp_dried_bean: 0, gross_cash_margin_dried_bean: 0, gross_cash_profit_dried_bean: 0,
    bop_stock_fresh_bean: 0, bop_value_fresh_bean: 0, eop_stock_fresh_bean: 0, eop_value_fresh_bean: 0,
    bop_stock_dried_bean: 0, bop_value_dried_bean: 0, eop_stock_dried_bean: 0, eop_value_dried_bean: 0,
    purchasing_value_fresh_bean: 0, purchasing_value_dried_bean: 0,
    cogs_dried_bean: 0, value_available_dried_bean: 0,
    cogm_fresh_bean: 0, value_available_fresh_bean: 0,
  };
}

function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function clamp0(n: number): number { return n < 1e-6 ? 0 : n; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

export default LedgerComputeService;
