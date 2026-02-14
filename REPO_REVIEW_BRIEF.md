# LIC Listings Investigator: Cloudflare Review Brief

Last updated: 2026-02-14

## 1) Project Purpose

This repo supports manual address resolution for LIC rental listings using perceptual image clustering:

1. Scrape listings
2. Parse to structured JSON
3. Build image-similarity graph (nodes=listings, edges=image-match evidence)
4. Investigate in UI and resolve addresses
5. Propagate trusted addresses across graph components with guardrails

Core point: graph components are clustering signals, not guaranteed 1:1 buildings.

## 2) What Is Implemented Now

### Local pipeline (complete)

1. `scripts/scrape-all.sh`
2. `scripts/parse-listings.js`
3. `scripts/build-image-graph.py`
4. Generated artifacts:
5. `data/listings.json`
6. `data/hash-graph/listing-graph.json`

### UI workflow (implemented)

Implemented in `tool/index.html`:

1. Component metadata + component panel navigation
2. Component filters (`Current Component`, unresolved/resolved in component)
3. Edge evidence in connected rows:
4. `matchedImagePairs`
5. min/avg pHash + dHash
6. sample URL pairs
7. strength label (`Strong/Medium/Weak`)
8. Bulk apply to component in local mode only (unresolved-only default)
9. Conflict block when multiple resolved addresses exist in component
10. Single-step undo for last bulk apply
11. State metadata per listing: `source`, `confidence`, `updatedAt`
12. Graph-only connectivity preserved (no image-map fallback)
13. Existing sanitization preserved (`escapeHtml`, `safeUrl`)
14. In API mode, local bulk apply/undo actions are disabled to avoid local/server divergence; save one listing and let server propagation return deltas.

### Cloud/backend (implemented; repeatable for new environments)

Implemented project scaffold:

1. `apps/worker/wrangler.jsonc`
2. `apps/worker/src/index.js`
3. `apps/worker/migrations/0001_initial_schema.sql`
4. `apps/worker/migrations/0002_add_component_id.sql`
5. `apps/worker/migrations/0003_add_bootstrap_metadata.sql`
6. `apps/worker/migrations/0004_optimize_latest_assertions.sql`
7. `apps/worker/README.md`

Implemented endpoints:

1. `POST /api/assertions`
2. `GET /api/bootstrap`
3. `GET /api/geocode`
4. `GET /api/health`

Implemented UI API integration:

1. Config-driven API mode (`LIC_USE_API_ASSERTIONS`, `LIC_API_BASE_URL`)
2. Save path can call `/api/assertions`
3. Returned `assignments` merged into local UI state
4. `/api/bootstrap` now returns assignment state; UI hydrates assignments in API mode on load
5. Local fallback retained if API call fails

## 3) Target Cloudflare Architecture (Current Direction)

Decision: unified Worker deployment (API + static assets on same origin).

