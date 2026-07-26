import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ActivityStore } from "../packages/database/src/index.ts";

describe("historical summary", () => {
  it("projects historical visit hours into the requested IANA timezone", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-history-summary-"));
    const store = new ActivityStore(join(root, "activity.sqlite"));
    store.importHistoryBatch({
      urls: [{ sourceBrowser: "chrome", sourceProfileId: "Default", sourceUrlId: 1, url: "https://example.com", canonicalUrl: "https://example.com/", domain: "example.com", title: "Example", visitCount: 2, typedCount: 1, lastVisitAt: "2026-07-18T23:30:00.000Z", importedAt: "2026-07-19T00:00:00.000Z" }],
      visits: [
        { sourceBrowser: "chrome", sourceProfileId: "Default", sourceVisitId: 1, sourceUrlId: 1, visitedAt: "2026-07-18T23:30:00.000Z", browserElapsedDurationMs: null, transitionType: "typed", transitionRaw: null, referringVisitId: null, openerVisitId: null, visitSource: "local", importedAt: "2026-07-19T00:00:00.000Z" },
        { sourceBrowser: "chrome", sourceProfileId: "Default", sourceVisitId: 2, sourceUrlId: 1, visitedAt: "2026-07-18T00:30:00.000Z", browserElapsedDurationMs: null, transitionType: "link", transitionRaw: null, referringVisitId: null, openerVisitId: null, visitSource: "local", importedAt: "2026-07-19T00:00:00.000Z" },
      ],
      searchTerms: [{ sourceBrowser: "chrome", sourceProfileId: "Default", sourceUrlId: 1, term: "example search", importedAt: "2026-07-19T00:00:00.000Z" }],
      run: { importId: "run-1", sourceBrowser: "chrome", sourceProfileId: "Default", sourcePath: "/tmp/History", sourceSchemaVersion: 1, importerVersion: "test", fieldsImportedJson: "{}", startedAt: "2026-07-19T00:00:00.000Z", completedAt: "2026-07-19T00:00:00.000Z" },
    });

    const summary = store.getHistoricalSummary("Europe/London") as { visitsByHour: Array<{ hour: number; visits: number }>; revisitedPages: Array<Record<string, unknown>>; searchTerms: Array<Record<string, unknown>>; profiles: Array<Record<string, unknown>> };
    expect(summary.visitsByHour.find((entry) => entry.hour === 0)?.visits).toBe(1);
    expect(summary.visitsByHour.find((entry) => entry.hour === 1)?.visits).toBe(1);
    expect(summary.revisitedPages[0]).toMatchObject({ typedCount: 1, browser: "chrome", profileId: "Default" });
    expect(summary.searchTerms[0]).toMatchObject({ term: "example search" });
    expect(summary.profiles[0]).toMatchObject({ browser: "chrome", profileId: "Default", visits: 2 });
    expect(() => store.getHistoricalSummary("Not/AZone")).toThrow("Invalid IANA time zone");
    store.close();
  });
});
