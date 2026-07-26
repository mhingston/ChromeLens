import { createHash } from "node:crypto";
import type { ActiveInterval, ActivityEvent, CapturedIdea, EpisodeCorrection, FocusPeriod, ResearchEpisode } from "../../domain/src/index.ts";

interface PageState {
  tabId: string | null;
  url: string | null;
  canonicalUrl: string | null;
  domain: string | null;
  title: string | null;
  excluded: boolean;
}

interface BrowserState {
  focused: boolean;
  idleState: "active" | "idle" | "locked";
  tracking: boolean;
  page: PageState;
  open: Omit<ActiveInterval, "intervalId" | "endedAt" | "durationMs" | "terminationReason"> | null;
}

export interface DerivationOptions {
  endAt?: string;
}

export function deriveActiveIntervals(events: ActivityEvent[], options: DerivationOptions = {}): ActiveInterval[] {
  const ordered = [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  const states = new Map<string, BrowserState>();
  const intervals: ActiveInterval[] = [];

  for (const event of ordered) {
    const key = `${event.deviceId}\0${event.browserSessionId}`;
    const state = states.get(key) ?? initialState();
    const beforeKey = pageKey(state.page);
    applyEvent(state, event);
    const eligible = isEligible(state);
    const contextChanged = beforeKey !== pageKey(state.page);

    if (state.open && (!eligible || contextChanged)) {
      closeInterval(state, event.occurredAt, event.eventType, intervals);
    }
    if (!state.open && eligible) {
      state.open = openInterval(event, state.page);
    } else if (state.open && event.eventType === "title_changed" && event.title) {
      state.open.title = event.title;
    }
    states.set(key, state);
  }

  if (options.endAt) {
    for (const state of states.values()) {
      if (state.open) closeInterval(state, options.endAt, "observation_ended", intervals);
    }
  }
  return intervals;
}

function initialState(): BrowserState {
  return {
    focused: false,
    idleState: "active",
    tracking: true,
    page: { tabId: null, url: null, canonicalUrl: null, domain: null, title: null, excluded: false },
    open: null,
  };
}

function applyEvent(state: BrowserState, event: ActivityEvent): void {
  switch (event.eventType) {
    case "browser_session_started":
      state.tracking = true;
      break;
    case "browser_session_ended":
      state.tracking = false;
      state.focused = false;
      break;
    case "window_focused":
      state.focused = true;
      if (event.tabId || event.url) state.page = pageFromEvent(event);
      break;
    case "window_blurred":
      state.focused = false;
      break;
    case "user_active":
      state.idleState = "active";
      break;
    case "user_idle":
      state.idleState = "idle";
      break;
    case "user_locked":
      state.idleState = "locked";
      break;
    case "tracking_paused":
      state.tracking = false;
      break;
    case "tracking_resumed":
      state.tracking = true;
      if (event.tabId || event.url) state.page = pageFromEvent(event);
      break;
    case "tab_activated":
      state.page = pageFromEvent(event);
      break;
    case "url_changed":
      if (!event.tabId || event.tabId === state.page.tabId) state.page = pageFromEvent(event);
      break;
    case "title_changed":
      if ((!event.tabId || event.tabId === state.page.tabId) && event.title) state.page.title = event.title;
      break;
    case "tab_deactivated":
    case "tab_closed":
      if (!event.tabId || event.tabId === state.page.tabId) {
        state.page = { tabId: null, url: null, canonicalUrl: null, domain: null, title: null, excluded: false };
      }
      break;
    case "tab_opened":
    case "idea_captured":
    case "annotation_created":
      break;
  }
}

function pageFromEvent(event: ActivityEvent): PageState {
  return {
    tabId: event.tabId,
    url: event.url,
    canonicalUrl: event.canonicalUrl,
    domain: event.domain,
    title: event.title,
    excluded: event.metadata.excluded === true,
  };
}

function isEligible(state: BrowserState): boolean {
  return state.focused
    && state.idleState === "active"
    && state.tracking
    && !state.page.excluded
    && state.page.tabId !== null
    && typeof state.page.url === "string"
    && state.page.url.trim().length > 0;
}

function pageKey(page: PageState): string {
  return `${page.tabId ?? ""}\0${page.canonicalUrl ?? page.url ?? ""}\0${page.excluded ? "excluded" : "included"}`;
}

function openInterval(
  event: ActivityEvent,
  page: PageState,
): Omit<ActiveInterval, "intervalId" | "endedAt" | "durationMs" | "terminationReason"> {
  return {
    deviceId: event.deviceId,
    browserProfileId: event.browserProfileId,
    browserSessionId: event.browserSessionId,
    tabId: page.tabId,
    startedAt: event.occurredAt,
    url: page.url,
    canonicalUrl: page.canonicalUrl,
    domain: page.domain,
    title: page.title,
    derivationVersion: 1,
  };
}

function closeInterval(state: BrowserState, endedAt: string, reason: string, output: ActiveInterval[]): void {
  if (!state.open) return;
  const durationMs = Date.parse(endedAt) - Date.parse(state.open.startedAt);
  if (durationMs > 0) {
    const identity = [state.open.deviceId, state.open.browserSessionId, state.open.tabId, state.open.startedAt, endedAt].join("\0");
    output.push({
      ...state.open,
      intervalId: `int_${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`,
      endedAt,
      durationMs,
      terminationReason: reason,
    });
  }
  state.open = null;
}

export function deriveFocusPeriods(intervals: ActiveInterval[], toleranceMs = 60_000): FocusPeriod[] {
  const ordered = [...intervals].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const groups: ActiveInterval[][] = [];
  for (const interval of ordered) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const gap = previous ? Date.parse(interval.startedAt) - Date.parse(previous.endedAt) : Number.POSITIVE_INFINITY;
    if (!current || !previous || interval.domain !== previous.domain || gap > toleranceMs) groups.push([interval]);
    else current.push(interval);
  }
  return groups.map((group) => {
    const sameUrlDurationMs = group.reduce((sum, interval, index) => {
      if (index === 0 || (interval.canonicalUrl ?? interval.url) === (group[index - 1]!.canonicalUrl ?? group[index - 1]!.url)) {
        return sum + interval.durationMs;
      }
      return sum;
    }, 0);
    const idleInterruptions = group.slice(1).filter((interval, index) => Date.parse(interval.startedAt) > Date.parse(group[index]!.endedAt)).length;
    return {
      focusPeriodId: `focus_${createHash("sha256").update(group.map((interval) => interval.intervalId).join("\0")).digest("hex").slice(0, 24)}`,
      startedAt: group[0]!.startedAt,
      endedAt: group.at(-1)!.endedAt,
      durationMs: group.reduce((sum, interval) => sum + interval.durationMs, 0),
      domain: group[0]!.domain,
      sameUrlDurationMs,
      switchesDuringPeriod: group.slice(1).filter((interval, index) => interval.tabId !== group[index]!.tabId).length,
      idleInterruptions,
      intervalIds: group.map((interval) => interval.intervalId),
      derivationVersion: 1 as const,
    };
  });
}

