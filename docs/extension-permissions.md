# Extension permissions

- `tabs`: reads active-tab URL and title metadata and observes tab activation, creation, updates, and closure. No page content is read.
- `windows`: observes browser-window focus changes so active time stops when the browser loses focus.
- `idle`: observes active, idle, and locked states so inactivity is never counted as foreground active time.
- `storage`: stores explicit settings and the bounded offline delivery queue locally; session storage namespaces tab IDs by browser session.
- `alarms`: wakes the Manifest V3 service worker periodically to retry queued delivery after collector outages.
- loopback host access: sends authenticated batches only to `localhost`/loopback collector URLs. Remote hosts are rejected in settings.

The extension does not request `history`, `webNavigation`, scripting, clipboard, downloads, cookies, or broad page host access. Historical import is performed by the local collector from a safe database snapshot, so browser-history permission is unnecessary.
