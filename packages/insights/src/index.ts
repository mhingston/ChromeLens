import type { CapturedIdea, EpisodeAnnotation, FocusPeriod, LinkedOutput, ResearchEpisode, ActiveInterval } from "../../domain/src/index.ts";

export type InsightKind = "review" | "comparison" | "continuity" | "coverage" | "association" | "pattern";
export type InsightBasis = "observed" | "derived" | "user_authored" | "association" | "mixed";

export interface InsightEvidenceRef {
  type: "day" | "interval" | "episode" | "idea" | "output" | "annotation";
  id: string;
  date?: string;
}

export interface Insight {
  insightId: string;
  kind: InsightKind;
  title: string;
  statement: string;
  period: { from: string; to: string; timeZone: string };
  basis: InsightBasis;
  evidenceRefs: InsightEvidenceRef[];
  confidence: number | null;
  sampleSize: number;
  caveats: string[];
  severity: "information" | "review";
  action?: { label: string; target: string };
}

export interface InsightMetrics {
  activeDurationMs: number;
  tabSwitchCount: number;
  domainSwitchCount: number;
  uniqueContextBoundaryCount: number;
  outputCount: number;
}

export interface InsightPeriodSummary {
  from: string;
  to: string;
  timeZone: string;
  days: number;
  metrics: InsightMetrics;
  daysWithActivity: number;
}

export interface InsightCoverage {
  observedDays: number;
  daysWithActivity: number;
  intervalCount: number;
  lastObservedEventAt: string | null;
  queuedEvents?: number;
  droppedEvents?: number;
  collectorRecentlyObserved?: boolean;
  privacyDrift?: boolean;
}

export interface InsightInput {
  period: { from: string; to: string; timeZone: string };
  current: InsightPeriodSummary;
  previous?: InsightPeriodSummary;
  episodes: readonly ResearchEpisode[];
  intervals: readonly ActiveInterval[];
  focusPeriods: readonly FocusPeriod[];
  outputs: readonly LinkedOutput[];
  ideas: readonly CapturedIdea[];
  annotations: readonly EpisodeAnnotation[];
  coverage: InsightCoverage;
}

