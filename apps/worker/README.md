# Worker Operator Quick Reference

Last verified: 2026-02-14

This is a short operator cheat sheet for `apps/worker`.

Canonical runbook: `docs/cloudflare-deployment.md`

## Operational Block (Production)

Use this when shipping or repairing production quickly.

```bash
# 1) Build fresh seed SQL from current local artifacts (repo root)
cd /path/to/lic-listings
node scripts/generate-d1-seed-sql.cjs

# 2) Apply schema + seed to remote D1 (worker dir)
cd apps/worker
wrangler d1 execute lic-listings --remote --file migrations/0001_initial_schema.sql
wrangler d1 execute lic-listings --remote --file migrations/0002_add_component_id.sql
wrangler d1 execute lic-listings --remote --file migrations/0003_add_bootstrap_metadata.sql
wrangler d1 execute lic-listings --remote --file migrations/0004_optimize_latest_assertions.sql
wrangler d1 execute lic-listings --remote --file seed/seed.sql

# 3) Deploy Worker + static assets (includes production browser-key guard)
npm run deploy
```

## Common Commands

### Create D1 (one-time per environment)

```bash
cd /path/to/lic-listings/apps/worker
wrangler d1 create lic-listings
# copy returned database_id into apps/worker/wrangler.jsonc
```

### Generate seed SQL

```bash
cd /path/to/lic-listings
node scripts/generate-d1-seed-sql.cjs
# optional destructive reset:
# node scripts/generate-d1-seed-sql.cjs --destructive-reset --yes-i-am-sure
```

### Apply migrations (remote D1)

```bash
cd /path/to/lic-listings/apps/worker
wrangler d1 execute lic-listings --remote --file migrations/0001_initial_schema.sql
wrangler d1 execute lic-listings --remote --file migrations/0002_add_component_id.sql
wrangler d1 execute lic-listings --remote --file migrations/0003_add_bootstrap_metadata.sql
wrangler d1 execute lic-listings --remote --file migrations/0004_optimize_latest_assertions.sql
```

### Load seed into remote D1

```bash
cd /path/to/lic-listings/apps/worker
wrangler d1 execute lic-listings --remote --file seed/seed.sql
```

### Local dev Worker

```bash
cd /path/to/lic-listings
cp .env.example .env
# set LIC_USE_API_ASSERTIONS=1
# set LIC_GEOCODE_ENDPOINT=/api/geocode
# local auth bypass only: apps/worker/.dev.vars => ACCESS_DEV_BYPASS=1

cd apps/worker
npm run dev
```

Raw (skip bundle refresh):

```bash
npm run dev:raw
```

### Deploy

```bash
cd /path/to/lic-listings/apps/worker
npm run deploy
```

Raw (skip bundle refresh):

```bash
npm run deploy:raw
```

## Required Runtime Vars and Secrets

Set these in Cloudflare Worker runtime settings/dashboard for deployed environments.

1. `CF_ACCESS_TEAM_DOMAIN`
2. `CF_ACCESS_AUD`
3. `ACCESS_DEV_BYPASS=0`
4. `ACTIVE_RUN_ID=active`
5. Secret: `GOOGLE_MAPS_API_KEY` (required only if `/api/geocode` is enabled)

Notes:

1. Do not store real Access values in repo placeholders.
2. `wrangler.jsonc` may contain placeholders/defaults; dashboard/runtime values are authoritative.

## Fast Health Checks

### Local (`wrangler dev`)

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/bootstrap
```

### Endpoint behavior

1. `GET /api/health` returns liveness JSON
2. `GET /api/bootstrap` returns listings + graph + assignment state
3. `GET /api/geocode?address=...` requires Access identity and `GOOGLE_MAPS_API_KEY`
4. `POST /api/assertions` requires Access identity and returns assignment deltas

## Notes

1. Use `--remote` for production D1 commands.
2. Remove `--remote` only when intentionally testing against local D1.
3. `npm run deploy` uses production prep (`prepare:public:prod`) and enforces `LIC_FORBID_BROWSER_GOOGLE_MAPS_KEY=1`.
4. In API mode, local bulk apply/undo is intentionally disabled in the UI to avoid local/server divergence.
