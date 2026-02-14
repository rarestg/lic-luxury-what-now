ALTER TABLE listings ADD COLUMN metadata_json TEXT;

ALTER TABLE listing_edges ADD COLUMN sample_image_pairs_json TEXT;

UPDATE listings
SET metadata_json = '{}'
WHERE metadata_json IS NULL;

UPDATE listing_edges
SET sample_image_pairs_json = '[]'
WHERE sample_image_pairs_json IS NULL;

INSERT OR IGNORE INTO _migrations (id, applied_at)
VALUES ('0003_add_bootstrap_metadata', CURRENT_TIMESTAMP);
