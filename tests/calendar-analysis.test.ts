import { describe, expect, it } from "vitest";
import type { ActiveInterval, ResearchEpisode } from "../packages/domain/src/index.ts";
import {
  calendarRange,
  calendarDayWindow,
  projectActivityWindow,
} from "../packages/calendar-analysis/src/index.ts";

function interval(startedAt: string, endedAt: string): ActiveInterval {
  return {
    intervalId: "interval-one",
    deviceId: "device",
    browserProfileId: "chrome:Default",
    browserSessionId: "session",
    tabId: "tab",
    startedAt,
    endedAt,
    durationMs: Date.parse(endedAt) - Date.parse(startedAt),
    url: "https://example.com/research",
    canonicalUrl: "https://example.com/research",
    domain: "example.com",
    title: "Research notes",
    terminationReason: "window_blurred",
    derivationVersion: 1,
  };
}

function episode(source: ActiveInterval): ResearchEpisode {
  return {
    episodeId: "episode-one",
    startedAt: source.startedAt,
    endedAt: source.endedAt,
    topicLabel: "research notes",
    topicConfidence: 1,
    topicLabelSource: "deterministic",
    activeDurationMs: source.durationMs,
    idleDurationMs: 0,
    uniqueDomains: 1,
    uniqueUrls: 1,
    tabSwitchCount: 0,
    domainSwitchCount: 0,
    ideaCount: 0,
    outputCount: 0,
    derivationVersion: 1,
    evidence: ["Observed evidence"],
    intervalIds: [source.intervalId],
  };
}

describe("calendar analysis", () => {
  it("builds DST-safe local calendar windows", () => {
    expect(calendarDayWindow("2026-07-18", "Europe/London")).toEqual({
      date: "2026-07-18",
      timeZone: "Europe/London",
      start: "2026-07-17T23:00:00.000Z",
      end: "2026-07-18T23:00:00.000Z",
    });
    const fallback = calendarDayWindow("2026-10-25", "Europe/London");
    expect(Date.parse(fallback.end) - Date.parse(fallback.start)).toBe(25 * 60 * 60_000);
    expect(calendarDayWindow("2024-09-08", "America/Santiago")).toEqual({
      date: "2024-09-08",
      timeZone: "America/Santiago",
      start: "2024-09-08T04:00:00.000Z",
      end: "2024-09-09T03:00:00.000Z",
    });
  });

  it("clips intervals and episode metrics to the requested window", () => {
    const source = interval("2026-07-18T22:58:00.000Z", "2026-07-18T23:02:00.000Z");
    const projected = projectActivityWindow(
      [source],
      [episode(source)],
      calendarDayWindow("2026-07-18", "Europe/London"),
    );

    expect(projected.intervals).toHaveLength(1);
    expect(projected.intervals[0]).toMatchObject({
      startedAt: "2026-07-18T22:58:00.000Z",
      endedAt: "2026-07-18T23:00:00.000Z",
      durationMs: 2 * 60_000,
    });
    expect(projected.episodes[0]).toMatchObject({
      endedAt: "2026-07-18T23:00:00.000Z",
      activeDurationMs: 2 * 60_000,
    });
  });

  it("generates explicit calendar and rolling ranges", () => {
    expect(calendarRange("2026-07-15", "Europe/London", "calendar_week")).toMatchObject({
      from: "2026-07-13", to: "2026-07-19", dates: expect.arrayContaining(["2026-07-13", "2026-07-19"]),
    });
    expect(calendarRange("2026-07-15", "Europe/London", "calendar_month")).toMatchObject({ from: "2026-07-01", to: "2026-07-31" });
    expect(calendarRange("2026-07-15", "Europe/London", "rolling_7")).toMatchObject({ from: "2026-07-09", to: "2026-07-15" });
  });
});
