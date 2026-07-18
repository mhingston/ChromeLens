import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  it("migrates an existing annotation table without discarding local records", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-migration-"));
    const path = join(root, "activity.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE annotations(annotation_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, episode_id TEXT, label TEXT, note TEXT)");
    legacy.prepare("INSERT INTO annotations VALUES (?, ?, ?, ?, ?)").run("legacy", "2026-07-18T09:00:00.000Z", "old-episode", "learning", "Keep me");
    legacy.close();

    const store = new ActivityStore(path);

    expect(store.readAnnotations()).toContainEqual(expect.objectContaining({ annotationId: "legacy", note: "Keep me", anchorIntervalIds: [] }));
    const migrations = store.database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>;
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3]);
    store.close();
  });

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

  it("clips activity to local calendar days without double counting at midnight", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-calendar-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    const base = { tabId: "A", url: "https://example.com/research", title: "Research" };
    store.ingestEvents([
      activity("window_focused", "22:58"),
      activity("tab_activated", "22:58", base),
      activity("window_blurred", "23:02"),
    ], defaultPrivacySettings);
    store.rebuildDerivations();

    const first = store.getDailySummary("2026-07-18", "Europe/London");
    const second = store.getDailySummary("2026-07-19", "Europe/London");

    expect(first.metrics.activeDurationMs).toBe(2 * 60_000);
    expect(second.metrics.activeDurationMs).toBe(2 * 60_000);
    expect(first.timeZone).toBe("Europe/London");
    expect(first.window.end).toBe(second.window.start);
    store.close();
  });

  it("reassociates human annotations when an episode derivation changes identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-annotation-anchor-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    const firstPage = { tabId: "A", url: "https://docs.example/research", title: "Browser research" };
    store.ingestEvents([
      activity("window_focused", "13:00"),
      activity("tab_activated", "13:00", firstPage),
      activity("window_blurred", "13:05"),
    ], defaultPrivacySettings);
    store.rebuildDerivations();
    const originalEpisodeId = store.getDailySummary("2026-07-18").episodes[0]!.episodeId;
    store.addAnnotation({ episodeId: originalEpisodeId, label: "learning", note: "Keep this human observation" });

    store.ingestEvents([
      activity("window_focused", "13:06"),
      activity("tab_activated", "13:06", { tabId: "B", url: "https://code.example/research", title: "Browser research implementation" }),
      activity("window_blurred", "13:10"),
    ], defaultPrivacySettings);
    store.rebuildDerivations();

    const summary = store.getDailySummary("2026-07-18");
    expect(summary.episodes[0]!.episodeId).not.toBe(originalEpisodeId);
    expect(summary.annotations).toContainEqual(expect.objectContaining({
      episodeId: summary.episodes[0]!.episodeId,
      label: "learning",
      note: "Keep this human observation",
      anchorIntervalIds: expect.arrayContaining([expect.any(String)]),
    }));
    store.close();
  });

  it("stores and reapplies undoable user episode corrections", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-corrections-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    store.ingestEvents([
      activity("window_focused", "15:00"),
      activity("tab_activated", "15:00", { tabId: "A", url: "https://example.com/research", title: "Browser research" }),
      activity("window_blurred", "15:05"),
    ], defaultPrivacySettings);
    store.rebuildDerivations();
    const episodeId = store.getDailySummary("2026-07-18").episodes[0]!.episodeId;

    const correction = store.addEpisodeCorrection({ episodeId, correctionType: "rename", label: "My corrected topic" });
    expect(store.getDailySummary("2026-07-18").episodes[0]).toMatchObject({ topicLabel: "My corrected topic", topicLabelSource: "user" });
    expect(store.removeEpisodeCorrection(correction.correctionId)).toBe(true);
    expect(store.getDailySummary("2026-07-18").episodes[0]).toMatchObject({ topicLabel: "browser research", topicLabelSource: "deterministic" });
    store.close();
  });

  it("does not reassign a deleted annotation to unrelated overlapping evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-private-annotation-delete-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    store.ingestEvents([
      activity("window_focused", "10:00", { deviceId: "delete-device", browserSessionId: "delete-session" }),
      activity("tab_activated", "10:00", { deviceId: "delete-device", browserSessionId: "delete-session", tabId: "delete-tab", url: "https://delete.example/medical", title: "Sensitive medical context" }),
      activity("window_blurred", "10:05", { deviceId: "delete-device", browserSessionId: "delete-session" }),
      activity("window_focused", "10:00", { deviceId: "keep-device", browserSessionId: "keep-session" }),
      activity("tab_activated", "10:00", { deviceId: "keep-device", browserSessionId: "keep-session", tabId: "keep-tab", url: "https://keep.example/code", title: "Programming reference" }),
      activity("window_blurred", "10:05", { deviceId: "keep-device", browserSessionId: "keep-session" }),
    ], defaultPrivacySettings);
    store.rebuildDerivations();
    const sensitiveEpisode = store.getDailySummary("2026-07-18").episodes.find((episode) => episode.intervalIds.some((id) =>
      store.getDailySummary("2026-07-18").intervals.find((interval) => interval.intervalId === id)?.domain === "delete.example",
    ))!;
    store.addAnnotation({ episodeId: sensitiveEpisode.episodeId, label: "private_or_excluded", note: "Sensitive human note" });

    store.deleteData({ domain: "delete.example" });

    expect(store.getDailySummary("2026-07-18").topDomains.map((domain) => domain.domain)).toEqual(["keep.example"]);
    expect(store.readAnnotations()).toHaveLength(0);
    store.close();
  });
});
