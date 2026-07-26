import type { CapturedIdea, EpisodeAnnotation, LinkedOutput, ResearchEpisode } from "../../domain/src/index.ts";

export type ReviewItemKind = "episode_label" | "misclassified_episode" | "unlinked_output" | "unassociated_idea" | "idea_without_output" | "coverage";

export interface ReviewEvidenceRef {
  type: "episode" | "output" | "idea";
  id: string;
  date: string;
}

export interface ReviewItem {
  reviewItemId: string;
  kind: ReviewItemKind;
  title: string;
  statement: string;
  evidenceRefs: ReviewEvidenceRef[];
  date: string;
  target: string;
  priority: "review" | "information";
}

export interface ReviewInput {
  episodes: readonly ResearchEpisode[];
  annotations: readonly EpisodeAnnotation[];
  outputs: readonly LinkedOutput[];
  ideas: readonly CapturedIdea[];
  droppedEvents?: number;
  queuedEvents?: number;
  collectorRecentlyObserved?: boolean;
  privacyDrift?: boolean;
}

export function buildReviewItems(input: ReviewInput): ReviewItem[] {
  const items: ReviewItem[] = [];
  for (const episode of input.episodes) {
    const date = episode.startedAt.slice(0, 10);
    if (episode.topicLabel === "unlabelled research" || episode.topicConfidence < 0.5) {
      items.push(item("episode_label", `${episode.episodeId}:label`, "Episode label may need review", `${episode.topicLabel} has ${Math.round(episode.topicConfidence * 100)}% deterministic confidence.`, [{ type: "episode", id: episode.episodeId, date }], date, episode.episodeId));
    }
    if (input.annotations.some((annotation) => annotation.episodeId === episode.episodeId && annotation.label === "misclassified")) {
      items.push(item("misclassified_episode", `${episode.episodeId}:misclassified`, "Episode marked misclassified", "This episode has a user-authored misclassified annotation.", [{ type: "episode", id: episode.episodeId, date }], date, episode.episodeId));
    }
    if (episode.ideaCount > 0 && episode.outputCount === 0) {
      items.push(item("idea_without_output", `${episode.episodeId}:idea-without-output`, "Episode has ideas but no linked output", "Review the episode if an output association should be recorded.", [{ type: "episode", id: episode.episodeId, date }], date, episode.episodeId, "information"));
    }
  }
  for (const output of input.outputs.filter((candidate) => candidate.episodeId === null)) {
    const date = output.occurredAt.slice(0, 10);
    items.push(item("unlinked_output", `${output.outputId}:unlinked`, "Output is not linked to an episode", `${output.title ?? output.reference ?? "Local output"} has no temporal episode association.`, [{ type: "output", id: output.outputId, date }], date, output.outputId));
  }
  for (const idea of input.ideas.filter((candidate) => candidate.episodeId === null)) {
    const date = idea.capturedAt.slice(0, 10);
    items.push(item("unassociated_idea", `${idea.ideaId}:unassociated`, "Idea is not associated with an episode", "This explicitly captured idea has no derived episode association.", [{ type: "idea", id: idea.ideaId, date }], date, idea.ideaId));
  }
  if ((input.droppedEvents ?? 0) > 0) items.push(item("coverage", "coverage:dropped-events", "Observed events may need review", `${input.droppedEvents} queued event(s) were dropped after the local queue reached its bound.`, [], "", "review"));
  if ((input.queuedEvents ?? 0) > 0) items.push(item("coverage", "coverage:queued-events", "Events remain queued for delivery", `${input.queuedEvents} event(s) are waiting for collector delivery.`, [], "", "review"));
  if (input.collectorRecentlyObserved === false) items.push(item("coverage", "coverage:collector-stale", "Collector has not been observed recently", "The latest observed event is outside the current health window.", [], "", "review"));
  if (input.privacyDrift) items.push(item("coverage", "coverage:privacy-drift", "Privacy configuration may be stale", "The extension and collector do not report the same canonical privacy configuration version.", [], "", "review"));
  return items.sort((left, right) => priority(left) - priority(right) || left.date.localeCompare(right.date) || left.title.localeCompare(right.title) || left.reviewItemId.localeCompare(right.reviewItemId));
}

function item(kind: ReviewItemKind, key: string, title: string, statement: string, evidenceRefs: ReviewEvidenceRef[], date: string, target: string, priority: "review" | "information" = "review"): ReviewItem {
  return { reviewItemId: `review_${stableHash(key)}`, kind, title, statement, evidenceRefs, date, target, priority };
}

function priority(item: ReviewItem): number { return item.priority === "review" ? 0 : 1; }

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
