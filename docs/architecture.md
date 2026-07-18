# Architecture

ChromeLens is a local pipeline:

```text
Chrome / Brave extension
  -> authenticated loopback event batches
  -> SQLite raw event store
  -> versioned interval and episode derivation
  -> collector-hosted local dashboard

Chrome / Brave History snapshot
  -> schema-introspecting importer
  -> SQLite historical facts

Local Git repository
  -> generic output connector
  -> idempotent output facts
  -> configurable temporal episode links
```

## Module interfaces

- `privacy`: turns an untrusted URL or activity event into a persistable observation or an excluded transition marker.
- `browser-history-import`: discovers profiles and imports a safe snapshot through one `importProfile` interface.
- `database`: owns migrations, idempotent writes, annotations, output links, deletion, export, and dashboard reads.
- `sessionisation`: turns ordered events into active intervals, focus periods, and explainable research episodes.
- `analytics`: returns daily and weekly dashboard summaries with metric definitions and caveats.
- `connectors`: defines output observation and includes a local Git adapter.
- `collector`: authenticates requests and coordinates the modules above.
- `extension`: observes browser APIs and owns an offline delivery queue; it never reads page content or form data.

Tracking control is a timestamped local state shared through the authenticated collector. Dashboard changes are enforced by the collector immediately; the extension reconciles the newest local/collector state on its one-minute alarm and when options are saved, so an offline popup pause remains authoritative when connectivity returns.

Complexity is kept behind these interfaces. SQLite, the filesystem, Chrome APIs, HTTP, time, and Git are adapters at real seams; domain tests exercise public behavior rather than private helpers.
