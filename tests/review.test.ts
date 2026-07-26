import { describe, expect, it } from "vitest";
import { buildReviewItems, type ReviewInput } from "../packages/review/src/index.ts";

describe("review item derivation", () => {
  it("is deterministic and preserves evidence references", () => {
    const input: ReviewInput = {
      episodes: [{ episodeId: "ep-one", startedAt: "2026-07-18T09:00:00.000Z", endedAt: "2026-07-18T09:10:00.000Z", topicLabel: "unlabelled research", topicConfidence: 0.2, topicLabelSource: "deterministic", activeDurationMs: 600_000, idleDurationMs: 0, uniqueDomains: 1, uniqueUrls: 1, tabSwitchCount: 0, domainSwitchCount: 0, ideaCount: 1, outputCount: 0, derivationVersion: 1, evidence: [], intervalIds: ["int-one"] }],
      annotations: [],
      outputs: [{ outputId: "out-one", outputType: "git_commit", occurredAt: "2026-07-18T09:20:00.000Z", title: "Output", reference: null, repository: "repo", sourceConnector: "git", metadata: {}, episodeId: null, associationGapMs: null, associationReason: null }],
      ideas: [{ ideaId: "idea-one", capturedAt: "2026-07-18T09:05:00.000Z", text: "Idea", sourceUrl: null, sourceTitle: null, episodeId: null, tags: [], createdVia: "test" }],
    };
    const first = buildReviewItems(input);
    const second = buildReviewItems(input);
    expect(first).toEqual(second);
    expect(first.map((item) => item.kind)).toEqual(["episode_label", "unassociated_idea", "unlinked_output", "idea_without_output"]);
    expect(first[0]!.evidenceRefs).toEqual([{ type: "episode", id: "ep-one", date: "2026-07-18" }]);
    expect(first[0]!.reviewItemId).toMatch(/^review_[0-9a-f]+$/);
  });
});
