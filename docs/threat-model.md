# Threat model

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Another local process reads the collector | Loopback binding plus generated bearer token on every data endpoint | A process running as the same user may read local files or memory |
| Sensitive URL is persisted | Collector-enforced exclusions, query/fragment redaction, localhost path hiding | Titles and non-redacted paths may remain sensitive; add exclusions |
| Token embedded in a URL | Sensitive query keys are always redacted; fragments are removed | Secrets embedded directly in a path require a domain/path exclusion |
| Extension compromise or overcollection | Minimal permissions, no content scripts, no page-content access | Browser metadata still contains sensitive titles and URLs |
| Local database theft or cloud backup | Local-only storage, documented disk-encryption and backup guidance | No application-level database encryption in the initial release |
| Collector outage | Bounded local queue, idempotent IDs, batching, retry and visible drop count | Queue capacity can be exhausted during a long outage |
| Chromium schema change | Snapshot first, inspect tables/columns, skip optional fields, report imported fields | A breaking removal of core tables blocks import safely |
| Malicious title/URL prompt injection | No built-in LLM client; analysis packs use structured records, mark all strings as untrusted data, omit titles/URLs in aggregate mode, and require exact preview before download | A model chosen by the user may still mishandle malicious or misleading strings |
| Accidental over-sharing through an LLM export | Required date range, aggregate-by-default privacy profile, URL opt-in, token budget, exact preview, and explicit download | Contextual ideas, titles, outputs, and notes may still be sensitive |
| Incognito collection | Extension rejects incognito tabs by default even if Chrome grants incognito access | Explicit user opt-in intentionally changes this guarantee |
