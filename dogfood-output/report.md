# Dogfood Report: ChromeLens

| Field | Value |
| --- | --- |
| **Date** | 2026-07-18 |
| **App URL** | http://127.0.0.1:47832 |
| **Session** | chromelens-ext-e2e (Chrome for Testing 131) |
| **Scope** | Unpacked extension, collector delivery, popup/options, browser-history import, and local dashboard |

## Summary

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 1 |
| **Total** | **3** |

## Issues

### ISSUE-001: Historical import leaves the stored-visit count stale

- **Severity:** Medium
- **Category:** Functional / state refresh
- **Page:** `http://127.0.0.1:47832/#settings`
- **Evidence:** [before import](screenshots/issue-001-import-step-2-before.png), [after import](screenshots/issue-001-import-step-3-result.png), [video](videos/issue-001-import-stale.webm)

**Reproduction**

1. Open **Privacy & data**.
2. Select a discovered browser profile.
3. Click **Import safe snapshot**.
4. Observe a success notice for 13,385 imported visits while the card still says 7 visits are stored.

**Expected:** The stored total refreshes after a successful import.

**Actual:** The total remains at the value fetched when the settings view first rendered; reloading is a workaround.

**Resolution:** Fixed. The import handler now refetches the historical summary and updates the card. Verified by a repeat import showing `0 new visits` and the correct `13,392 visits currently stored` total in [the fixed build](screenshots/final-import-refresh-fixed.png).

### ISSUE-002: Date-navigation controls remain visible on the settings view

- **Severity:** Low
- **Category:** UX / layout
- **Page:** `http://127.0.0.1:47832/#settings`
- **Evidence:** [settings after import](screenshots/issue-001-import-step-3-result.png)

**Reproduction**

1. Open **Privacy & data**.
2. Observe the previous-date, date-picker, and next-date controls in the header.

**Expected:** Period navigation is hidden because it has no effect on settings.

**Actual:** The controls remain visible due to a CSS display rule overriding the HTML `hidden` attribute.

**Resolution:** Fixed. A project-level `[hidden]` rule now suppresses the controls; verified in [the fixed settings view](screenshots/final-privacy-fixed.png).

### ISSUE-003: ChromeLens records its own loopback dashboard as browsing activity

- **Severity:** Medium
- **Category:** Data accuracy / self-observation
- **Page:** `http://127.0.0.1:47832/`
- **Evidence:** [dashboard showing `127.0.0.1` as the top domain](screenshots/final-output-annotation.png)

**Reproduction**

1. Configure the extension with the default loopback collector.
2. Open the ChromeLens dashboard and move between its views.
3. Return to the daily view and observe `127.0.0.1` in Top domains and dashboard activity in derived episodes.

**Expected:** ChromeLens excludes its own collector/dashboard origin while retaining activity from other local-development ports.

**Actual:** Localhost paths were redacted, but the collector origin itself remained eligible for active-time derivation.

**Resolution:** Fixed. Default-port origin patterns and a dynamic exclusion derived from the configured collector URL now sanitize self-observation before queue persistence. [Browser re-verification](screenshots/final-dashboard-complete.png) shows retained Example/IANA activity, no loopback domain, a linked Git output, and a saved annotation.

## Additional completed-flow evidence

- [Git connector configuration](screenshots/final-git-connector-success.png)
- [Output-linked episode and annotation](screenshots/final-dashboard-complete.png)
- [Dashboard pause/retention controls](screenshots/final-dashboard-pause-control.png)
- [Weekly time-of-day pattern](screenshots/final-weekly-time-pattern.png)
