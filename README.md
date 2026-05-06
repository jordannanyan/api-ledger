# traceability-api-ts

TypeScript API yang berjalan **paralel** dengan Laravel API existing. Akan
menggantikan Laravel API secara bertahap. Phase 1 = buku besar, Phase 2 =
mirror semua endpoint Laravel.

## Stack

- Node.js + Express + TypeScript
- mysql2 (raw SQL, parameterized)
- Auth: Sanctum-compatible (share `personal_access_tokens` dengan Laravel)
- File upload: multer (disk storage)

## Endpoint Map

### Auth
- `POST /api/login/entity` — body: `{ username, password }`
- `POST /api/login/kth`    — body: `{ username, password }`
- `POST /api/login/farmer` — body: `{ nik, password }`
- `GET  /api/me`
- `POST /api/logout`

### Buku Besar (Phase 1)
- `GET  /api/buku-besar?year=&month=&process=&from=&to=`
- `GET  /api/buku-besar/summary?year=&month=`
- `POST /api/buku-besar/rebuild`

### Transaksi (with auto-trigger ledger rebuild)
- `GET|POST|PUT|DELETE  /api/purchasing` (+ `/by-kth/:id`, `/by-farmer/:id`)
- `GET|POST|PUT|DELETE  /api/selling`     (+ `/by-kth/:id`)
- `GET|POST|PUT|DELETE  /api/processing`  (+ `/by-kth/:id`)
- `GET|POST|PUT|DELETE  /api/distributed-sapropdi` (+ `/by-plot/:id`)

### Master Data (full CRUD)
- `/api/commodities`
- `/api/grades`
- `/api/sapropdi`
- `/api/entities`
- `/api/kth`             (filter `?entities_id=`)
- `/api/offtakers`       (filter `?entities_id=`)
- `/api/warehouses`      (filter `?entities_id=`, `/by-kth/:id`)
- `/api/farmers`         (filter `?entities_id=&kth_id=&search=`, `/by-entity/:id`)
- `/api/plots`           (filter `?entities_id=`, `/by-kth/:id`, `/by-farmer/:id`)
  - `GET|PUT  /api/plots/:plotId/polygon-points`
- `/api/daily-purchasing-prices`
- `/api/daily-selling-prices`

### Trees & Monitoring
- `GET|POST|PUT|DELETE  /api/trees` (filter `?entities_id=&kth_id=&farmer_id=&plot_id=&search=&page=&per_page=`)
- `GET|POST  /api/trees/:treeId/monitorings`
- `GET       /api/trees/:treeId/monitorings/latest`
- `GET|PUT|DELETE  /api/tree-monitorings/:id`
- `GET       /api/tree-monitorings` (filter `?entities_id=&kth_id=&farmer_id=&tree_id=`)

### Aggregations
- `GET /api/dashboard?entityId=`
  - `/total-farmers`, `/total-kth`, `/daily-selling-price`, `/daily-purchasing-price`
- `GET /api/sales-detail/:id`

## Setup

```bash
cd api-ts
npm install
cp .env.example .env       # edit DB_PASSWORD etc
npm run dev                # http://localhost:3001
```

## DB migration

```bash
mysql -u root -p db_traceability < ../migration_buku_besar.sql
```

## Initial ledger rebuild

```bash
npm run ledger:rebuild
# OR via API:
curl -X POST http://localhost:3001/api/buku-besar/rebuild -H "Authorization: Bearer TOKEN"
```

## File uploads — directory layout

`storage/` (sibling to api-ts root or wherever `UPLOAD_PATH` points):

```
storage/
├── proofs/             ← purchasing/selling/processing proofs (signature, invoices, DO)
├── farmers_photos/     ← farmer foto
├── trees/              ← tree photos
├── tree_monitorings/   ← monitoring photos
└── sapropdi_proofs/    ← distributed-sapropdi upload_proof
```

Public URLs follow `${PUBLIC_UPLOAD_BASE}/<dir>/<filename>`. Default base = `/storage/proofs`,
so `/storage/farmers_photos/foo.jpg` is reachable via the static handler.

**Note**: image resizing/WebP conversion (Intervention\Image in Laravel) is
**not** ported. Files are stored as-is. Add later via `sharp` if needed.

## Hubungan dengan Laravel

- **Same DB** (`db_traceability`).
- **Same auth tokens** (`personal_access_tokens`). Token dari Laravel valid di
  TS API dan sebaliknya.
- **Source-of-truth** untuk transaksi bisa ditulis dari kedua API. Jika Laravel
  menulis purchasing/selling/processing, ledger di TS tidak otomatis update —
  hit `POST /api/buku-besar/rebuild` untuk re-sync.

## What's NOT ported

- Image resize / WebP / base64 alternative for photo uploads (multipart only).
- Laravel `Log::info` debug logging (replaced by minimal `console.error`).
- Laravel-specific request features like `_method` override (TS uses native PUT/DELETE).

Selama belum di-port, fitur image processing tetap tersedia via Laravel API.