/** Count tab/domain transition boundaries once, even when one transition changes both. */
export function countUniqueContextBoundaries(intervals: ActiveInterval[]): number {
  const ordered = [...intervals].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return ordered.slice(1).filter((interval, index) => {
    const previous = ordered[index]!;
    return interval.tabId !== previous.tabId || interval.domain !== previous.domain;
  }).length;
}

export function countTabTransitions(intervals: ActiveInterval[]): number {
  const ordered = [...intervals].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return ordered.slice(1).filter((interval, index) => interval.tabId !== ordered[index]!.tabId).length;
}

export function countDomainTransitions(intervals: ActiveInterval[]): number {
  const ordered = [...intervals].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  return ordered.slice(1).filter((interval, index) => interval.domain !== ordered[index]!.domain).length;
}

export function groupResearchEpisodes(
  intervals: ActiveInterval[],
  ideas: CapturedIdea[] = [],
  options: { gapMs?: number; corrections?: EpisodeCorrection[] } = {},
): ResearchEpisode[] {
  const gapMs = options.gapMs ?? 30 * 60_000;
  const corrections = options.corrections ?? [];
  const splitAnchors = new Set(corrections.filter((correction) => correction.correctionType === "split_before").map((correction) => correction.anchorIntervalId));
  const mergeAnchors = new Set(corrections.filter((correction) => correction.correctionType === "merge_before").map((correction) => correction.anchorIntervalId));
  const ordered = [...intervals].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const groups: ActiveInterval[][] = [];
  for (const interval of ordered) {
    const current = groups.at(-1);
    if (!current || splitAnchors.has(interval.intervalId) || (!mergeAnchors.has(interval.intervalId) && !belongsToEpisode(interval, current, gapMs))) groups.push([interval]);
    else current.push(interval);
  }
  return groups.map((group) => buildEpisode(group, ideas, corrections));
}

