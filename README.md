# LIC Listings Investigator

Local investigation toolkit for rental listings from `luxuryapartmentslic.com`, including:

1. Idempotent scraping of listing detail pages
2. Markdown-to-JSON extraction
3. Single-file investigation UI for manual address resolution
4. Perceptual image hashing pipeline to infer listing-to-listing relationships

## What This Repo Does

The repository is optimized for a practical workflow:

1. Pull listings and media metadata from the source website
2. Normalize listing data into JSON for fast local inspection
3. Use reverse image search (Google Lens) to identify true addresses
4. Use perceptual image similarity to connect listings that likely represent the same real location
5. Propagate known addresses across connected listing clusters

## Repository Layout

```text
.
├── .firecrawl/listings/            # Raw scraped markdown detail pages
├── data/
│   ├── all-listing-urls.txt        # Source listing URLs
│   ├── listings.json               # Structured listing records
│   ├── image-map.json              # imageURL -> [listingIds]
│   ├── hash-graph/                 # Perceptual hashing outputs
│   ├── images-cache/               # Downloaded image cache for hashing
│   ├── page-*.html                 # Cached search pages
│   └── scrape-progress.log
├── scripts/
│   ├── scrape-all.sh               # Batch detail-page scraper (idempotent)
│   ├── parse-listings.js           # Markdown parser (idempotent)
│   ├── analyze-images.js           # Legacy asset-prefix analysis
│   ├── build-image-graph.py        # New perceptual image graph pipeline
│   ├── cloudflare-d1-schema.sql    # Proposed D1 schema for production
│   └── README-image-graph.md       # Focused hashing script notes
└── tool/
    ├── index.html                  # Single-file investigator UI
    └── data -> ../data             # Symlink for local serving
```

## Current Dataset Snapshot

As of the latest local run:

1. Listings: `253`
2. Unique image URLs: `4081`
3. Listings with sqft: `64`
4. Graph nodes: `253`
5. Graph edges: `1567`
6. Graph components: `38`
7. Isolated listings: `7`
8. Matched image pairs: `22804`

## End-to-End Pipeline

## 1) Scrape listing detail pages

Command:

```bash
bash scripts/scrape-all.sh
```

Behavior:

1. Reads `data/all-listing-urls.txt`
2. Scrapes in parallel batches (`BATCH_SIZE=5`)
3. Skips already-present non-empty markdown files
4. Tracks per-job failure and exits non-zero if any scrape fails
5. Removes empty/failed output files so reruns can recover cleanly

Output:

1. `.firecrawl/listings/<listingId>.md`

## 2) Parse markdown into structured JSON

Command:

```bash
node scripts/parse-listings.js
```

Behavior:

1. Parses all `.md` files in `.firecrawl/listings`
2. Extracts fields such as price, beds, baths, neighborhood, features, flags, description, and image URLs
3. Builds `image-map.json` as `imageURL -> [listingIds]`
4. Sorts listings by price descending
5. Overwrites outputs deterministically on each run

Outputs:

1. `data/listings.json`
2. `data/image-map.json`

## 3) Investigate and annotate in local UI

Serve repo root:

```bash
cd /path/to/lic-listings
python3 -m http.server 8000
```

Open:

1. `http://localhost:8000/tool/`

Configure geocoding (recommended before use):

```bash
cp .env.example .env
# Set LIC_GEOCODE_ENDPOINT (recommended for Cloudflare) or LIC_GOOGLE_MAPS_API_KEY
# Optional cloud save flags: LIC_USE_API_ASSERTIONS=1 and LIC_API_BASE_URL=
node scripts/generate-tool-config.js
```

UI capabilities:

1. Sidebar filtering by status, beds, and search
2. Address + notes per listing persisted in `localStorage`
3. Export/import state JSON for backups
4. Google Lens links for every listing image
5. Graph-only connected-listings counts and cluster indicators
6. Component panel with full member navigation and resolved/unresolved workload
7. Connected-listing edge evidence (`matchedImagePairs`, hash distance stats, sample URL pairs, strength labels)
8. Local-first bulk apply to unresolved listings in a component with conflict blocking + single-step undo

