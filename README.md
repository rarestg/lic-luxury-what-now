# LIC Listings Investigator

Investigation toolkit for rental listings from `luxuryapartmentslic.com`. Combines offline scraping with a live Cloudflare-backed investigation UI.

1. Idempotent scraping of listing detail pages
2. Markdown-to-JSON extraction
3. Perceptual image hashing pipeline to infer listing-to-listing relationships
4. Investigation UI with graph-driven clustering, address resolution, and live persistence via Cloudflare D1

## Live Deployment

The app is deployed on Cloudflare Workers with Cloudflare Access authentication.

| Resource | Details |
|----------|---------|
| **URL** | `https://lic-listings-worker.rarestg.workers.dev` |
| **Auth** | Cloudflare Access (Google OAuth + OTP) |
| **Database** | Cloudflare D1 (253 listings, 1,567 edges, 38 components) |
| **Geocoding** | Server-side via `/api/geocode` (Google Maps key in Worker secret) |
| **CI/CD** | Push to `main` auto-deploys via Cloudflare Builds |

API endpoints:

1. `GET /api/health` — liveness check
2. `GET /api/bootstrap` — full listings + graph payload for UI
3. `GET /api/geocode?address=...` — server-side geocoding proxy
4. `POST /api/assertions` — save address assertion, propagate to component, return deltas

## What This Repo Does

1. Pull listings and media metadata from the source website
2. Normalize listing data into JSON for fast local inspection
3. Use reverse image search (Google Lens) to identify true addresses
4. Use perceptual image similarity to connect listings that likely represent the same real location
5. Propagate known addresses across connected listing clusters — locally or live via the Worker API

## Repository Layout

```text
.
├── apps/worker/                   # Cloudflare Worker (API + static hosting)
│   ├── src/index.js               # Router, D1 queries, propagation logic
│   ├── migrations/                # D1 schema migrations
│   ├── seed/                      # Generated seed SQL (gitignored)
│   ├── public/                    # Built static bundle (gitignored)
│   └── wrangler.jsonc             # Worker config with D1 binding
├── data/
│   ├── all-listing-urls.txt       # Source listing URLs
│   ├── listings.json              # Structured listing records (generated)
│   ├── image-map.json             # imageURL -> [listingIds] (generated)
│   ├── hash-graph/                # Perceptual hashing outputs (generated)
│   ├── images-cache/              # Downloaded image cache (generated)
│   └── page-*.html                # Cached search pages
├── docs/
│   └── cloudflare-deployment.md   # Full deployment guide
├── scripts/
│   ├── scrape-all.sh              # Batch detail-page scraper (idempotent)
│   ├── parse-listings.js          # Markdown parser (idempotent)
│   ├── build-image-graph.py       # Perceptual image graph pipeline
│   ├── generate-d1-seed-sql.cjs   # Generate D1 seed from local data
│   ├── generate-tool-config.cjs   # Generate UI config from .env or env vars
│   ├── prepare-worker-public.cjs  # Build Worker static asset bundle
│   └── cloudflare-d1-schema.sql   # Reference D1 schema
└── tool/
    ├── index.html                 # Investigator HTML shell
    ├── config.js                  # Default runtime config
    ├── config.local.js            # Generated local/runtime overrides (optional)
    ├── styles/main.css            # UI styles
    ├── src/                       # Modular browser app (state/model/ui/services)
    └── data -> ../data            # Symlink for local serving
```

## Offline Pipeline

### 1) Scrape listing detail pages

```bash
bash scripts/scrape-all.sh
```

1. Reads `data/all-listing-urls.txt`
2. Scrapes in parallel batches (`BATCH_SIZE=5`)
3. Skips already-present non-empty markdown files
4. Removes empty/failed output files so reruns can recover cleanly

Output: `.firecrawl/listings/<listingId>.md`

### 2) Parse markdown into structured JSON

```bash
node scripts/parse-listings.js
```

1. Parses all `.md` files in `.firecrawl/listings`
2. Extracts fields: price, beds, baths, neighborhood, features, flags, description, image URLs
3. Builds `image-map.json` as `imageURL -> [listingIds]`

Outputs: `data/listings.json`, `data/image-map.json`

### 3) Build perceptual image graph

```bash
pip3 install imagehash pillow
python3 scripts/build-image-graph.py
```

1. Downloads all unique images in parallel to `data/images-cache`
2. Computes `pHash` and `dHash`
3. Compares hashes with configurable Hamming thresholds
4. Creates listing graph edges from image matches
5. Computes connected components

Outputs: `data/hash-graph/image-hashes.json`, `data/hash-graph/image-similarity.json`, `data/hash-graph/listing-graph.json`

Options:

```bash
python3 scripts/build-image-graph.py --skip-download
python3 scripts/build-image-graph.py --phash-threshold 6 --dhash-threshold 8
python3 scripts/build-image-graph.py --max-image-matches-output 10000
```

