# Testing approach

Core behavior is built in vertical RED/GREEN slices and tested through public module interfaces. Tests use temporary real SQLite databases rather than mocks. Filesystem, browser APIs, HTTP, time, and Git are treated as seams with production and test adapters where behavior varies.

Coverage targets timestamp conversion, profile discovery, snapshot-based import and idempotency, schema variation, URL privacy and collector self-exclusion, authenticated ingestion, excluded-context handling, active-time state transitions, session boundaries, focus and switch metrics, deterministic episode evidence, real temporary Git commit collection, configurable output association, annotations, deletion, export, extension buffering behavior, and dashboard queries.

Final verification runs type checking, deterministic tests, production builds, collector integration checks, and headed Chrome-extension testing with `agent-browser`.
