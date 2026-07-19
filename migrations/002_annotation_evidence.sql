-- Existing databases receive durable anchors for human-authored episode annotations.
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
ALTER TABLE annotations ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}';
INSERT INTO schema_migrations(version, applied_at) VALUES (2, CURRENT_TIMESTAMP);
