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

Selected local calendar range
  -> privacy-graded analysis-pack projection
  -> exact local preview
  -> Markdown or JSONL file chosen by the user
```

## Module interfaces

- `privacy`: turns an untrusted URL or activity event into a persistable observation or an excluded transition marker.
- `browser-history-import`: discovers profiles and imports a safe snapshot through one `importProfile` interface.
- `database`: owns migrations, idempotent writes, annotations, output links, deletion, export, and dashboard reads.
- `review`: derives deterministic review items from episodes, annotations, ideas, and outputs while preserving evidence references.
- `insights`: derives deterministic, thresholded observations with explicit basis, sample size, caveats, and evidence references; it contains no model-generated prose or productivity scoring.
- `search`: ranks local retained evidence documents deterministically across prospective, user-authored, associated, and historical provenance.
- `sessionisation`: turns ordered events into active intervals, focus periods, and explainable research episodes.
- `calendar-analysis`: projects UTC intervals and episodes into DST-safe local calendar windows and clips evidence at window edges.
- `analysis-pack`: turns selected daily evidence into token-budgeted aggregate, contextual, or detailed records and renders Markdown/JSONL adapters.
- `analytics`: returns daily and weekly dashboard summaries with metric definitions and caveats.
- `connectors`: defines output observation and includes a local Git adapter.
- `collector`: authenticates requests and coordinates the modules above.
- `extension`: observes browser APIs and owns an offline delivery queue; it never reads page content or form data.

Tracking control is a timestamped local state shared through the authenticated collector. Dashboard changes are enforced by the collector immediately; the extension reconciles the newest local/collector state on its one-minute alarm and when options are saved, so an offline popup pause remains authoritative when connectivity returns.

The collector exposes `/api/diagnostics/connection` as an authenticated health contract. It reports the supported API schema, tracking state, last observed event, tracking-control reachability, and a deterministic version of the canonical privacy configuration. `/api/health` remains a minimal unauthenticated liveness route and is not sufficient for extension connection trust.

Privacy configuration is owned by the collector and retrieved through `/api/privacy/config`. The extension stores the last verified remote version and applies a restrictive union with its local rules before queueing. The collector applies its canonical rules again before persistence. This preserves bounded offline delivery while ensuring a stale or less restrictive extension cache cannot weaken persistence privacy.

The extension reports bounded delivery health through the authenticated `/api/diagnostics/delivery` endpoint after queue flush attempts. Queue length, dropped-event count, and privacy-version drift are advisory local health facts; reporting failures never block offline queueing.

Range summaries accept explicit calendar-week, calendar-month, rolling-7, rolling-30, and custom modes. Local calendar boundaries are converted to UTC through `calendar-analysis` before database queries. Git collection uses the same local-day window, so output evidence and activity evidence share calendar semantics.

The authenticated `/api/overview` route combines a selected range summary with an equal-length preceding-period comparison, evidence coverage, deterministic review items, recent ideas and outputs, and resume candidates. Review navigation returns to the day evidence surface; it does not turn associations or missing records into productivity judgements.

The authenticated `/api/history/summary` route projects imported browser history into the requested IANA timezone, applies the canonical privacy projection before returning URLs or search terms, and accepts independent browser/profile filters. Its response includes historical-only counts, revisited pages, profile provenance, and import-run metadata; it never labels browser-recorded elapsed duration as active time.

The authenticated `/api/insights` route exposes the same deterministic insight set used by Overview. Comparative observations require an equal-length multi-day sample and report observed days for both periods; every result carries evidence references and caveats.

The authenticated `/api/search` route searches only retained local fields, applies the canonical privacy projection to historical records, and returns provenance plus navigation targets. `/api/patterns` combines range summaries, insights, annotation-conditioned observations, and explainable resume candidates. Analysis exports remain explicit downloads; a selected question preset is recorded in the exact previewed manifest rather than sent anywhere automatically.

Complexity is kept behind these interfaces. SQLite, the filesystem, Chrome APIs, HTTP, time, and Git are adapters at real seams; domain tests exercise public behavior rather than private helpers.

Accepted event batches recompute active intervals only for affected browser sessions, then regroup episodes from stored intervals. Human annotations store interval/time anchors and are re-associated across derivation identity changes. Rename, split-before, and merge-before corrections are separate user-authored facts anchored to stable interval IDs and applied by sessionisation during every regrouping. Schema migrations add durable fields to existing local databases without discarding records.
