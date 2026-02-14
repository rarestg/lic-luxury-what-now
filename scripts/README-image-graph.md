# Perceptual Image Graph Pipeline

This repo now includes `scripts/build-image-graph.py` for:

1. Bulk-parallel downloading listing images
2. Perceptual hashing (`pHash` + `dHash`)
3. Image-to-image similarity matching via Hamming distance
4. Listing-to-listing graph generation based on matched images
5. Optional address propagation from known listing addresses

## Install

```bash
pip3 install imagehash pillow
```

## Run (full pipeline)

```bash
python3 scripts/build-image-graph.py
```

## Run with known addresses (from tool export)

If you export state from `tool/index.html`, pass that JSON file:

```bash
python3 scripts/build-image-graph.py \
  --seed-addresses /path/to/lic-investigator-state.json
```

`--seed-addresses` accepts:

1. Tool export format: `{ "state": { listingId: { address, resolved } } }`
2. Plain object: `{ "169510": "42-XX Some St, Queens, NY" }`
3. Array format: `[{"listingId":"169510","address":"...","resolved":true}]`

## Output files

Generated under `data/hash-graph/`:

1. `image-hashes.json`:
- One row per unique image URL
- Download metadata + hashes + listing IDs

2. `image-similarity.json`:
- Matched image pairs (`phash` / `dhash` distances)
- Global match stats

3. `listing-graph.json`:
- Nodes: listings
- Edges: listing pairs with matched-image support
- Components: connected groups of related listings

4. `address-propagation.json` (only when `--seed-addresses` is provided):
- Direct assignments from seed addresses
- Inferred assignments by connected component
- Conflict components (multiple seed addresses in same component)
- Per-address listing counts

## Tunable matching thresholds

Defaults:

1. `--phash-threshold 8`
2. `--dhash-threshold 10`

Lower thresholds reduce false positives, higher thresholds catch more transformed images.

## Useful options

```bash
python3 scripts/build-image-graph.py \
  --download-workers 24 \
  --download-timeout 25 \
  --download-retries 3 \
  --min-edge-support 1 \
  --max-image-matches-output 50000
```

For hash-only reruns with already-downloaded cache:

```bash
python3 scripts/build-image-graph.py --skip-download
```
