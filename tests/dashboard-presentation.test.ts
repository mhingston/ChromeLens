import { describe, expect, it } from "vitest";
import { countLabel, formatDuration, summarizeEpisodePages, summarizeFocusPeriods } from "../apps/dashboard/src/presentation.ts";

describe("dashboard presentation", () => {
  it("formats short durations and pluralized counts without misleading labels", () => {
    expect(formatDuration(20_000)).toBe("<1m");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(7_171_000)).toBe("2h 0m");
    expect(countLabel(1, "domain")).toBe("1 domain");
    expect(countLabel(2, "domain")).toBe("2 domains");
  });

  it("collapses repeated intervals for the same page", () => {
    const pages = summarizeEpisodePages(["one", "two", "private"], [
      {
        intervalId: "one", startedAt: "2026-07-18T10:00:00.000Z", endedAt: "2026-07-18T10:01:00.000Z",
        durationMs: 60_000, canonicalUrl: "https://example.com/research", title: "Research", domain: "example.com",
      },
      {
        intervalId: "two", startedAt: "2026-07-18T10:02:00.000Z", endedAt: "2026-07-18T10:04:00.000Z",
        durationMs: 120_000, canonicalUrl: "https://example.com/research", title: "Research", domain: "example.com",
      },
      {
        intervalId: "private", startedAt: "2026-07-18T10:05:00.000Z", endedAt: "2026-07-18T10:05:20.000Z",
        durationMs: 20_000, title: null, domain: null,
      },
    ]);

    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ title: "Research", visits: 2, durationMs: 180_000 });
    expect(pages[1]).toMatchObject({ title: "Private context", visits: 1, durationMs: 20_000 });
  });

  it("summarizes repeated focus periods as one context with a period count", () => {
    const contexts = summarizeFocusPeriods([
      { domain: "github.com", durationMs: 40_000 },
      { domain: null, durationMs: 20 },
      { domain: "github.com", durationMs: 20_000 },
      { domain: "www.reddit.com", durationMs: 30_000 },
    ]);

    expect(contexts).toEqual([
      { domain: "github.com", durationMs: 60_000, periodCount: 2 },
      { domain: "www.reddit.com", durationMs: 30_000, periodCount: 1 },
      { domain: null, durationMs: 20, periodCount: 1 },
    ]);
  });
});
