-- Suggested Cloudflare D1 schema for live listing/image graph updates.
-- Intended for incremental recomputation after new Lens discoveries.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,                 -- ISO timestamp or UUID
  created_at TEXT NOT NULL,
  phash_threshold INTEGER NOT NULL,
  dhash_threshold INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,                 -- listing id from source site
  web_id TEXT,
  title TEXT,
  source_url TEXT,
  price INTEGER,
  beds INTEGER,
  baths INTEGER,
  sqft INTEGER,
  updated_at TEXT NOT NULL,
  metadata_json TEXT                  -- full listing payload used by /api/bootstrap
);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,                 -- sha1(url)
  url TEXT NOT NULL UNIQUE,
  content_type TEXT,
  bytes INTEGER,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_images (
  listing_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  position INTEGER,
  PRIMARY KEY (listing_id, image_id),
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS image_hashes (
  image_id TEXT PRIMARY KEY,
  phash_hex TEXT NOT NULL,
  dhash_hex TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
);

-- Optional: store pairwise image matches produced by each run.
CREATE TABLE IF NOT EXISTS image_matches (
  run_id TEXT NOT NULL,
  image_a_id TEXT NOT NULL,
  image_b_id TEXT NOT NULL,
  phash_distance INTEGER NOT NULL,
  dhash_distance INTEGER NOT NULL,
  PRIMARY KEY (run_id, image_a_id, image_b_id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (image_a_id) REFERENCES images(id) ON DELETE CASCADE,
  FOREIGN KEY (image_b_id) REFERENCES images(id) ON DELETE CASCADE
);

-- Aggregated listing graph edges per run.
CREATE TABLE IF NOT EXISTS listing_edges (
  run_id TEXT NOT NULL,
  listing_a_id TEXT NOT NULL,
  listing_b_id TEXT NOT NULL,
  matched_image_pairs INTEGER NOT NULL,
  min_phash_distance INTEGER NOT NULL,
  min_dhash_distance INTEGER NOT NULL,
  avg_phash_distance REAL NOT NULL,
  avg_dhash_distance REAL NOT NULL,
  sample_image_pairs_json TEXT,       -- JSON array of sample URL pairs for UI evidence
  PRIMARY KEY (run_id, listing_a_id, listing_b_id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (listing_a_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY (listing_b_id) REFERENCES listings(id) ON DELETE CASCADE
);

-- Manual truth inputs from Google Lens / reverse image search.
CREATE TABLE IF NOT EXISTS address_assertions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'google_lens',
  confidence REAL NOT NULL DEFAULT 1.0,
  asserted_at TEXT NOT NULL,
  asserted_by TEXT,                    -- user id/email/handle
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

-- Final assignment used by UI/backend (direct or inferred).
CREATE TABLE IF NOT EXISTS listing_address_assignments (
  run_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  address TEXT NOT NULL,
  normalized_address TEXT NOT NULL,
  source TEXT NOT NULL,                -- direct | inferred_component | etc.
  confidence REAL NOT NULL,
  PRIMARY KEY (run_id, listing_id),
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_listing_images_image_id
  ON listing_images(image_id);

CREATE INDEX IF NOT EXISTS idx_image_matches_run
  ON image_matches(run_id);

CREATE INDEX IF NOT EXISTS idx_listing_edges_run
  ON listing_edges(run_id);

CREATE INDEX IF NOT EXISTS idx_address_assertions_listing
  ON address_assertions(listing_id);

CREATE INDEX IF NOT EXISTS idx_address_assertions_norm
  ON address_assertions(normalized_address);

CREATE INDEX IF NOT EXISTS idx_listing_address_assignments_norm
  ON listing_address_assignments(normalized_address);

-- Quick lookup: "how many listings per uncovered address"
CREATE VIEW IF NOT EXISTS v_address_listing_counts AS
SELECT
  normalized_address,
  MIN(address) AS representative_address,
  COUNT(*) AS listing_count
FROM listing_address_assignments
GROUP BY normalized_address
ORDER BY listing_count DESC;
