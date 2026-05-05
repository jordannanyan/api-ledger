# traceability-api-ts

TypeScript API yang berjalan **paralel** dengan Laravel API existing. Akan
menggantikan Laravel API secara bertahap. Phase 1 fokus ke fitur **Buku Besar**
(SJ - Data Entry Dried Bean) untuk Google Sheet integration.

## Stack

- Node.js + Express + TypeScript
- mysql2 (raw SQL, parameterized)
- Auth: Sanctum-compatible (share `personal_access_tokens` dengan Laravel)
- File upload: multer

## Endpoint yang sudah jalan (Phase 1)

### Auth
- `POST /api/login/entity` — body: `{ username, password }` → `{ token, entity }`
- `POST /api/login/kth`    — body: `{ username, password }`
- `POST /api/login/farmer` — body: `{ nik, password }`
- `GET  /api/me`           — header: `Authorization: Bearer {token}`
- `POST /api/logout`       — revoke current token

### Transaksi (mirror Laravel + field baru untuk Buku Besar)
- `GET    /api/purchasing` — list (filter `entities_id`, `status`)
- `GET    /api/purchasing/:id`
- `GET    /api/purchasing/by-kth/:kth_id`
- `GET    /api/purchasing/by-farmer/:farmer_id`
- `POST   /api/purchasing` — multipart (proofs + signature). Field baru: `receipt_invoice`, `payment_status`
- `PUT    /api/purchasing/:id`
- `DELETE /api/purchasing/:id`

- `GET    /api/selling` (+ same patterns)
- `POST   /api/selling` — multipart. Field baru: `receipt_invoice`, `cost_packing`, `cost_loading`, `cost_transport`, `cost_consumption`, `cost_other`, `total_delivery_cost` (auto-computed), `tax_pph`
- `PUT    /api/selling/:id`
- `DELETE /api/selling/:id`

- `GET    /api/processing` — **NEW** Fresh Bean → Dried Bean conversion
- `POST   /api/processing` — body: `warehouse_id, commodities_id, volume_input, volume_output, total_processing_cost, ...`
- `PUT    /api/processing/:id`
- `DELETE /api/processing/:id`

### Buku Besar
- `GET  /api/buku-besar` — query: `year`, `month`, `process`, `from`, `to`
- `GET  /api/buku-besar/summary?year=&month=` — BoP/EoP, COGS, COGM
- `POST /api/buku-besar/rebuild` — recompute from source tables

### Master Data (READ-only untuk dropdown)
- `GET /api/commodities`, `/api/grades`, `/api/sapropdi`, `/api/entities`
- `GET /api/warehouses?entities_id=`
- `GET /api/offtakers?entities_id=`
- `GET /api/kth?entities_id=`
- `GET /api/farmers?entities_id=&kth_id=`
- `GET /api/plots?entities_id=&farmer_id=`

## Setup

```bash
cd api-ts
npm install
cp .env.example .env       # edit DB_PASSWORD etc
npm run dev                # http://localhost:3001
```

## DB migration

Sebelum start API, import dulu migrasi:

```bash
mysql -u root -p db_traceability < ../migration_buku_besar.sql
```

Migrasi menambahkan: `processing` table (NEW), `ledger_entries` table (NEW),
extend `purchasing` (`receipt_invoice`, `payment_status`), extend `selling`
(5 cost cols + `tax_pph` + `receipt_invoice`), drop legacy `buku_besar`.

## Sync ledger setelah import data lama

```bash
npm run ledger:rebuild
```

Atau hit `POST /api/buku-besar/rebuild` (perlu auth token).

## Hubungan dengan Laravel API

- **Same DB** (`db_traceability`).
- **Same auth tokens** (`personal_access_tokens`). Token yang di-issue oleh
  Laravel valid di TS API, dan sebaliknya.
- **Source-of-truth** untuk transaksi (`purchasing`, `selling`, `processing`)
  bisa ditulis dari kedua API. Laravel tidak tahu tentang `ledger_entries`,
  jadi setelah Laravel write data, jalankan `POST /api/buku-besar/rebuild`
  untuk re-sync ledger.
- TS API **otomatis** rebuild ledger setiap CRUD purchasing/processing/selling
  yang lewat dirinya.

## Yang BELUM diimplementasikan (akan dikerjakan di phase berikutnya)

- CRUD untuk: farmers, kth, plot, commodities, grade, sapropdi, warehouse,
  offtaker, entities, tree, tree_monitoring, daily_purchasing_price,
  daily_selling_price, distributed_sapropdi
- Dashboard endpoint
- Sales detail endpoint
- Polygon points (`plot_polygon_points`) untuk plot
- Tree monitoring endpoints

Selama belum di-port, fitur-fitur tersebut tetap bisa diakses via Laravel API.
