# Metric definitions

All prospective metrics use derivation version 1 and can be rebuilt from activity events.

- **Active foreground duration (observed):** time while the browser window is focused, the tracked tab is active, the user is active, tracking is enabled, and the context is not excluded.
- **Browser-recorded elapsed duration (historical fact):** Chromium's `visit_duration` value. It can include inactivity and is never labelled focused time, reading time, productive time, or attention.
- **Tab switches (observed):** transitions between different namespaced active tab IDs.
- **Domain switches (observed):** active-interval transitions between different persisted domains.
- **Focus period (derived):** contiguous active intervals on the same domain separated by no more than the configured tolerance.
- **Context-switch rate (derived):** tab or domain switches divided by active hours; variants are reported separately.
- **Research episode (derived):** temporally close activity grouped with deterministic evidence from shared domains, title/URL tokens, and explicit ideas. The evidence is stored with the episode.
- **Revisit latency (derived):** elapsed time between visits to the same canonical URL.
- **Output-linked browsing (association):** an episode overlapping or preceding an observed output within a configured window. It is correlation, not causation.

Historical records cannot reconstruct foreground attention: open tabs, idle time, deleted history, redirects, sync origin, and private browsing are incomplete or ambiguous.
