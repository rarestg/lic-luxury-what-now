# Cloudflare Deployment Guide

This document describes how to run this project in Cloudflare with live address propagation.

It covers:

1. Required Cloudflare resources
2. Data model and storage layout
3. Worker API design for live updates
4. Frontend integration requirements
5. Deployment and operations checklist

## Current Status

Implemented today:

1. Offline scrape/parse pipeline
2. Offline perceptual hashing + listing graph generation
3. Worker scaffold in `apps/worker/` with:
4. `POST /api/assertions`
5. `GET /api/bootstrap`
6. `GET /api/geocode`
7. D1 migrations in `apps/worker/migrations/`
8. Seed generator `scripts/generate-d1-seed-sql.js`
9. Static asset prep script `scripts/prepare-worker-public.js`
10. UI save-path integration in `tool/index.html` behind config flag (`LIC_USE_API_ASSERTIONS`)

Not implemented yet:

1. Production Access policy + JWT signature verification hardening
2. Cloudflare resource provisioning in your account
3. Final deploy smoke test on real domain

## Target Architecture

Core pattern:

1. Build graph offline with `scripts/build-image-graph.py`
2. Upload graph data to Cloudflare storage
3. Persist manual Lens discoveries in D1
4. Propagate addresses live in Worker when new assertion is saved
5. Return updated assignments to UI immediately

Recommended services:

1. Workers: API execution + static asset hosting in one deployment
2. D1: relational state for assertions and assignments
3. Cloudflare Access: app-level auth gate for UI + API
4. R2: optional for long-term graph snapshot archive
5. KV/DO: defer unless read scale or realtime collaboration demands it

## Required Accounts and Tooling

1. Cloudflare account with Workers and D1 enabled
2. `wrangler` CLI installed and authenticated
3. Node.js for Worker development

Install:

```bash
npm install -g wrangler
wrangler login
```

## Data Model

Use `scripts/cloudflare-d1-schema.sql` as the base schema.

Tables include:

1. `listings`
2. `images`
3. `listing_images`
4. `image_hashes`
5. `image_matches` (optional detailed storage)
6. `listing_edges` (aggregated graph per run)
7. `address_assertions` (manual truth from Lens)
8. `listing_address_assignments` (direct + inferred assignment state)
9. `runs` for versioning/imports

View included:

1. `v_address_listing_counts` for “listings per uncovered address”

## Provisioning Steps

## 1) Use existing Worker project

This repo already includes:

1. `apps/worker/wrangler.jsonc`
2. `apps/worker/src/index.js`
3. `apps/worker/migrations/*`
4. `apps/worker/README.md`

## 2) Create D1 database

```bash
cd apps/worker
wrangler d1 create lic-listings
```

Copy returned `database_id` into `apps/worker/wrangler.jsonc`.

