export const ACTIVITY_EVENT_TYPES = [
  "browser_session_started",
  "browser_session_ended",
  "window_focused",
  "window_blurred",
  "tab_activated",
  "tab_deactivated",
  "tab_opened",
  "tab_closed",
  "url_changed",
  "title_changed",
  "user_active",
  "user_idle",
  "user_locked",
  "tracking_paused",
  "tracking_resumed",
  "idea_captured",
  "annotation_created",
] as const;

export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];
export type IdleState = "active" | "idle" | "locked" | null;

export interface ActivityEvent {
  eventId: string;
  schemaVersion: 1;
  eventType: ActivityEventType;
  occurredAt: string;
  deviceId: string;
  browser: "chrome" | "brave" | "chromium" | null;
  browserVersion: string | null;
  browserProfileId: string | null;
  browserSessionId: string;
  windowId: string | null;
  tabId: string | null;
  url: string | null;
  canonicalUrl: string | null;
  domain: string | null;
  title: string | null;
  navigationType: string | null;
  referrerUrl: string | null;
  idleState: IdleState;
  incognito: boolean;
  metadata: Record<string, unknown>;
}

export interface PersistedActivityEvent extends ActivityEvent {
  receivedAt: string;
}

export interface ActiveInterval {
  intervalId: string;
  deviceId: string;
  browserProfileId: string | null;
  browserSessionId: string;
  tabId: string | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  url: string | null;
  canonicalUrl: string | null;
  domain: string | null;
  title: string | null;
  terminationReason: string;
  derivationVersion: 1;
}

export interface ResearchEpisode {
  episodeId: string;
  startedAt: string;
  endedAt: string;
  topicLabel: string;
  topicConfidence: number;
  topicLabelSource: "deterministic" | "user";
  activeDurationMs: number;
  idleDurationMs: number;
  uniqueDomains: number;
  uniqueUrls: number;
  tabSwitchCount: number;
  domainSwitchCount: number;
  ideaCount: number;
  outputCount: number;
  derivationVersion: 1;
  evidence: string[];
  intervalIds: string[];
}

export const EPISODE_CORRECTION_TYPES = ["rename", "split_before", "merge_before"] as const;
export type EpisodeCorrectionType = (typeof EPISODE_CORRECTION_TYPES)[number];

export interface EpisodeCorrection {
  correctionId: string;
  createdAt: string;
  correctionType: EpisodeCorrectionType;
  anchorIntervalId: string;
  label: string | null;
}

export interface FocusPeriod {
  focusPeriodId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  domain: string | null;
  sameUrlDurationMs: number;
  switchesDuringPeriod: number;
  idleInterruptions: number;
  intervalIds: string[];
  derivationVersion: 1;
}

export interface CapturedIdea {
  ideaId: string;
  capturedAt: string;
  text: string;
  sourceUrl: string | null;
  sourceTitle: string | null;
  episodeId: string | null;
  tags: string[];
  createdVia: string;
}

export interface OutputRecord {
  outputId: string;
  outputType: string;
  occurredAt: string;
  title: string | null;
  reference: string | null;
  repository: string | null;
  sourceConnector: string;
  metadata: Record<string, unknown>;
}

export interface OutputEpisodeLink {
  outputId: string;
  episodeId: string;
  gapMs: number;
  reason: string;
  associationVersion: 1;
}

export interface LinkedOutput extends OutputRecord {
  episodeId: string | null;
  associationGapMs: number | null;
  associationReason: string | null;
}

export const EPISODE_ANNOTATION_LABELS = [
  "useful",
  "unproductive",
  "exploratory",
  "deep_work",
  "administrative",
  "learning",
  "idea_generating",
  "interrupted",
  "misclassified",
  "private_or_excluded",
] as const;

export type EpisodeAnnotationLabel = (typeof EPISODE_ANNOTATION_LABELS)[number];

export interface EpisodeAnnotation {
  annotationId: string;
  createdAt: string;
  episodeId: string;
  label: EpisodeAnnotationLabel;
  note: string | null;
  anchorIntervalIds: string[];
  anchorStartedAt: string | null;
  anchorEndedAt: string | null;
}

export function isActivityEventType(value: unknown): value is ActivityEventType {
  return typeof value === "string" && (ACTIVITY_EVENT_TYPES as readonly string[]).includes(value);
}
