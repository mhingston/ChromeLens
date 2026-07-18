# ADR 0001: Local-first event-sourced architecture

Status: accepted — 2026-07-18

## Context

ChromeLens must import changing Chromium history schemas, capture prospective browser state without page-content access, survive collector outages, preserve observed facts separately from inference, and keep sensitive data on the user's machine.

## Decision

- Use a TypeScript monorepo-shaped repository with deep modules for privacy, history import, storage, sessionisation, analytics, and output connectors.
- Use Node's built-in SQLite driver for one local database. The database is an operational event store and analytical source; DuckDB is deferred until scale demonstrates a need.
- Use a loopback HTTP collector bound only to `127.0.0.1`, authenticated by a generated bearer token. Native messaging remains a release-hardening option.
- Host the static local dashboard from the collector. Sensitive endpoints require the bearer token; the UI retains it only in browser local storage after explicit entry.
- Capture prospective activity as immutable, idempotent events. Rebuild active intervals and research episodes from raw events with versioned deterministic derivations.
- Buffer extension events in `chrome.storage.local`, batch delivery, retry with bounded exponential backoff, and expose dropped-event counts.
- Copy `History`, `History-wal`, and `History-shm` into a temporary directory before schema introspection or import. Never query the live profile database.
- Apply exclusions and redaction in both the extension and collector. Excluded contexts retain only a transition marker so active-time calculation stops without persisting the sensitive URL, domain, or title.
- Keep raw facts and derived interpretations separate. No LLM dependency ships in the initial release; the dashboard explicitly labels the feature disabled.
- Retain local raw data until the user deletes it. Deletion invalidates and rebuilds affected derived data.

## Consequences

The loopback collector is straightforward to audit and test, but its bearer token must be treated like a local secret. Node 24+ is required for the built-in SQLite module. Event-sourced derivation costs more processing than mutable timers but makes active-time calculations explainable and reproducible. Chrome and Brave schema drift is handled by runtime introspection rather than version-specific queries.
