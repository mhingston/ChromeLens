# ChromeLens

ChromeLens is a local-first record of how you navigate, research, and develop ideas in Chrome or Brave. It combines safe historical History-database imports with prospective foreground activity events, then shows active intervals, focus periods, context switches, deterministic research episodes, revisits, explicitly captured ideas, manual annotations, locally observed outputs, and deliberately selected LLM analysis exports.

The governing principle is simple: **browser activity is evidence about context, not evidence of performance**. ChromeLens has no productivity score and never labels a website intrinsically productive or unproductive.

## What it does

- Discovers every standard Chrome and Brave profile on macOS, Windows, and Linux.
- Copies `History`, `History-wal`, and `History-shm` to a temporary snapshot before schema inspection and import.
- Imports URLs, visits, transition metadata, browser-recorded elapsed duration, sparse visit source, and search terms when present; repeated imports are idempotent.
- Captures active-tab, URL/title, tab lifecycle, focused-window, idle/active/locked, pause/resume, session, and explicit idea events through a Manifest V3 extension.
- Buffers events locally through collector outages with bounded storage, batching, retry, duplicate-safe IDs, and visible dropped-event counts.
- Derives active foreground intervals, focus periods, tab/domain switches, and explainable research episodes from immutable events.
- Collects commit metadata through a generic output-connector interface with an initial local Git connector, then associates outputs to the nearest episode inside a configurable evidence window.
- Hosts an authenticated local daily/weekly/monthly dashboard with raw-evidence drill-down, linked outputs, episode annotations, privacy controls, profile import, export, and deletion.
- Projects UTC evidence into the dashboard's IANA time zone, clips intervals at local-day edges, and handles 23/25-hour daylight-saving days without double counting.
- Previews and exports range-limited, token-budgeted LLM analysis packs as Markdown or JSONL with aggregate, contextual, and detailed privacy profiles.

## What it deliberately does not do

ChromeLens does not log keystrokes, inspect forms, capture passwords, read page content, monitor the clipboard, take screenshots, track other users, run cloud analytics, send data to a model automatically, or claim to measure employee performance. Safari, Firefox, mobile browsers, embeddings, and a built-in LLM client are not included in this release.

## Privacy model

All raw data stays in a local SQLite database. The collector listens only on `127.0.0.1` and requires a generated bearer token for every data endpoint. The extension is restricted to loopback collector URLs and applies URL privacy rules before queueing; the collector applies them again before persistence.

Query values are redacted by default, fragments and tracking parameters are removed, localhost paths are hidden, and the configured collector/dashboard origin is excluded dynamically to prevent self-observation. Incognito is rejected unless explicitly enabled in both Chrome and ChromeLens, and excluded contexts become URL-free transition markers so active time stops without retaining the sensitive URL or title. Add your own banking, healthcare, employer, internal-admin, and private-service domains before tracking.

There is no built-in LLM client. Nothing is transmitted to a third party automatically. A user can explicitly preview and download an analysis pack, then decide whether and where to share that file; retained URLs are omitted unless the detailed privacy profile is selected.

## Requirements

