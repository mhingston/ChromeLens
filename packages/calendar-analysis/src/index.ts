import type { ActiveInterval, ResearchEpisode } from "../../domain/src/index.ts";

export interface CalendarWindow {
  date: string;
  timeZone: string;
  start: string;
  end: string;
}

export interface ActivityWindowProjection {
  intervals: ActiveInterval[];
  episodes: ResearchEpisode[];
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const windowCache = new Map<string, CalendarWindow>();

export function calendarDayWindow(date: string, timeZone: string): CalendarWindow {
  assertCalendarDate(date);
  assertTimeZone(timeZone);
  const cacheKey = `${timeZone}\0${date}`;
  const cached = windowCache.get(cacheKey);
  if (cached) return { ...cached };
  const followingDate = addCalendarDays(date, 1);
  const window = {
    date,
    timeZone,
    start: localDateBoundary(date, timeZone, true).toISOString(),
    end: localDateBoundary(followingDate, timeZone, false).toISOString(),
  };
  windowCache.set(cacheKey, window);
  return { ...window };
}

export function calendarDates(from: string, to: string, maximumDays = 90): string[] {
  assertCalendarDate(from);
  assertCalendarDate(to);
  if (!Number.isInteger(maximumDays) || maximumDays < 1) throw new Error("maximumDays must be a positive integer");
  if (from > to) throw new Error("The analysis start date must not be after its end date");
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    dates.push(cursor);
    if (dates.length > maximumDays) throw new Error(`Date ranges may contain at most ${maximumDays} days`);
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

export function addCalendarDays(date: string, days: number): string {
  assertCalendarDate(date);
  if (!Number.isInteger(days)) throw new Error("Calendar days must be an integer");
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function projectActivityWindow(
  intervals: ActiveInterval[],
  episodes: ResearchEpisode[],
  window: CalendarWindow,
): ActivityWindowProjection {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  const clipped = intervals
    .map((interval) => clipInterval(interval, startMs, endMs))
    .filter((interval): interval is ActiveInterval => interval !== null)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const clippedById = new Map(clipped.map((interval) => [interval.intervalId, interval]));
  const projectedEpisodes = episodes.flatMap((episode) => {
    const members = episode.intervalIds
      .map((intervalId) => clippedById.get(intervalId))
      .filter((interval): interval is ActiveInterval => interval !== undefined)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    if (!members.length) return [];
    const activeDurationMs = members.reduce((sum, interval) => sum + interval.durationMs, 0);
    const startedAt = members[0]!.startedAt;
    const endedAt = members.at(-1)!.endedAt;
    const domains = members.map((interval) => interval.domain).filter((value): value is string => value !== null);
    const urls = members.map((interval) => interval.canonicalUrl ?? interval.url).filter((value): value is string => value !== null);
    return [{
      ...episode,
      startedAt,
      endedAt,
      activeDurationMs,
      idleDurationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt) - activeDurationMs),
      uniqueDomains: new Set(domains).size,
      uniqueUrls: new Set(urls).size,
      tabSwitchCount: members.slice(1).filter((interval, index) => interval.tabId !== members[index]!.tabId).length,
      domainSwitchCount: members.slice(1).filter((interval, index) => interval.domain !== members[index]!.domain).length,
      intervalIds: members.map((interval) => interval.intervalId),
    }];
  });
  return { intervals: clipped, episodes: projectedEpisodes };
}

export function bucketActiveByLocalHour(intervals: ActiveInterval[], timeZone: string): number[] {
  assertTimeZone(timeZone);
  const buckets = Array.from({ length: 24 }, () => 0);
  for (const interval of intervals) {
    let cursor = Date.parse(interval.startedAt);
    const end = Date.parse(interval.endedAt);
    while (cursor < end) {
      const nextMinute = Math.floor(cursor / 60_000) * 60_000 + 60_000;
      const segmentEnd = Math.min(end, nextMinute);
      const hour = localPartsAt(cursor, timeZone).hour;
      buckets[hour]! += segmentEnd - cursor;
      cursor = segmentEnd;
    }
  }
  return buckets;
}

export function formatLocalDateTime(isoTimestamp: string, timeZone: string): string {
  assertTimeZone(timeZone);
  const timestamp = Date.parse(isoTimestamp);
  if (!Number.isFinite(timestamp)) throw new Error("Expected an ISO timestamp");
  const parts = localPartsAt(timestamp, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function clipInterval(interval: ActiveInterval, startMs: number, endMs: number): ActiveInterval | null {
  const intervalStart = Date.parse(interval.startedAt);
  const intervalEnd = Date.parse(interval.endedAt);
  const clippedStart = Math.max(intervalStart, startMs);
  const clippedEnd = Math.min(intervalEnd, endMs);
  if (clippedEnd <= clippedStart) return null;
  return {
    ...interval,
    startedAt: new Date(clippedStart).toISOString(),
    endedAt: new Date(clippedEnd).toISOString(),
    durationMs: clippedEnd - clippedStart,
  };
}

function localDateBoundary(date: string, timeZone: string, requireExactDate: boolean): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const approximate = Date.UTC(year, month - 1, day);
  let lower = approximate - 48 * 60 * 60_000;
  let upper = approximate + 48 * 60 * 60_000;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (localDateAt(middle, timeZone) < date) lower = middle + 1;
    else upper = middle;
  }
  if (requireExactDate && localDateAt(lower, timeZone) !== date) {
    throw new Error(`Local calendar date ${date} does not exist in ${timeZone}`);
  }
  return new Date(lower);
}

function localDateAt(timestamp: number, timeZone: string): string {
  const parts = localPartsAt(timestamp, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

function localPartsAt(timestamp: number, timeZone: string): LocalParts {
  const formatter = formatterCache.get(timeZone) ?? new Intl.DateTimeFormat("en-GB", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  const values = new Map(formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function assertCalendarDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Dates must use YYYY-MM-DD");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error("Invalid calendar date");
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    throw new Error("Invalid IANA time zone");
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
