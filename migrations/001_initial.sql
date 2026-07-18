-- Canonical migration source is INITIAL_SCHEMA in packages/database/src/index.ts so bundled builds are self-contained.
-- This file records the migration boundary for operators and future schema evolution.
PRAGMA foreign_keys = ON;

-- Raw facts
CREATE TABLE activity_events(event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, event_type TEXT NOT NULL, occurred_at TEXT NOT NULL, received_at TEXT NOT NULL, device_id TEXT NOT NULL, browser TEXT, browser_version TEXT, browser_profile_id TEXT, browser_session_id TEXT, window_id TEXT, tab_id TEXT, url TEXT, canonical_url TEXT, domain TEXT, title TEXT, navigation_type TEXT, referrer_url TEXT, idle_state TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE historical_urls(source_browser TEXT NOT NULL, source_profile_id TEXT NOT NULL, source_url_id INTEGER NOT NULL, url TEXT NOT NULL, canonical_url TEXT, domain TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_at TEXT, imported_at TEXT NOT NULL, PRIMARY KEY(source_browser, source_profile_id, source_url_id));
CREATE TABLE historical_visits(source_browser TEXT NOT NULL, source_profile_id TEXT NOT NULL, source_visit_id INTEGER NOT NULL, source_url_id INTEGER NOT NULL, visited_at TEXT NOT NULL, browser_elapsed_duration_ms INTEGER, transition_type TEXT, transition_raw INTEGER, referring_visit_id INTEGER, opener_visit_id INTEGER, visit_source TEXT, imported_at TEXT NOT NULL, PRIMARY KEY(source_browser, source_profile_id, source_visit_id));

-- Derived interpretations are deliberately separate and versioned.
CREATE TABLE active_intervals(interval_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, browser_profile_id TEXT, browser_session_id TEXT, tab_id TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, url TEXT, canonical_url TEXT, domain TEXT, title TEXT, termination_reason TEXT NOT NULL, derivation_version INTEGER NOT NULL);
CREATE TABLE research_episodes(episode_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, topic_label TEXT, topic_confidence REAL, active_duration_ms INTEGER NOT NULL, idle_duration_ms INTEGER NOT NULL, unique_domains INTEGER NOT NULL, unique_urls INTEGER NOT NULL, tab_switch_count INTEGER NOT NULL, domain_switch_count INTEGER NOT NULL, idea_count INTEGER NOT NULL, output_count INTEGER NOT NULL, derivation_version INTEGER NOT NULL, evidence_json TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE captured_ideas(idea_id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, text TEXT NOT NULL, source_url TEXT, source_title TEXT, episode_id TEXT, tags_json TEXT NOT NULL DEFAULT '[]', created_via TEXT NOT NULL);
CREATE TABLE annotations(annotation_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, episode_id TEXT, label TEXT, note TEXT);
CREATE TABLE outputs(output_id TEXT PRIMARY KEY, output_type TEXT NOT NULL, occurred_at TEXT NOT NULL, title TEXT, reference TEXT, repository TEXT, source_connector TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE output_episode_links(output_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, gap_ms INTEGER NOT NULL, reason TEXT NOT NULL, association_version INTEGER NOT NULL);