1. Workers Static Assets serves UI
2. `run_worker_first` routes `/api/*` to Worker logic
3. D1 stores listing graph metadata + assertions + assignments
4. Cloudflare Access gates the app (UI + API)
5. Access identity (`Cf-Access-Jwt-Assertion`) used for mutation attribution (`asserted_by`)
6. Access JWT verified in Worker with Cloudflare Access certs (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`)

Deferred for now:

1. KV
2. Durable Objects (optional; not required after component-level D1 write lock was added)
3. R2 for primary graph serving (optional for snapshots later)

## 4) Data Model Notes

Baseline schema and migration strategy:

1. Initial schema in `apps/worker/migrations/0001_initial_schema.sql`
2. Added `listings.component_id` in `0002_add_component_id.sql`
3. Added bootstrap metadata columns in `0003_add_bootstrap_metadata.sql`
4. Added latest-assertion index in `0004_optimize_latest_assertions.sql` (`idx_address_assertions_listing_latest`)
5. Indexed component lookup (`idx_listings_component`)

Reason:

1. Propagation hot path is component membership lookup
2. Latest direct-assertion lookup must remain fast as history grows
3. `component_id` avoids runtime graph traversal

## 5) `POST /api/assertions` Behavior (Current)

Input:

```json
{
  "listingId": "169510",
  "address": "42-12 28th St, Queens, NY 11101",
  "source": "manual_ui"
}
```

Flow:

1. Require Access identity header
2. Verify Access JWT signature + claims (`iss`, `aud`, `exp`, `nbf`)
3. Acquire component-level write lock (serialize concurrent writes per component)
4. Normalize incoming address
5. Find component members by `listings.component_id`
6. Compute latest direct assertions in component while lock is held
7. Include incoming direct assertion in propagation decision
8. If conflict (>1 normalized address): keep direct assignments only
9. If no conflict: infer unresolved peers in component
10. Write assertion row + assignment upserts in one `DB.batch()`
11. Return only changed assignments for UI merge

Concurrency guarantee:

1. Component writes are serialized via a D1-backed lock table (`component_write_locks`) to prevent stale-snapshot overwrite races.

Geocode behavior:

1. `GET /api/geocode` now also requires verified Access identity (not anonymous).

Output includes:

1. `conflict`
2. `changedListingIds`
3. `assignments` delta map

## 6) Packaging/Seeding Utilities

1. `scripts/generate-d1-seed-sql.cjs`
2. Reads `data/listings.json` + `data/hash-graph/listing-graph.json`
3. Writes `apps/worker/seed/seed.sql` with active run + listings + edges + component ids
4. Safe-by-default mode preserves `address_assertions` + `listing_address_assignments`
5. Destructive reset requires both `--destructive-reset` and `--yes-i-am-sure`
6. Optional cleanup mode: `--prune-unreferenced-listings`

1. `scripts/prepare-worker-public.cjs`
2. Builds `apps/worker/public/` from local UI + minimal static data bundle

1. `scripts/generate-tool-config.cjs`
2. Supports production guard `LIC_FORBID_BROWSER_GOOGLE_MAPS_KEY=1` to block embedding browser Google Maps API keys in generated client config.
3. `apps/worker/package.json` enables this guard in `prepare:public:prod`.

## 7) Code Quality Tooling Added

Root tooling configured:

1. Biome (`biome.json`)
2. TypeScript checkJs (`tsconfig.json`)
3. Lefthook (`lefthook.yml`)
4. Standard scripts in root `package.json`:
5. `format`
6. `lint`
7. `typecheck`
8. `check`
9. `check:fix`

Verification status in current workspace:

1. `npm run lint` passes
2. `npm run typecheck` passes
3. `npm run check` passes

## 8) Cloudflare-Account Tasks (For Fresh/New Environments)

Current repo includes a live deployment reference in root `README.md`. Use the following when standing up a new account/environment:

1. Install/auth `wrangler` in operator environment
2. Create D1 DB and set real `database_id` in `apps/worker/wrangler.jsonc`
3. Apply migrations
4. Load seed SQL
5. Configure Worker runtime vars in Cloudflare runtime settings:
6. `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ACCESS_DEV_BYPASS=0`, `ACTIVE_RUN_ID=active`
7. Configure Worker secret:
8. `GOOGLE_MAPS_API_KEY` (if `/api/geocode` is used)
9. Configure Cloudflare Access app/policies for the deployed hostname
10. Deploy Worker (`wrangler deploy`)
11. Smoke test through Access-gated domain

## 9) Explicit Review Questions for Cloudflare Expert

1. Is unified Worker static+API the right tradeoff for this use case vs Pages+Worker split?
2. Is Access identity verification coverage sufficient across endpoints (`/api/assertions` and `/api/geocode`)?
3. Any D1 schema/index adjustments needed for propagation correctness or expected growth?
4. Should we keep seed/import flow as generated SQL, or move to API/scripted upserts?
5. Any concerns with current conflict semantics (`direct-only on conflict`)?
6. Observability recommendation: are structured Worker logs enough initially, or should Tail Worker / Analytics Engine be added immediately?

## 10) Key Paths for Fast Review

1. `tool/index.html`
2. `apps/worker/src/index.js`
3. `apps/worker/wrangler.jsonc`
4. `apps/worker/migrations/0001_initial_schema.sql`
5. `apps/worker/migrations/0002_add_component_id.sql`
6. `apps/worker/migrations/0003_add_bootstrap_metadata.sql`
7. `apps/worker/migrations/0004_optimize_latest_assertions.sql`
8. `scripts/generate-d1-seed-sql.cjs`
9. `scripts/prepare-worker-public.cjs`
10. `docs/cloudflare-deployment.md`
