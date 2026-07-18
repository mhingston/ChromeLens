-- Human-authored split, merge, and label corrections remain separate from derived episodes.
CREATE TABLE episode_corrections(
  correction_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  correction_type TEXT NOT NULL,
  anchor_interval_id TEXT NOT NULL,
  label TEXT
);
CREATE INDEX episode_corrections_anchor_idx ON episode_corrections(anchor_interval_id);
INSERT INTO schema_migrations(version, applied_at) VALUES (3, CURRENT_TIMESTAMP);
