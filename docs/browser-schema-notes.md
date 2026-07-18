# Chromium history schema notes

Reviewed 2026-07-18.

Current schema assumptions were checked against Chromium `main`, exercised with sanitised SQLite fixtures, and smoke-tested through safe copies of discovered Chrome and Brave `Default` profiles. Both real snapshots reported History schema version 70 and imported successfully without opening the live databases. Runtime import introspects every snapshot before selecting fields.

Chromium `main` reports History schema version 70. Its `urls` table currently includes `id`, `url`, `title`, `visit_count`, `typed_count`, `last_visit_time`, `hidden`, and the legacy `favicon_id`. The `visits` table includes the stable core fields `id`, `url`, `visit_time`, `from_visit`, `transition`, `visit_duration`, and `opener_visit`, plus newer optional sync, annotation, visited-link, external-referrer, and app fields. `visit_source` is sparse: an absent row means locally browsed. Search terms live in the optional `keyword_search_terms` table.

Primary sources:

- [Current Chromium history database and schema version](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/history/core/browser/history_database.cc)
- [Current Chromium visit and visit-source tables](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/history/core/browser/visit_database.cc)
- [Current Chromium URL table](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/components/history/core/browser/url_database.cc)
- [Brave's documented relationship to Chromium](https://github.com/brave/brave-browser/wiki/Deviations-from-Chromium-%28features-we-disable-or-remove%29)

## Import policy

- Require `urls` and `visits`; report a clear error if either is absent.
- Read only columns discovered through `PRAGMA table_info` on the copied snapshot.
- Gracefully omit `visit_duration`, `opener_visit`, `visit_source`, and search terms when unavailable.
- Treat Chromium timestamps as microseconds since 1601 and convert through one tested function.
- Preserve raw transition integers and expose a decoded core transition label.
- Namespace source identifiers by browser and profile so repeated imports are idempotent.
- Label `visit_duration` only as browser-recorded elapsed duration, never focused or active time.