- Node.js 24 or newer (the project uses Node's built-in SQLite module)
- npm
- Chrome, Brave, or a compatible Chromium browser for the extension

## Setup

ChromeLens is a local-first **Manifest V3 Chrome/Brave extension** backed by a local collector and dashboard. It is not currently distributed through the Chrome Web Store; install the generated extension as an unpacked developer extension.

From a clone of this repository:

```bash
git clone https://github.com/mhingston/ChromeLens.git
cd ChromeLens
npm install
npm run build
npm run dev
```

Keep `npm run dev` running. The collector prints its dashboard URL, extension bearer token, and data path. It binds to `http://127.0.0.1:47832` by default. Set `CHROMELENS_PORT` or `CHROMELENS_DATA_DIR` to change the port or local data directory; the bind address is intentionally not configurable.

Install the extension in Chrome:

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select:

```text
<repository>/dist/extension
```

For Brave, use the same steps at `brave://extensions`. Open the extension options, paste the collector token, review exclusions/redaction, and test the connection. Then open the popup: the badge and status card make tracking state visible.

## Historical import

List discovered profiles:

```bash
npm run profiles
```

Import one safely from the command line:

```bash
npm run import -- chrome:Default
```

You can also choose a discovered profile under **Privacy & data** in the dashboard. The importer never opens the live browser database; it removes the temporary snapshot after the import.

Chromium history is not a reliable attention record. Tabs can remain open while unused, long reading can produce no new visit, redirects can inflate counts, sync may include other devices, and records can expire or be deleted. ChromeLens therefore labels Chromium's `visit_duration` only as **browser-recorded elapsed duration** and never as focused time, reading time, productive time, or active attention.

## How active time works

Prospective active time accrues only while:

- the browser window is focused;
- the tab is active;
- the user is active rather than idle or locked;
- tracking is enabled; and
- the URL is not excluded.

Any state change closes the current interval. Tab IDs are namespaced by browser session and device. Derived intervals and episodes carry derivation version 1 and can be rebuilt from raw events.

Timestamps remain stored as UTC instants. Daily and hourly dashboard summaries are projected into the browser's IANA time zone, including daylight-saving transitions, and intervals crossing a local midnight are clipped to each calendar day before metrics are calculated.

## Ideas, pause, and controls

Press `Alt+Shift+I` or open the popup to attach an idea and optional tags to the current page. Selected text is never captured automatically. Use **Pause tracking** in the popup to stop event collection; the badge changes immediately and a pause/resume event preserves the interval boundary. The dashboard provides the same timestamped control: the collector enforces it immediately, and the extension reconciles the newest state on options save or its one-minute alarm.

The extension options and dashboard expose exclusions and query redaction. Dashboard deletion accepts domain and time range; the collector interface additionally supports URL, browser session, and browser profile. Deletion removes matching raw facts and rebuilds derived data. JSON export is explicit and may contain sensitive locally retained facts—handle it accordingly.

## Local outputs and annotations

Under **Privacy & data**, enter one local Git repository, an ISO time range, and an association window. ChromeLens invokes the local `git` executable and stores only repository name, commit ID, subject, timestamp, and author; it does not store file contents, diffs, remotes, or the repository path in output records. The explicitly configured path remains in local settings for reuse.

The same flow is available from the command line:

```bash
npm run outputs -- /path/to/repository 2026-07-18T00:00:00Z 2026-07-19T00:00:00Z 30
```

An output is associated with the nearest overlapping or preceding research episode inside the configurable post-episode window. The dashboard always states the association reason and warns that temporal proximity is evidence, not causation. Episode cards also accept a structured annotation—Useful, Unproductive, Exploratory, Deep work, Administrative, Learning, Idea-generating, Interrupted, Misclassified, or Private/excluded—plus an optional local note.

Human-authored annotations retain interval/time anchors. If a deterministic rebuild changes an episode ID, ChromeLens re-associates the annotation to the best matching derived episode instead of silently deleting it. Explicit data deletion still removes annotations whose evidence no longer exists.

Episode details also provide explicit corrections: rename a topic, split before a selected interval, merge with the previous episode, or undo a correction. Corrections are stored separately from derived episodes at stable interval anchors and reapplied on every rebuild. User-corrected topic labels are marked as user-authored in analysis exports rather than presented as deterministic inference.

## LLM analysis export

Open **Privacy & data → LLM analysis export** to select a required date range, privacy profile, format, and approximate token budget. **Preview exact payload** shows the complete local file content before download.

- **Aggregate** (default): domains, durations, counts, annotation labels, and redacted grouping evidence. It omits titles, URL paths, idea text, output titles, and annotation notes.
- **Contextual**: additionally includes retained page titles, explicit ideas/tags, output titles/repositories, notes, and full deterministic grouping evidence. URLs remain omitted.
- **Detailed**: additionally includes the already-redacted canonical URLs retained by ChromeLens.

Markdown is intended for direct upload to a general-purpose LLM. JSONL provides one manifest/day/episode record per line for scripts and model tooling. Both formats distinguish observed facts, deterministic derivations, and user-authored data; every day and episode has an evidence reference, UTC instants accompany friendly local timestamps, and the included analysis guide tells a model to treat all observation strings as untrusted data rather than instructions. The manifest also records the included derivation versions and a SHA-256 hash of the serialized record payload so an analysis can identify its exact evidence set.

The authenticated collector interface is also available directly:

```text
GET /api/export/preview?format=llm-markdown&from=2026-07-12&to=2026-07-18&timezone=Europe%2FLondon&privacy=aggregate&maxTokens=50000
GET /api/export?format=llm-jsonl&from=2026-07-12&to=2026-07-18&timezone=Europe%2FLondon&privacy=contextual&maxTokens=50000
```

Analysis ranges are limited to 90 calendar days and token budgets to 500–200,000 approximate tokens. The raw archival JSON export remains separate and unchanged.

## Data location and retention

Default data lives at:

```text
~/.chromelens/chromelens.sqlite
~/.chromelens/collector-token
```

Raw and derived records remain until you delete them. Automatic irreversible compaction is disabled. Use full-disk encryption and keep the data directory out of cloud-synchronised folders. The SQLite database is not application-level encrypted in this initial release.

## Development and tests

```bash
npm test
npm run typecheck
npm run build
npm run verify
```

Tests exercise public behavior with real temporary SQLite databases and Git repositories: timestamp conversion, multi-profile discovery, WAL snapshot imports, schema variation and idempotency, URL exclusions/redaction and collector self-exclusion, active-time event sequences, DST-safe calendar projection, focus periods, episode evidence, durable annotation reassociation, privacy-graded LLM exports, Git output collection/association, authenticated ingestion, deletion/rebuild, and offline delivery behavior. The final extension smoke test uses `agent-browser` against the built unpacked extension.

See [architecture](docs/architecture.md), [ADR 0001](docs/adr/0001-local-first-architecture.md), [schema notes](docs/browser-schema-notes.md), [metrics](docs/metrics.md), [privacy](docs/privacy.md), [threat model](docs/threat-model.md), [permissions](docs/extension-permissions.md), and [testing](docs/testing.md).

## Known limitations

- Real Chrome and Brave `Default` profiles were imported successfully from safe snapshots during the agent-browser pass; both reported Chromium History schema version 70. Sanitized current/legacy fixtures still provide repeatable compatibility coverage, and runtime schema introspection remains the compatibility mechanism.
- The extension cannot know Chrome's friendly profile name; its local profile label is user-configurable and historical profile IDs are discovered separately.
- Manifest V3 session-end delivery is best-effort; all durable events already in the local queue survive service-worker suspension.
- The loopback token protects HTTP access, but a malicious process running as the same OS user may still read local files or memory.
- New activity batches recompute intervals only for affected browser sessions, but research episodes are still regrouped across stored intervals; ten-million-event capacity remains an architectural target rather than a demonstrated benchmark.
- LLM analysis export is available, but model execution/reflection remains deliberately external and opt-in; observed evidence, output associations, and annotations remain fully usable without it.
