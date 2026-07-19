export interface EpisodeIntervalView {
  intervalId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  title?: string | null;
  domain?: string | null;
  canonicalUrl?: string | null;
  url?: string | null;
}

export interface EpisodePageSummary {
  key: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  title: string;
  domain: string | null;
  visits: number;
}

export interface FocusPeriodView {
  domain?: string | null;
  durationMs: number;
}

export interface FocusContextSummary {
  domain: string | null;
  durationMs: number;
  periodCount: number;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes === 0) return "<1m";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function summarizeFocusPeriods(periods: FocusPeriodView[]): FocusContextSummary[] {
  const contexts = new Map<string | null, FocusContextSummary>();
  for (const period of periods) {
    const domain = period.domain ?? null;
    const existing = contexts.get(domain) ?? { domain, durationMs: 0, periodCount: 0 };
    existing.durationMs += period.durationMs;
    existing.periodCount += 1;
    contexts.set(domain, existing);
  }
  return [...contexts.values()].sort((left, right) =>
    right.durationMs - left.durationMs || (left.domain ?? "").localeCompare(right.domain ?? ""),
  );
}

export function summarizeEpisodePages(
  intervalIds: string[],
  intervals: EpisodeIntervalView[],
): EpisodePageSummary[] {
  const intervalsById = new Map(intervals.map((interval) => [interval.intervalId, interval]));
  const pages = new Map<string, EpisodePageSummary>();

  for (const intervalId of intervalIds) {
    const interval = intervalsById.get(intervalId);
    if (!interval) continue;
    const key = interval.canonicalUrl
      ?? interval.url
      ?? `${interval.domain ?? "private"}\0${interval.title ?? "context"}`;
    const existing = pages.get(key);
    if (existing) {
      existing.durationMs += interval.durationMs;
      existing.visits += 1;
      if (interval.endedAt > existing.endedAt) existing.endedAt = interval.endedAt;
      continue;
    }
    pages.set(key, {
      key,
      startedAt: interval.startedAt,
      endedAt: interval.endedAt,
      durationMs: interval.durationMs,
      title: interval.title || interval.domain || "Private context",
      domain: interval.domain ?? null,
      visits: 1,
    });
  }

  return [...pages.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}