### 4) Propagate known addresses from seed data

```bash
python3 scripts/build-image-graph.py \
  --skip-download \
  --seed-addresses /path/to/lic-investigator-state.json
```

Output: `data/hash-graph/address-propagation.json`

## Cloud Deployment

### Quick start

```bash
# Install and authenticate
npm install -g wrangler
wrangler login

# Create D1 and apply migrations
cd apps/worker
wrangler d1 create lic-listings
# → copy database_id into wrangler.jsonc
wrangler d1 execute lic-listings --remote --file migrations/0001_initial_schema.sql
wrangler d1 execute lic-listings --remote --file migrations/0002_add_component_id.sql

# Seed data from local graph
cd ../..
node scripts/generate-d1-seed-sql.cjs
cd apps/worker
wrangler d1 execute lic-listings --remote --file seed/seed.sql

# Set secrets
wrangler secret put GOOGLE_MAPS_API_KEY

# Build and deploy
cd ../..
node scripts/generate-tool-config.cjs
node scripts/prepare-worker-public.cjs --no-data
cd apps/worker
wrangler deploy
```

### CI/CD (Cloudflare Builds)

Push to `main` auto-deploys. Build config:

| Field | Value |
|-------|-------|
| Root directory | `/` |
| Build command | `node scripts/generate-tool-config.cjs && node scripts/prepare-worker-public.cjs --no-data` |
| Deploy command | `npx wrangler deploy` |

Build variables: `LIC_GEOCODE_ENDPOINT=/api/geocode`, `LIC_USE_API_ASSERTIONS=1`

### Local development

```bash
# Configure UI for API mode
cp .env.example .env
# Edit: LIC_USE_API_ASSERTIONS=1, LIC_GEOCODE_ENDPOINT=/api/geocode
node scripts/generate-tool-config.cjs
node scripts/prepare-worker-public.cjs

cd apps/worker
wrangler dev
```

Or serve the UI locally without the Worker:

```bash
python3 -m http.server 8000
# Open http://localhost:8000/tool/
```

See `docs/cloudflare-deployment.md` for the full deployment guide.

## Investigation UI

The UI entrypoint (`tool/index.html`) loads modular browser code from `tool/src/` and supports two modes:

1. **Local-only** — saves to `localStorage` (default when `LIC_USE_API_ASSERTIONS` is off)
2. **API-backed** — saves to D1 via `POST /api/assertions`, propagates to component members, merges deltas into local state

UI capabilities:

1. Sidebar filtering by status, beds, and search
2. Google Lens links for every listing image
3. Component panel with member navigation and resolved/unresolved counts
4. Edge evidence with strength labels, hash distances, and sample image pairs
5. Bulk apply address to unresolved listings in a component with conflict blocking + single-step undo
6. Export/import state JSON for backups

## Graph Concepts

Terminology used by `listing-graph.json`:

1. **Node**: one listing
2. **Edge**: two listings connected by similar images under hash thresholds
3. **Component**: connected cluster of listings

Important: components are not guaranteed 1:1 with buildings. One building can split into multiple components, and multiple buildings can merge if they reuse similar/model images. Treat components as clustering signals, then validate with manual Lens evidence.

## Architecture

```
┌─────────────┐     ┌──────────────────────────┐
│  Browser UI  │────▶│  Cloudflare Worker        │
│  index.html  │◀────│  /api/assertions          │
└─────────────┘     │  /api/bootstrap           │
                    │  /api/geocode             │
                    └──────────┬───────────────┘
                               │
                    ┌──────────▼───────────────┐
                    │  Cloudflare D1            │
                    │  listings, edges,         │
                    │  assertions, assignments  │
                    └──────────────────────────┘
```

Propagation flow on `POST /api/assertions`:

1. Validate Access JWT identity
2. Normalize address
3. Insert assertion into `address_assertions`
4. Look up listing's component via `component_id`
5. If one normalized address in component → infer assignments to all members
6. If multiple addresses → mark conflict, assign only direct assertions
7. Return changed assignments for immediate UI merge

All writes (assertion + assignments) execute in a single atomic `DB.batch()`.

## Security

1. Entire app gated by Cloudflare Access (Google OAuth + OTP)
2. Google Maps API key stored as Worker secret, never exposed to browser
3. `assertedBy` derived from Access JWT, not client input
4. All D1 queries use parameterized statements
5. Geocode endpoint uses an in-memory rate limit (30 req/min per identity, per Worker isolate)

## Code Quality

```bash
npm install
npm run format
npm run lint
npm run typecheck
npm run check
npm run check:fix
```

Pre-commit hooks configured via `lefthook.yml`.

## Dataset Snapshot

| Metric | Value |
|--------|-------|
| Listings | 253 |
| Unique image URLs | 4,081 |
| Graph edges | 1,567 |
| Graph components | 38 |
| Isolated listings | 7 |
| Matched image pairs | 22,804 |