function belongsToEpisode(candidate: ActiveInterval, current: ActiveInterval[], gapMs: number): boolean {
  const previous = current.at(-1)!;
  if (Date.parse(candidate.startedAt) - Date.parse(previous.endedAt) > gapMs) return false;
  const currentDomains = new Set(current.map((interval) => interval.domain).filter(Boolean));
  if (candidate.domain && currentDomains.has(candidate.domain)) return true;
  const currentTerms = new Set(current.flatMap(intervalTerms));
  return intervalTerms(candidate).some((term) => currentTerms.has(term));
}

function buildEpisode(intervals: ActiveInterval[], ideas: CapturedIdea[], corrections: EpisodeCorrection[]): ResearchEpisode {
  const first = intervals[0]!;
  const last = intervals.at(-1)!;
  const startedAt = first.startedAt;
  const endedAt = last.endedAt;
  const domains = intervals.map((interval) => interval.domain).filter((value): value is string => Boolean(value));
  const urls = intervals.map((interval) => interval.canonicalUrl ?? interval.url).filter((value): value is string => Boolean(value));
  const termCounts = countValues(intervals.flatMap(intervalTerms));
  const topicTerms = [...termCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 2)
    .map(([term]) => term);
  const deterministicTopicLabel = topicTerms.join(" ") || domains[0] || "unlabelled research";
  const intervalIds = new Set(intervals.map((interval) => interval.intervalId));
  const rename = [...corrections]
    .filter((correction) => correction.correctionType === "rename" && correction.label && intervalIds.has(correction.anchorIntervalId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const topicLabel = rename?.label ?? deterministicTopicLabel;
  const sharedTerms = [...termCounts.entries()].filter(([, count]) => count > 1).map(([term]) => term).sort();
  const relatedIdeas = ideas.filter((idea) => idea.capturedAt >= startedAt && idea.capturedAt <= endedAt);
  const activeDurationMs = intervals.reduce((sum, interval) => sum + interval.durationMs, 0);
  const evidence = [`Grouped by temporal proximity within ${Math.round(gapMsFor(intervals) / 60_000)} minute(s).`];
  if (sharedTerms.length) evidence.push(`Grouped by shared title terms: ${sharedTerms.join(", ")}.`);
  if (new Set(domains).size < domains.length) evidence.push("Grouped by a repeated domain.");
  if (relatedIdeas.length) evidence.push(`${relatedIdeas.length} explicitly captured idea(s) occurred during the episode.`);
  if (rename) evidence.push("Topic label set by an explicit user correction.");
  return {
    episodeId: `ep_${createHash("sha256").update(intervals.map((interval) => interval.intervalId).join("\0")).digest("hex").slice(0, 24)}`,
    startedAt,
    endedAt,
    topicLabel,
    topicConfidence: rename ? 1 : intervals.length === 0 ? 0 : Math.min(1, (termCounts.get(topicTerms[0] ?? "") ?? 0) / intervals.length),
    topicLabelSource: rename ? "user" : "deterministic",
    activeDurationMs,
    idleDurationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt) - activeDurationMs),
    uniqueDomains: new Set(domains).size,
    uniqueUrls: new Set(urls).size,
    tabSwitchCount: intervals.slice(1).filter((interval, index) => interval.tabId !== intervals[index]!.tabId).length,
    domainSwitchCount: intervals.slice(1).filter((interval, index) => interval.domain !== intervals[index]!.domain).length,
    ideaCount: relatedIdeas.length,
    outputCount: 0,
    derivationVersion: 1,
    evidence,
    intervalIds: intervals.map((interval) => interval.intervalId),
  };
}

const STOP_TERMS = new Set(["about", "after", "before", "from", "https", "into", "page", "that", "the", "this", "today", "with", "www"]);

function intervalTerms(interval: ActiveInterval): string[] {
  const path = (() => {
    try { return new URL(interval.canonicalUrl ?? interval.url ?? "").pathname; } catch { return ""; }
  })();
  return [...new Set(`${interval.title ?? ""} ${path}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4 && !STOP_TERMS.has(term)))];
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function gapMsFor(intervals: ActiveInterval[]): number {
  if (intervals.length < 2) return 0;
  return Math.max(...intervals.slice(1).map((interval, index) =>
    Math.max(0, Date.parse(interval.startedAt) - Date.parse(intervals[index]!.endedAt)),
  ));
}