export function buildInsights(input: InsightInput): Insight[] {
  const insights: Insight[] = [];
  const intervalById = new Map(input.intervals.map((interval) => [interval.intervalId, interval]));
  const reviewEpisodes = input.episodes.filter((episode) => episode.topicLabel === "unlabelled research" || episode.topicConfidence < 0.5 || input.annotations.some((annotation) => annotation.episodeId === episode.episodeId && annotation.label === "misclassified"));
  for (const episode of reviewEpisodes) {
    const date = dateOf(episode.startedAt);
    insights.push(makeInsight(input, {
      kind: "review", title: "Episode label may need review",
      statement: `${episode.topicLabel} has ${Math.round(episode.topicConfidence * 100)}% deterministic confidence.`,
      basis: episode.topicLabelSource === "user" ? "mixed" : "derived", evidenceRefs: [{ type: "episode", id: episode.episodeId, date }],
      confidence: episode.topicConfidence, sampleSize: 1, caveats: ["This is a deterministic grouping signal, not a judgement about the episode."], severity: "review",
      action: { label: "Open episode", target: episode.episodeId },
    }, `episode-review:${episode.episodeId}`));
  }
  for (const output of input.outputs.filter((candidate) => candidate.episodeId === null)) {
    const date = dateOf(output.occurredAt);
    insights.push(makeInsight(input, {
      kind: "association", title: "Output is not linked to an episode",
      statement: `${output.title ?? output.reference ?? "Local output"} has no temporal episode association.`, basis: "association",
      evidenceRefs: [{ type: "output", id: output.outputId, date }], confidence: null, sampleSize: 1,
      caveats: ["Temporal association is optional evidence and is not causal."], severity: "review",
      action: { label: "Open output evidence", target: output.outputId },
    }, `output-unlinked:${output.outputId}`));
  }
  for (const idea of input.ideas.filter((candidate) => candidate.episodeId === null)) {
    const date = dateOf(idea.capturedAt);
    insights.push(makeInsight(input, {
      kind: "association", title: "Idea is not associated with an episode",
      statement: "This explicitly captured idea has no derived episode association.", basis: "association",
      evidenceRefs: [{ type: "idea", id: idea.ideaId, date }], confidence: null, sampleSize: 1,
      caveats: ["An absent association does not imply an absent context."], severity: "review",
      action: { label: "Open idea evidence", target: idea.ideaId },
    }, `idea-unassociated:${idea.ideaId}`));
  }

  const longestFocus = [...input.focusPeriods].sort((left, right) => right.durationMs - left.durationMs || left.focusPeriodId.localeCompare(right.focusPeriodId))[0];
  if (longestFocus) {
    insights.push(makeInsight(input, {
      kind: "pattern", title: "Longest observed focus period",
      statement: `${formatDuration(longestFocus.durationMs)} observed in ${longestFocus.domain ?? "mixed context"}.`, basis: "derived",
      evidenceRefs: focusEvidence(longestFocus, intervalById), confidence: null, sampleSize: input.focusPeriods.length,
      caveats: ["Focus periods describe foreground continuity; they do not measure focus quality."], severity: "information",
      action: { label: "Open supporting interval", target: longestFocus.intervalIds[0] ?? "" },
    }, `longest-focus:${longestFocus.focusPeriodId}`));
  }

  const interrupted = input.focusPeriods.filter((period) => period.idleInterruptions >= 2);
  if (interrupted.length) {
    insights.push(makeInsight(input, {
      kind: "pattern", title: "Focus periods with repeated idle interruption",
      statement: `${interrupted.length} of ${input.focusPeriods.length} observed focus periods include at least two idle interruptions.`, basis: "derived",
      evidenceRefs: interrupted.flatMap((period) => focusEvidence(period, intervalById)), confidence: null, sampleSize: input.focusPeriods.length,
      caveats: ["Idle state is an observed browser signal and may have multiple explanations."], severity: "information",
      action: { label: "Open first supporting interval", target: interrupted[0]!.intervalIds[0] ?? "" },
    }, `idle-interruption:${interrupted.map((period) => period.focusPeriodId).join(",")}`));
  }

  const recurringTopic = recurringTopicInsight(input);
  if (recurringTopic) insights.push(recurringTopic);
  const revisitedPage = revisitedPageInsight(input);
  if (revisitedPage) insights.push(revisitedPage);
  const comparison = previousPeriodInsight(input);
  if (comparison) insights.push(comparison);
  if ((input.coverage.droppedEvents ?? 0) > 0) insights.push(makeInsight(input, {
    kind: "coverage", title: "Dropped events may limit this view",
    statement: `${input.coverage.droppedEvents} queued event(s) were dropped after the local queue reached its bound.`, basis: "observed",
    evidenceRefs: [], confidence: null, sampleSize: input.coverage.observedDays, caveats: ["Some browser activity may be absent from the selected evidence range."], severity: "review",
  }, "coverage:dropped-events"));
  if ((input.coverage.queuedEvents ?? 0) > 0) insights.push(makeInsight(input, {
    kind: "coverage", title: "Events remain queued for delivery",
    statement: `${input.coverage.queuedEvents} event(s) are waiting for collector delivery.`, basis: "observed", evidenceRefs: [], confidence: null,
    sampleSize: input.coverage.observedDays, caveats: ["The dashboard may not yet include all locally queued observations."], severity: "review",
  }, "coverage:queued-events"));
  if (input.coverage.collectorRecentlyObserved === false) insights.push(makeInsight(input, {
    kind: "coverage", title: "Collector has not been observed recently",
    statement: "The latest observed event is outside the current health window.", basis: "observed", evidenceRefs: [], confidence: null,
    sampleSize: input.coverage.observedDays, caveats: ["A stale observation may reflect paused tracking or an offline extension."], severity: "review",
  }, "coverage:collector-stale"));
  if (input.coverage.privacyDrift) insights.push(makeInsight(input, {
    kind: "coverage", title: "Privacy configuration may be stale",
    statement: "The extension and collector do not report the same canonical privacy configuration version.", basis: "observed", evidenceRefs: [], confidence: null,
    sampleSize: input.coverage.observedDays, caveats: ["The collector still applies its canonical privacy rules before persistence."], severity: "review",
  }, "coverage:privacy-drift"));

  return insights.sort((left, right) => severityRank(left) - severityRank(right) || left.kind.localeCompare(right.kind) || left.title.localeCompare(right.title) || left.insightId.localeCompare(right.insightId));
}

function recurringTopicInsight(input: InsightInput): Insight | null {
  const byTopic = new Map<string, ResearchEpisode[]>();
  for (const episode of input.episodes) {
    const list = byTopic.get(episode.topicLabel) ?? [];
    list.push(episode);
    byTopic.set(episode.topicLabel, list);
  }
  const candidates = [...byTopic.entries()]
    .map(([topic, episodes]) => ({ topic, episodes, dates: new Set(episodes.map((episode) => dateOf(episode.startedAt))) }))
    .filter((candidate) => candidate.dates.size >= 2)
    .sort((left, right) => right.dates.size - left.dates.size || right.episodes.length - left.episodes.length || left.topic.localeCompare(right.topic));
  const candidate = candidates[0];
  if (!candidate) return null;
  const evidenceRefs = candidate.episodes.map((episode) => ({ type: "episode" as const, id: episode.episodeId, date: dateOf(episode.startedAt) }));
  return makeInsight(input, {
    kind: "pattern", title: "Topic observed across multiple days",
    statement: `${candidate.topic} appears in ${candidate.dates.size} observed calendar days (${candidate.episodes.length} episode(s)).`, basis: "derived",
    evidenceRefs, confidence: null, sampleSize: candidate.episodes.length,
    caveats: ["Repeated deterministic labels indicate recurrence in the evidence; they do not establish intent or importance."], severity: "information",
    action: { label: "Open first episode", target: candidate.episodes[0]!.episodeId },
  }, `recurring-topic:${candidate.topic}:${candidate.episodes.map((episode) => episode.episodeId).sort().join(",")}`);
}

