import { describe, expect, it } from "vitest";
import type { ActiveInterval, ActivityEvent, ActivityEventType, CapturedIdea } from "../packages/domain/src/index.ts";
import { deriveActiveIntervals, deriveFocusPeriods, groupResearchEpisodes } from "../packages/sessionisation/src/index.ts";

function event(
  eventType: ActivityEventType,
  time: string,
  values: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    eventId: crypto.randomUUID(),
    schemaVersion: 1,
    eventType,
    occurredAt: `2026-07-18T${time}:00.000Z`,
    deviceId: "device-test",
    browser: "chrome",
    browserVersion: null,
    browserProfileId: "chrome:Default",
    browserSessionId: "session-test",
    windowId: "session-test:1",
    tabId: null,
    url: null,
    canonicalUrl: null,
    domain: null,
    title: null,
    navigationType: null,
    referrerUrl: null,
    idleState: "active",
    incognito: false,
    metadata: {},
    ...values,
  };
}

describe("prospective activity derivation", () => {
  it("accrues active time only while tab, focus, idle, tracking, and privacy conditions allow", () => {
    const tabA = { tabId: "session-test:A", url: "https://docs.example/a", canonicalUrl: "https://docs.example/a", domain: "docs.example", title: "A" };
    const tabB = { tabId: "session-test:B", url: "https://code.example/b", canonicalUrl: "https://code.example/b", domain: "code.example", title: "B" };
    const intervals = deriveActiveIntervals([
      event("window_focused", "09:00"),
      event("tab_activated", "09:00", tabA),
      event("user_idle", "09:05", { idleState: "idle" }),
      event("user_active", "09:12", { idleState: "active" }),
      event("tab_activated", "09:15", tabB),
      event("window_blurred", "09:18"),
      event("window_focused", "09:25"),
      event("tab_closed", "09:30", { tabId: tabB.tabId }),
    ]);

    const totalFor = (tabId: string) => intervals.filter((interval) => interval.tabId === tabId).reduce((sum, interval) => sum + interval.durationMs, 0);
    expect(totalFor(tabA.tabId)).toBe(8 * 60_000);
    expect(totalFor(tabB.tabId)).toBe(8 * 60_000);
    expect(intervals.map((interval) => interval.terminationReason)).toEqual([
      "user_idle",
      "tab_activated",
      "window_blurred",
      "tab_closed",
    ]);
  });

  it("groups semantically related research with inspectable evidence and captured ideas", () => {
    const interval = (id: string, start: string, end: string, domain: string, title: string): ActiveInterval => ({
      intervalId: id,
      deviceId: "device-test",
      browserProfileId: "chrome:Default",
      browserSessionId: "session-test",
      tabId: id,
      startedAt: `2026-07-18T${start}:00.000Z`,
      endedAt: `2026-07-18T${end}:00.000Z`,
      durationMs: (Date.parse(`2026-07-18T${end}:00.000Z`) - Date.parse(`2026-07-18T${start}:00.000Z`)),
      url: `https://${domain}/${id}`,
      canonicalUrl: `https://${domain}/${id}`,
      domain,
      title,
      terminationReason: "tab_activated",
      derivationVersion: 1,
    });
    const idea: CapturedIdea = {
      ideaId: "idea-1",
      capturedAt: "2026-07-18T10:08:00.000Z",
      text: "Correlate extension events with outputs",
      sourceUrl: null,
      sourceTitle: null,
      episodeId: null,
      tags: ["extension"],
      createdVia: "extension",
    };

    const episodes = groupResearchEpisodes([
      interval("one", "10:00", "10:05", "developer.chrome.com", "Chrome extension tab events"),
      interval("two", "10:06", "10:10", "chromium.googlesource.com", "Chrome extension history schema"),
      interval("three", "10:11", "10:14", "scores.example", "Football results today"),
    ], [idea]);

    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toMatchObject({ ideaCount: 1, uniqueDomains: 2, topicLabel: "chrome extension" });
    expect(episodes[0]?.evidence.join(" ")).toContain("shared title terms: chrome, extension");
    expect(episodes[1]?.topicLabel).toContain("football");
  });

  it("calculates focus periods without treating same-domain tab changes as a new topic", () => {
    const intervals = deriveActiveIntervals([
      event("window_focused", "12:00"),
      event("tab_activated", "12:00", { tabId: "A", url: "https://docs.example/a", canonicalUrl: "https://docs.example/a", domain: "docs.example" }),
      event("tab_activated", "12:03", { tabId: "B", url: "https://docs.example/b", canonicalUrl: "https://docs.example/b", domain: "docs.example" }),
      event("tab_activated", "12:05", { tabId: "C", url: "https://code.example/c", canonicalUrl: "https://code.example/c", domain: "code.example" }),
      event("window_blurred", "12:07"),
    ]);

    const focus = deriveFocusPeriods(intervals, 60_000);

    expect(focus.map((period) => ({ domain: period.domain, durationMs: period.durationMs, switches: period.switchesDuringPeriod }))).toEqual([
      { domain: "docs.example", durationMs: 5 * 60_000, switches: 1 },
      { domain: "code.example", durationMs: 2 * 60_000, switches: 0 },
    ]);
  });
});
