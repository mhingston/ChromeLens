# Metric definitions

All prospective metrics use derivation version 1 and can be rebuilt from activity events.

UTC instants are projected into the requested IANA time zone before calendar summaries are calculated. Intervals are clipped at local-day edges, including 23/25-hour daylight-saving days, so a cross-midnight interval contributes only its overlapping duration to each day.

- **Active foreground duration (observed):** time while the browser window is focused, the tracked tab is active, the user is active, tracking is enabled, and the context is not excluded.
- **Browser-recorded elapsed duration (historical fact):** Chromium's `visit_duration` value. It can include inactivity and is never labelled focused time, reading time, productive time, or attention.
- **Tab switches (observed):** transitions between different namespaced active tab IDs.
- **Domain switches (observed):** active-interval transitions between different persisted domains.
- **Unique context boundaries (observed):** active-interval transitions where either the namespaced tab ID or persisted domain changes. A transition changing both is counted once; it is not the sum of tab and domain switches.
- **Focus period (derived):** contiguous active intervals on the same domain separated by no more than the configured tolerance.
- **Context-switch rate (derived):** tab or domain switches divided by active hours; variants are reported separately.
- **Research episode (derived):** temporally close activity grouped with deterministic evidence from shared domains, title/URL tokens, and explicit ideas. The evidence is stored with the episode.
- **Episode correction (user-authored):** an explicit rename, split-before, or merge-before instruction anchored to a stable interval ID and reapplied during derivation. Corrected labels are identified as user-authored.
- **Revisit latency (derived):** elapsed time between visits to the same canonical URL.
- **Output-linked browsing (association):** an episode overlapping or preceding an observed output within a configured window. It is correlation, not causation.

Dashboard range modes are explicit: calendar week (Monday through Sunday), calendar month (the selected month), rolling 7 days, rolling 30 days, or a custom inclusive local-date range. Every range exposes its local start/end dates and IANA timezone. Previous-period comparisons, when shown, must use the same range mode and an equal number of local calendar dates.

Historical hourly counts are projected from stored UTC visit instants into the requested IANA timezone. They are historical visit facts and are never combined with prospective active foreground duration.

Historical records cannot reconstruct foreground attention: open tabs, idle time, deleted history, redirects, sync origin, and private browsing are incomplete or ambiguous.