Example binding:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "lic-listings",
    "database_id": "<database-id>"
  }
]
```

## 3) Apply schema

From repo root:

```bash
cd apps/worker
wrangler d1 execute lic-listings --file migrations/0001_initial_schema.sql
wrangler d1 execute lic-listings --file migrations/0002_add_component_id.sql
```

## 4) Seed baseline graph

```bash
cd /path/to/lic-listings
node scripts/generate-d1-seed-sql.js
cd apps/worker
wrangler d1 execute lic-listings --file seed/seed.sql
```

## 5) Build deployable static bundle

```bash
cd /path/to/lic-listings
node scripts/prepare-worker-public.js
```

`apps/worker/public/` will contain:

1. `index.html`
2. `config.js`
3. `config.local.js` (copied if present; otherwise generated empty)
4. `data/listings.json`
5. `data/hash-graph/listing-graph.json`

## API Design

These endpoints are recommended for production.

## POST `/api/assertions`

Purpose:

1. Save manual address assertion from UI
2. Recompute assignments for affected component
3. Return changed records for immediate UI update

Request body:

```json
{
  "listingId": "169510",
  "address": "42-12 28th St, Queens, NY 11101",
  "source": "manual_ui"
}
```

Notes:

1. `assertedBy` is derived from `Cf-Access-Jwt-Assertion` in Worker, not accepted from client.
2. Endpoint rejects requests without Access identity.

Response body:

```json
{
  "ok": true,
  "runId": "active",
  "componentId": 4,
  "conflict": false,
  "changedListingIds": ["169510", "169569", "170235"],
  "assignments": {
    "169510": {"address":"42-12 28th St, Queens, NY 11101","resolved":true,"source":"direct","confidence":1.0,"updatedAt":"..."},
    "169569": {"address":"42-12 28th St, Queens, NY 11101","resolved":true,"source":"inferred_component","confidence":0.8,"updatedAt":"..."},
    "170235": {"address":"42-12 28th St, Queens, NY 11101","resolved":true,"source":"inferred_component","confidence":0.8,"updatedAt":"..."}
  }
}
```

Implemented helper routes:

1. `GET /api/health`
2. `GET /api/bootstrap` (listings + graph payload for UI auto-load)
3. `GET /api/geocode?address=...` (when `GOOGLE_MAPS_API_KEY` Worker secret is set)

## GET `/api/listings/:id/graph`

Purpose:

1. Return listing neighborhood in graph
2. Show connected listings and edge support

## GET `/api/addresses/summary`

Purpose:

1. Return “how many listings per uncovered address”

Backed by:

```sql
SELECT normalized_address, representative_address, listing_count
FROM v_address_listing_counts;
```

## GET `/api/components/:componentId`

Purpose:

1. Return full component membership
2. Return current assignment status for conflict review

## Propagation Logic (Worker)

Execute inside one transaction:

1. Normalize incoming address
2. Insert into `address_assertions`
3. Identify listing’s component
4. Read all direct assertions in that component
5. If exactly one normalized address exists in component:
6. Upsert direct assignment for asserted listing
7. Upsert inferred assignments for all other listings in component
8. If multiple normalized addresses exist:
9. Keep direct assignments only
10. Mark component as conflict in response metadata
11. Return changed assignments to caller

Behavioral guarantees:

1. Direct assertion always wins for its listing
2. Inference only happens when a component has one unambiguous address
3. Conflicts are explicit and reviewable

## Frontend Integration

Current `tool/index.html` now supports two save modes:

1. Local-only (`localStorage`)
2. API-backed (`POST /api/assertions`) when `LIC_USE_API_ASSERTIONS=1`

To move to live mode:

1. Set `.env` with:
2. `LIC_USE_API_ASSERTIONS=1`
3. `LIC_API_BASE_URL=` (blank for same origin; set full URL if cross-origin)
4. Run `node scripts/generate-tool-config.js`
5. Rebuild worker assets (`node scripts/prepare-worker-public.js`)
6. On save, UI calls `/api/assertions` and merges returned `assignments` into local state
7. Local save still occurs as fallback if API call fails

Geocoding integration:

1. Expose Worker endpoint `GET /api/geocode?address=...`
2. Read `GOOGLE_MAPS_API_KEY` from Worker secret, never from browser
3. Return `{ "address": "<formatted address>" }` (or compatible shape)
4. Set `.env` locally with `LIC_GEOCODE_ENDPOINT=/api/geocode`
5. Run `node scripts/generate-tool-config.js` so `tool/config.local.js` points UI to Worker endpoint

## Realtime Multi-User Update Options

Option A:

1. Poll `/api/addresses/summary` and listing status every 5-15s

Option B:

1. Use Durable Object WebSocket rooms
2. Broadcast assignment deltas when assertions are saved

For current scale, polling is usually enough. Add Durable Objects when multi-user concurrency matters.

## Security Requirements

1. Keep Google Maps API key in Worker secret (`wrangler secret put GOOGLE_MAPS_API_KEY`)
2. Gate the whole app with one Cloudflare Access application (UI + API)
3. Validate and normalize all input server-side
4. Add rate limits on mutation endpoints
5. Use parameterized D1 statements only
6. For mutation audit, read identity from `Cf-Access-Jwt-Assertion`

## Suggested Worker Project Structure

```text
apps/worker/
├── migrations/
│   ├── 0001_initial_schema.sql
│   └── 0002_add_component_id.sql
├── public/                    # built by scripts/prepare-worker-public.js
├── seed/
│   └── seed.sql               # built by scripts/generate-d1-seed-sql.js
├── src/
│   └── index.js              # Router + D1 logic
└── wrangler.jsonc
```

## Deployment Flow

1. Generate fresh `listing-graph.json` offline
2. Generate seed SQL (`node scripts/generate-d1-seed-sql.js`)
3. Apply migrations and seed D1
4. Build Worker public bundle (`node scripts/prepare-worker-public.js`)
5. Configure `.env` and regenerate `tool/config.local.js` if needed
6. Deploy Worker (`wrangler deploy`)
7. Run smoke tests for assertion -> propagation -> merge in UI

Deploy command:

```bash
wrangler deploy
```

## Operational Checklist

1. Daily or periodic graph refresh when listings/images change
2. Backup D1 regularly
3. Track assertion volume and conflict components
4. Monitor Worker error rates and p95 latency
5. Audit inferred assignments in large components

## Recommended Next Implementation Step

Provision cloud resources and run deployment smoke tests using the implemented code.

Primary smoke path:

1. Load UI through Worker + Access
2. Save one resolved listing address
3. Confirm `/api/assertions` returns assignment deltas
4. Confirm UI merges returned assignments and re-renders component counts
