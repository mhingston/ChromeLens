# Privacy and retention

ChromeLens is local-first. The collector binds to loopback, the SQLite database and authentication token remain under the configured local data directory, and no third-party analytics or LLM client is included.

Collection is visible in the extension popup and can be paused. Incognito events are rejected unless the user explicitly enables them. The extension does not request scripting access, inspect page content, capture selected text automatically, read forms, log keys, monitor the clipboard, or take screenshots.

Privacy rules are applied twice: before an event enters the extension queue and again at ingestion. Query values and URL fragments are redacted by default, localhost paths are hidden by default, known tracking parameters are removed, and excluded contexts are reduced to URL-free state-transition events. The extension dynamically excludes its configured collector origin so ChromeLens does not measure its own dashboard. Default exclusions cover common authentication, webmail, password-manager, healthcare, and banking contexts; users should add institution-specific domains before tracking.

The Git connector runs only after an authenticated, explicit local request. Output records contain repository basename, commit ID, subject, time, author, and association evidence; no diffs, file contents, remotes, or repository paths are copied into output facts. The selected path remains only in local connector settings for reuse.

Raw and derived data are retained until the user deletes them. The dashboard supports deletion by domain, URL, time range, session, and browser profile, then rebuilds derivations. Export is explicit. Database files may still be exposed by device compromise or cloud backup; use full-disk encryption and exclude the data directory from cloud sync.

LLM reflection is disabled and unimplemented in this release. A future implementation must preview a deliberately selected aggregate payload and treat all browser-derived strings as untrusted observations.
