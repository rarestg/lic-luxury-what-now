ALTER TABLE listings ADD COLUMN component_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_listings_component
  ON listings(component_id);

INSERT OR IGNORE INTO _migrations (id, applied_at)
VALUES ('0002_add_component_id', CURRENT_TIMESTAMP);
