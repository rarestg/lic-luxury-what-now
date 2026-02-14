CREATE INDEX IF NOT EXISTS idx_address_assertions_listing_latest
  ON address_assertions(listing_id, asserted_at DESC, id DESC);

INSERT OR IGNORE INTO _migrations (id, applied_at)
VALUES ('0004_optimize_latest_assertions', CURRENT_TIMESTAMP);
