import { describe, expect, it } from "vitest";
import { searchDocuments, type SearchDocument } from "../packages/search/src/index.ts";

describe("local evidence search", () => {
  it("matches every query token and ranks title matches deterministically", () => {
    const documents: SearchDocument[] = [
      { type: "idea", id: "idea-1", title: "Captured idea", body: "event ledger for research", date: "2026-07-18", basis: "user_authored", target: "idea-1" },
      { type: "episode", id: "episode-1", title: "Event sourcing", body: "Grouped by temporal proximity", date: "2026-07-18", basis: "derived", target: "episode-1" },
      { type: "output", id: "output-1", title: "Unrelated output", body: "commit", date: "2026-07-18", basis: "association", target: "output-1" },
    ];
    const first = searchDocuments(documents, "event research");
    const second = searchDocuments(documents, "event research");

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: "idea", id: "idea-1", basis: "user_authored" });
    expect(first[0]!.snippet).toContain("event ledger");
    expect(searchDocuments(documents, "missing")).toEqual([]);
  });
});
