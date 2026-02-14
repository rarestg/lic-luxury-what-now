# Worker Setup

## 1) Configure

1. Open `apps/worker/wrangler.jsonc`
2. Set `d1_databases[0].database_id` to your real D1 ID
3. Set Access verification vars:
4. `vars.CF_ACCESS_TEAM_DOMAIN` (example: `your-team.cloudflareaccess.com`)
5. `vars.CF_ACCESS_AUD` (your Access application AUD)
6. Set `vars.ACCESS_DEV_BYPASS=0` for deployed environments
7. Optionally set `vars.ACTIVE_RUN_ID` (default: `active`)

## 2) Create D1 and run migrations

```bash
cd apps/worker
wrangler d1 create lic-listings
wrangler d1 execute lic-listings --file migrations/0001_initial_schema.sql
wrangler d1 execute lic-listings --file migrations/0002_add_component_id.sql
wrangler d1 execute lic-listings --file migrations/0003_add_bootstrap_metadata.sql
wrangler d1 execute lic-listings --file migrations/0004_optimize_latest_assertions.sql
```

## 3) Seed graph/listings data

From repo root:

```bash
node scripts/generate-d1-seed-sql.cjs
# optional destructive reset:
# node scripts/generate-d1-seed-sql.cjs --destructive-reset
cd apps/worker
wrangler d1 execute lic-listings --file seed/seed.sql
```

## 4) Local dev

`npm run dev` in `apps/worker` auto-generates `tool/config.local.js` and rebuilds
`apps/worker/public` before starting Wrangler.

```bash
cd /path/to/lic-listings
# optional: enable API save mode in UI
# cp .env.example .env
# set LIC_USE_API_ASSERTIONS=1 and optionally LIC_API_BASE_URL=
# local auth bypass (optional): set apps/worker/.dev.vars => ACCESS_DEV_BYPASS=1
cd apps/worker
npm run dev
```

If you intentionally want to skip the bundle refresh (from `apps/worker`), use:

```bash
npm run dev:raw
```

## 5) Deploy

`npm run deploy` in `apps/worker` auto-generates `tool/config.local.js` and rebuilds
`apps/worker/public` with `--no-data` before deploy.

```bash
cd /path/to/lic-listings/apps/worker
npm run deploy
```

If you intentionally want to skip the bundle refresh, use:

```bash
npm run deploy:raw
```

## API endpoints

1. `GET /api/health`
2. `GET /api/bootstrap`
3. `GET /api/geocode?address=...` (requires Worker env `GOOGLE_MAPS_API_KEY` and Access identity)
4. `POST /api/assertions` (requires `Cf-Access-Jwt-Assertion` header)
