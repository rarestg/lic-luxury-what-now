# Worker Setup

## 1) Configure

1. Open `apps/worker/wrangler.jsonc`
2. Set `d1_databases[0].database_id` to your real D1 ID
3. Optionally set `vars.ACTIVE_RUN_ID` (default: `active`)

## 2) Create D1 and run migrations

```bash
cd apps/worker
wrangler d1 create lic-listings
wrangler d1 execute lic-listings --file migrations/0001_initial_schema.sql
wrangler d1 execute lic-listings --file migrations/0002_add_component_id.sql
```

## 3) Seed graph/listings data

From repo root:

```bash
node scripts/generate-d1-seed-sql.cjs
cd apps/worker
wrangler d1 execute lic-listings --file seed/seed.sql
```

## 4) Local dev

Prepare static assets bundle first:

```bash
cd /path/to/lic-listings
# optional: enable API save mode in UI
# cp .env.example .env
# set LIC_USE_API_ASSERTIONS=1 and optionally LIC_API_BASE_URL=
# node scripts/generate-tool-config.cjs
node scripts/prepare-worker-public.cjs
```

Then run dev server:

```bash
cd apps/worker
wrangler dev
```

## 5) Deploy

```bash
cd /path/to/lic-listings
# Production: skip static data files, UI loads from /api/bootstrap
node scripts/prepare-worker-public.cjs --no-data
# Dev/offline fallback: include static data files
# node scripts/prepare-worker-public.cjs
cd apps/worker
wrangler deploy
```

## API endpoints

1. `GET /api/health`
2. `GET /api/bootstrap`
3. `GET /api/geocode?address=...` (requires Worker env `GOOGLE_MAPS_API_KEY`)
4. `POST /api/assertions` (requires `Cf-Access-Jwt-Assertion` header)