## 4) Build perceptual image graph

Install dependencies:

```bash
pip3 install imagehash pillow
```

Run:

```bash
python3 scripts/build-image-graph.py
```

What it does:

1. Downloads all unique images in parallel to `data/images-cache`
2. Computes `pHash` and `dHash`
3. Compares hashes with configurable Hamming thresholds
4. Creates listing graph edges from image matches
5. Computes connected components

Outputs:

1. `data/hash-graph/image-hashes.json`
2. `data/hash-graph/image-similarity.json`
3. `data/hash-graph/listing-graph.json`

Useful options:

```bash
python3 scripts/build-image-graph.py --skip-download
python3 scripts/build-image-graph.py --phash-threshold 6 --dhash-threshold 8
python3 scripts/build-image-graph.py --max-image-matches-output 10000
```

## 5) Propagate known addresses from seed data

If you exported state from the UI and it includes resolved addresses:

```bash
python3 scripts/build-image-graph.py \
  --skip-download \
  --seed-addresses /path/to/lic-investigator-state.json
```

Additional output:

1. `data/hash-graph/address-propagation.json`

This file contains:

1. Direct assignments from seed addresses
2. Inferred assignments for connected listings
3. Per-address listing totals
4. Conflict components when multiple addresses appear in one component

## Graph Concepts

Terminology used by `listing-graph.json`:

1. Node: one listing (`id`)
2. Edge: two listings connected by similar images under hash thresholds
3. Component: connected cluster of listings

Important interpretation note:

1. Components are not guaranteed 1:1 with buildings
2. One building can split into multiple components
3. Multiple buildings can merge if they reuse similar/model images

Treat components as high-value clustering signals, then validate with manual Lens evidence.

## Local Data Contracts

`data/listings.json`:

1. Array of listing objects
2. Includes `id`, `title`, `price`, `beds`, `baths`, `sqft`, `imageUrls`, and more

`data/image-map.json`:

1. Object keyed by image URL
2. Value is array of listing IDs that reference that image URL

`data/hash-graph/listing-graph.json`:

1. `nodes`: listing-level graph nodes
2. `edges`: weighted listing connections via matched images
3. `components`: connected clusters
4. `totals`: graph-level metrics

## Security and Operational Notes

1. Browser geocoding is now config-driven via `tool/config.local.js` (generated from `.env`)
2. For Cloudflare deployment, prefer `LIC_GEOCODE_ENDPOINT` and keep Google keys server-side only
3. Treat UI import files as untrusted input; current UI includes sanitization improvements
4. Large files in `data/images-cache` and `data/hash-graph` are generated artifacts

## Troubleshooting

Scrape script exits non-zero:

1. Check terminal errors for failed URLs
2. Re-run `bash scripts/scrape-all.sh`; failed outputs are removed automatically for retry

Parser output looks stale:

1. Re-run `node scripts/parse-listings.js`

Hash graph run is slow:

1. First run downloads all images
2. Use `--skip-download` for iterative reruns
3. Use lower `--max-image-matches-output` if output size is too large

## Cloud Deployment

See `docs/cloudflare-deployment.md` for:

1. Required Cloudflare services
2. D1 schema and data flow
3. Live propagation API design
4. Deployment and operations checklist

Quick start (Worker + D1):

```bash
# from repo root
node scripts/generate-d1-seed-sql.js
node scripts/prepare-worker-public.js

cd apps/worker
# apply migrations
wrangler d1 execute lic-listings --file migrations/0001_initial_schema.sql
wrangler d1 execute lic-listings --file migrations/0002_add_component_id.sql
# seed data
wrangler d1 execute lic-listings --file seed/seed.sql
# deploy
wrangler deploy
```

## Code Quality

Root JS tooling is configured with Biome + TypeScript `checkJs`:

```bash
npm install
npm run format
npm run lint
npm run typecheck
npm run check
npm run check:fix
```

Pre-commit hooks are configured via `lefthook.yml`. In non-git directories, hook install is skipped automatically.
