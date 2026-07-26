import { describe, expect, it } from "vitest";
import { buildInsights, type InsightInput } from "../packages/insights/src/index.ts";

describe("deterministic insights", () => {
  it("orders stable insights and preserves evidence references", () => {
    const input: InsightInput = {
      period: { from: "2026-07-18", to: "2026-07-19", timeZone: "UTC" },
      current: { from: "2026-07-18", to: "2026-07-19", timeZone: "UTC", days: 2, daysWithActivity: 2, metrics: { activeDurationMs: 900_000, tabSwitchCount: 2, domainSwitchCount: 1, uniqueContextBoundaryCount: 2, outputCount: 0 } },
      previous: { from: "2026-07-16", to: "2026-07-17", timeZone: "UTC", days: 2, daysWithActivity: 2, metrics: { activeDurationMs: 600_000, tabSwitchCount: 1, domainSwitchCount: 1, uniqueContextBoundaryCount: 1, outputCount: 0 } },
      episodes: [
        { episodeId: "ep-one", startedAt: "2026-07-18T09:00:00.000Z", endedAt: "2026-07-18T09:20:00.000Z", topicLabel: "event sourcing", topicConfidence: 0.2, topicLabelSource: "deterministic", activeDurationMs: 1_200_000, idleDurationMs: 0, uniqueDomains: 1, uniqueUrls: 1, tabSwitchCount: 0, domainSwitchCount: 0, ideaCount: 0, outputCount: 0, derivationVersion: 1, evidence: [], intervalIds: ["interval-one"] },
        { episodeId: "ep-two", startedAt: "2026-07-19T10:00:00.000Z", endedAt: "2026-07-19T10:10:00.000Z", topicLabel: "event sourcing", topicConfidence: 1, topicLabelSource: "deterministic", activeDurationMs: 600_000, idleDurationMs: 0, uniqueDomains: 1, uniqueUrls: 1, tabSwitchCount: 0, domainSwitchCount: 0, ideaCount: 0, outputCount: 0, derivationVersion: 1, evidence: [], intervalIds: ["interval-two"] },
      ],
      intervals: [
        { intervalId: "interval-one", deviceId: "device", browserProfileId: "chrome:Default", browserSessionId: "session", tabId: "tab", startedAt: "2026-07-18T09:00:00.000Z", endedAt: "2026-07-18T09:20:00.000Z", durationMs: 1_200_000, url: "https://example.com/research", canonicalUrl: "https://example.com/research", domain: "example.com", title: "Research", terminationReason: "window_blurred", derivationVersion: 1 },
        { intervalId: "interval-two", deviceId: "device", browserProfileId: "chrome:Default", browserSessionId: "session", tabId: "tab", startedAt: "2026-07-19T10:00:00.000Z", endedAt: "2026-07-19T10:10:00.000Z", durationMs: 600_000, url: "https://example.com/research", canonicalUrl: "https://example.com/research", domain: "example.com", title: "Research", terminationReason: "window_blurred", derivationVersion: 1 },
      ],
      focusPeriods: [{ focusPeriodId: "focus-one", startedAt: "2026-07-18T09:00:00.000Z", endedAt: "2026-07-18T09:20:00.000Z", durationMs: 1_200_000, domain: "example.com", sameUrlDurationMs: 1_200_000, switchesDuringPeriod: 0, idleInterruptions: 0, intervalIds: ["interval-one"], derivationVersion: 1 }],
      outputs: [{ outputId: "output-one", outputType: "git_commit", occurredAt: "2026-07-19T11:00:00.000Z", title: "Output", reference: null, repository: "repo", sourceConnector: "git", metadata: {}, episodeId: null, associationGapMs: null, associationReason: null }],
      ideas: [{ ideaId: "idea-one", capturedAt: "2026-07-19T11:05:00.000Z", text: "Idea", sourceUrl: null, sourceTitle: null, episodeId: null, tags: [], createdVia: "test" }],
      annotations: [],
      coverage: { observedDays: 2, daysWithActivity: 2, intervalCount: 2, lastObservedEventAt: "2026-07-19T11:05:00.000Z" },
    };
    const first = buildInsights(input);
    const second = buildInsights(input);

    expect(first).toEqual(second);
    expect(first.map((insight) => insight.kind)).toContain("comparison");
    expect(first.map((insight) => insight.kind)).toContain("continuity");
    expect(first.filter((insight) => insight.severity === "review")).toHaveLength(3);
    expect(first.every((insight) => /^insight_[0-9a-f]+$/.test(insight.insightId))).toBe(true);
    expect(first.find((insight) => insight.kind === "continuity")?.evidenceRefs).toEqual([
      { type: "interval", id: "interval-one", date: "2026-07-18" },
      { type: "interval", id: "interval-two", date: "2026-07-19" },
    ]);
  });

  it("suppresses equal-period comparison claims for a one-day sample", () => {
    const input: InsightInput = {
      period: { from: "2026-07-18", to: "2026-07-18", timeZone: "UTC" },
      current: { from: "2026-07-18", to: "2026-07-18", timeZone: "UTC", days: 1, daysWithActivity: 1, metrics: { activeDurationMs: 60_000, tabSwitchCount: 0, domainSwitchCount: 0, uniqueContextBoundaryCount: 0, outputCount: 0 } },
      previous: { from: "2026-07-17", to: "2026-07-17", timeZone: "UTC", days: 1, daysWithActivity: 1, metrics: { activeDurationMs: 0, tabSwitchCount: 0, domainSwitchCount: 0, uniqueContextBoundaryCount: 0, outputCount: 0 } },
      episodes: [], intervals: [], focusPeriods: [], outputs: [], ideas: [], annotations: [],
      coverage: { observedDays: 1, daysWithActivity: 1, intervalCount: 0, lastObservedEventAt: null },
    };
    expect(buildInsights(input).some((insight) => insight.kind === "comparison")).toBe(false);
  });
});