function revisitedPageInsight(input: InsightInput): Insight | null {
  const byUrl = new Map<string, ActiveInterval[]>();
  for (const interval of input.intervals) {
    const url = interval.canonicalUrl ?? interval.url;
    if (!url) continue;
    const list = byUrl.get(url) ?? [];
    list.push(interval);
    byUrl.set(url, list);
  }
  const candidates = [...byUrl.entries()]
    .map(([url, intervals]) => ({ url, intervals, dates: new Set(intervals.map((interval) => dateOf(interval.startedAt))) }))
    .filter((candidate) => candidate.dates.size >= 2)
    .sort((left, right) => right.dates.size - left.dates.size || right.intervals.length - left.intervals.length || left.url.localeCompare(right.url));
  const candidate = candidates[0];
  if (!candidate) return null;
  const first = candidate.intervals.slice().sort((left, right) => left.startedAt.localeCompare(right.startedAt))[0]!;
  return makeInsight(input, {
    kind: "continuity", title: "Page revisited across observed days",
    statement: `${first.title ?? first.domain ?? "A retained page"} appears in ${candidate.dates.size} observed calendar days (${candidate.intervals.length} interval(s)).`, basis: "observed",
    evidenceRefs: candidate.intervals.map((interval) => ({ type: "interval" as const, id: interval.intervalId, date: dateOf(interval.startedAt) })), confidence: null,
    sampleSize: candidate.intervals.length, caveats: ["A revisit is an observed URL recurrence, not evidence of unfinished work."], severity: "information",
    action: { label: "Open first interval", target: first.intervalId },
  }, `revisited-page:${candidate.url}:${candidate.intervals.map((interval) => interval.intervalId).sort().join(",")}`);
}

function previousPeriodInsight(input: InsightInput): Insight | null {
  const previous = input.previous;
  if (!previous || input.current.days < 2 || previous.days !== input.current.days || (input.current.daysWithActivity < 2 && previous.daysWithActivity < 2)) return null;
  const difference = input.current.metrics.activeDurationMs - previous.metrics.activeDurationMs;
  const boundaryDifference = input.current.metrics.uniqueContextBoundaryCount - previous.metrics.uniqueContextBoundaryCount;
  if (difference === 0 && boundaryDifference === 0) return null;
  const activity = `${formatDuration(Math.abs(difference))} ${difference >= 0 ? "more" : "less"} observed foreground time`;
  const boundaries = `${Math.abs(boundaryDifference)} ${boundaryDifference === 1 || boundaryDifference === -1 ? "boundary" : "boundaries"} ${boundaryDifference >= 0 ? "more" : "fewer"}`;
  return makeInsight(input, {
    kind: "comparison", title: "Observed range differs from the preceding equal-length period",
    statement: `${activity} and ${boundaries} than ${previous.from}–${previous.to}.`, basis: "observed",
    evidenceRefs: [{ type: "day", id: input.period.from, date: input.period.from }], confidence: null,
    sampleSize: input.current.days + previous.days,
    caveats: [`Current: ${input.current.from}–${input.current.to} (${input.current.daysWithActivity} observed day(s)); previous: ${previous.from}–${previous.to} (${previous.daysWithActivity} observed day(s)).`, "Differences describe recorded evidence and do not evaluate performance."], severity: "information",
  }, `comparison:${input.period.from}:${input.period.to}:${previous.from}:${previous.to}:${difference}:${boundaryDifference}`);
}

function makeInsight(input: InsightInput, value: Omit<Insight, "insightId" | "period">, key: string): Insight {
  const evidenceRefs = [...value.evidenceRefs].sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id) || (left.date ?? "").localeCompare(right.date ?? ""));
  const action = value.action?.target ? value.action : undefined;
  return { ...value, insightId: `insight_${stableHash(`${input.period.from}:${input.period.to}:${input.period.timeZone}:${key}`)}`, period: input.period, evidenceRefs, ...(action ? { action } : {}) };
}

function focusEvidence(period: FocusPeriod, intervalById: Map<string, ActiveInterval>): InsightEvidenceRef[] {
  return period.intervalIds.map((id) => ({ type: "interval" as const, id, date: dateOf(intervalById.get(id)?.startedAt ?? period.startedAt) }));
}

function dateOf(value: string): string { return value.slice(0, 10); }
function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours} hour${hours === 1 ? "" : "s"}`;
}
function severityRank(insight: Insight): number { return insight.severity === "review" ? 0 : 1; }
function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
