import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivityEvent, ActivityEventType } from "../packages/domain/src/index.ts";
import { ActivityStore } from "../packages/database/src/index.ts";
import { defaultPrivacySettings } from "../packages/privacy/src/index.ts";

function activity(eventType: ActivityEventType, time: string, values: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    eventId: crypto.randomUUID(),
    schemaVersion: 1,
    eventType,
    occurredAt: `2026-07-18T${time}:00.000Z`,
    deviceId: "device-test",
    browser: "chrome",
    browserVersion: "138",
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

describe("activity ledger", () => {
  it("ingests events idempotently and rebuilds an explainable daily summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-ledger-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    const page = { tabId: "session-test:A", url: "https://Example.com/research?q=private", title: "Chrome extension research" };
    const events = [
      activity("window_focused", "09:00"),
      activity("tab_activated", "09:00", page),
      activity("idea_captured", "09:03", { ...page, metadata: { text: "Use an event ledger", tags: ["events"] } }),
      activity("window_blurred", "09:05"),
    ];

    const first = store.ingestEvents(events, defaultPrivacySettings, "2026-07-18T09:05:01.000Z");
    const second = store.ingestEvents(events, defaultPrivacySettings, "2026-07-18T09:05:02.000Z");
    store.rebuildDerivations();
    const summary = store.getDailySummary("2026-07-18");

    expect(first).toMatchObject({ received: 4, inserted: 4, duplicates: 0 });
    expect(second).toMatchObject({ received: 4, inserted: 0, duplicates: 4 });
    expect(summary.metrics).toMatchObject({ activeDurationMs: 5 * 60_000, ideaCount: 1, tabSwitchCount: 0, domainSwitchCount: 0 });
    expect(summary.topDomains[0]).toMatchObject({ domain: "example.com", activeDurationMs: 5 * 60_000 });
    expect(summary.episodes[0]).toMatchObject({ topicLabel: "chrome extension", ideaCount: 1 });
    expect(summary.boundaries.map(({ eventType }) => eventType)).toEqual(["window_focused", "window_blurred"]);
    expect((store.getRangeSummary("2026-07-18", 1) as { activityByHour: Array<{ hour: number; activeDurationMs: number }> }).activityByHour[9]).toEqual({ hour: 9, activeDurationMs: 5 * 60_000 });
    expect(JSON.stringify(summary)).not.toContain("private");
    store.close();
  });

  it("deletes raw and derived data by domain and rebuilds the remaining evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-delete-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    const events = [
      activity("window_focused", "11:00"),
      activity("tab_activated", "11:00", { tabId: "A", url: "https://remove.example/private", title: "Remove" }),
      activity("tab_activated", "11:05", { tabId: "B", url: "https://keep.example/public", title: "Keep" }),
      activity("window_blurred", "11:10"),
    ];
    store.ingestEvents(events, defaultPrivacySettings);
    store.rebuildDerivations();

    const result = store.deleteData({ domain: "remove.example" });
    const summary = store.getDailySummary("2026-07-18");

    expect(result.activityEventsDeleted).toBe(1);
    expect(summary.topDomains.map(({ domain }) => domain)).toEqual(["keep.example"]);
    expect(summary.metrics.activeDurationMs).toBe(5 * 60_000);
    store.close();
  });

  it("associates imported outputs and manual annotations with an episode", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-output-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    store.ingestEvents([
      activity("window_focused", "10:00"),
      activity("tab_activated", "10:00", { tabId: "A", url: "https://docs.example/research", title: "Browser evidence" }),
      activity("window_blurred", "10:10"),
    ], defaultPrivacySettings);
    expect(store.importOutputs([{
      outputId: "git:chromelens:abc123",
      outputType: "git_commit",
      occurredAt: "2026-07-18T10:14:00.000Z",
      title: "Implement browser evidence",
      reference: "abc123",
      repository: "chromelens",
      sourceConnector: "git",
      metadata: { author: "Local Developer" },
    }])).toEqual({ inserted: 1, duplicates: 0 });
    store.rebuildDerivations(undefined, { afterEpisodeMs: 5 * 60_000 });
    const episodeId = store.getDailySummary("2026-07-18").episodes[0]!.episodeId;
    const annotation = store.addAnnotation({ episodeId, label: "learning", note: "Useful source comparison" });
    const summary = store.getDailySummary("2026-07-18");

    expect(summary.episodes[0]).toMatchObject({ outputCount: 1 });
    expect(summary.outputs[0]).toMatchObject({ episodeId, repository: "chromelens", associationGapMs: 4 * 60_000 });
    expect(summary.annotations).toContainEqual(expect.objectContaining({ annotationId: annotation.annotationId, episodeId, label: "learning" }));
    store.close();
  });
});
