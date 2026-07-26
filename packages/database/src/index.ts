import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ActiveInterval,
  ActivityEvent,
  CapturedIdea,
  EpisodeCorrection,
  EpisodeCorrectionType,
  EpisodeAnnotation,
  EpisodeAnnotationLabel,
  FocusPeriod,
  LinkedOutput,
  OutputRecord,
  PersistedActivityEvent,
  ResearchEpisode,
} from "../../domain/src/index.ts";
import { EPISODE_ANNOTATION_LABELS } from "../../domain/src/index.ts";
import { associateOutputsToEpisodes, type OutputAssociationOptions } from "../../connectors/src/index.ts";
import { isExcludedUrl, sanitizeActivityEvent, sanitizeUrlForDisplay, type PrivacySettings } from "../../privacy/src/index.ts";
import { countDomainTransitions, countTabTransitions, countUniqueContextBoundaries, deriveActiveIntervals, deriveFocusPeriods, groupResearchEpisodes } from "../../sessionisation/src/index.ts";
import {
  addCalendarDays,
  bucketActiveByLocalHour,
  calendarRange,
  calendarDates,
  calendarDayWindow,
  formatLocalDateTime,
  projectActivityWindow,
  type CalendarRangeMode,
} from "../../calendar-analysis/src/index.ts";
import {
  createAnalysisExport as renderAnalysisExport,
  type AnalysisExportArtifact,
  type AnalysisExportOptions,
} from "../../analysis-pack/src/index.ts";
import { buildReviewItems } from "../../review/src/index.ts";
import { buildInsights, type InsightMetrics } from "../../insights/src/index.ts";

export interface IngestionReport {
  received: number;
  inserted: number;
  duplicates: number;
  excludedContexts: number;
  droppedIncognito: number;
}

export interface DailySummary {
  date: string;
  timeZone: string;
  window: { start: string; end: string };
  metrics: {
    activeDurationMs: number;
    ideaCount: number;
    tabSwitchCount: number;
    domainSwitchCount: number;
    uniqueContextBoundaryCount: number;
    uniqueContextBoundariesPerActiveHour: number;
    contextSwitchesPerActiveHour: number;
    outputCount: number;
  };
  topDomains: Array<{ domain: string; activeDurationMs: number; intervalCount: number }>;
  intervals: ActiveInterval[];
  focusPeriods: FocusPeriod[];
  episodes: ResearchEpisode[];
  ideas: CapturedIdea[];
  outputs: LinkedOutput[];
  annotations: EpisodeAnnotation[];
  corrections: EpisodeCorrection[];
  boundaries: Array<{ eventType: string; occurredAt: string; idleState: string | null }>;
  caveats: string[];
  derivationVersion: 1;
}

export interface DeleteFilter {
  domain?: string;
  url?: string;
  from?: string;
  to?: string;
  sessionId?: string;
  profileId?: string;
}

export interface DeleteReport {
  activityEventsDeleted: number;
  historicalUrlsDeleted: number;
  historicalVisitsDeleted: number;
  ideasDeleted: number;
}

export interface EpisodeCorrectionInput {
  episodeId: string;
  correctionType: EpisodeCorrectionType;
  label?: string | null;
  beforeIntervalId?: string;
}

export interface HistoricalUrlInput {
  sourceBrowser: string;
  sourceProfileId: string;
  sourceUrlId: number;
  url: string;
  canonicalUrl: string | null;
  domain: string | null;
  title: string | null;
  visitCount: number | null;
  typedCount: number | null;
  lastVisitAt: string | null;
  importedAt: string;
}

export interface HistoricalVisitInput {
  sourceBrowser: string;
  sourceProfileId: string;
  sourceVisitId: number;
  sourceUrlId: number;
  visitedAt: string;
  browserElapsedDurationMs: number | null;
  transitionType: string | null;
  transitionRaw: number | null;
  referringVisitId: number | null;
  openerVisitId: number | null;
  visitSource: string;
  importedAt: string;
}

export interface HistoricalSearchTermInput {
  sourceBrowser: string;
  sourceProfileId: string;
  sourceUrlId: number;
  term: string;
  importedAt: string;
}

export interface HistoryImportBatch {
  urls: HistoricalUrlInput[];
  visits: HistoricalVisitInput[];
  searchTerms: HistoricalSearchTermInput[];
  run: {
    importId: string;
    sourceBrowser: string;
    sourceProfileId: string;
    sourcePath: string;
    sourceSchemaVersion: number | null;
    importerVersion: string;
    fieldsImportedJson: string;
    startedAt: string;
    completedAt: string;
  };
}

export interface HistoricalSummaryOptions {
  browser?: string;
  profileId?: string;
  privacy?: PrivacySettings;
}

export class ActivityStore {
  readonly database: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.database.exec(INITIAL_SCHEMA);
    applySchemaMigrations(this.database);
  }

  importHistoryBatch(batch: HistoryImportBatch): { urlsInserted: number; visitsInserted: number; searchTermsInserted: number } {
    const insertUrl = this.database.prepare(`
      INSERT OR IGNORE INTO historical_urls(
        source_browser, source_profile_id, source_url_id, url, canonical_url, domain, title,
        visit_count, typed_count, last_visit_at, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVisit = this.database.prepare(`
      INSERT OR IGNORE INTO historical_visits(
        source_browser, source_profile_id, source_visit_id, source_url_id, visited_at,
        browser_elapsed_duration_ms, transition_type, transition_raw, referring_visit_id,
        opener_visit_id, visit_source, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTerm = this.database.prepare(`
      INSERT OR IGNORE INTO historical_search_terms(
        source_browser, source_profile_id, source_url_id, term, imported_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    const insertRun = this.database.prepare(`
      INSERT INTO import_runs(
        import_id, source_browser, source_profile_id, source_path, source_schema_version,
        importer_version, fields_imported_json, started_at, completed_at,
        urls_seen, visits_seen, urls_inserted, visits_inserted
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let urlsInserted = 0;
    let visitsInserted = 0;
    let searchTermsInserted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const url of batch.urls) {
        urlsInserted += Number(insertUrl.run(
          url.sourceBrowser, url.sourceProfileId, url.sourceUrlId, url.url, url.canonicalUrl,
          url.domain, url.title, url.visitCount, url.typedCount, url.lastVisitAt, url.importedAt,
        ).changes);
      }
      for (const visit of batch.visits) {
        visitsInserted += Number(insertVisit.run(
          visit.sourceBrowser, visit.sourceProfileId, visit.sourceVisitId, visit.sourceUrlId,
          visit.visitedAt, visit.browserElapsedDurationMs, visit.transitionType, visit.transitionRaw,
          visit.referringVisitId, visit.openerVisitId, visit.visitSource, visit.importedAt,
        ).changes);
      }
      for (const term of batch.searchTerms) {
        searchTermsInserted += Number(insertTerm.run(
          term.sourceBrowser, term.sourceProfileId, term.sourceUrlId, term.term, term.importedAt,
        ).changes);
      }
      insertRun.run(
        batch.run.importId, batch.run.sourceBrowser, batch.run.sourceProfileId, batch.run.sourcePath,
        batch.run.sourceSchemaVersion, batch.run.importerVersion, batch.run.fieldsImportedJson,
        batch.run.startedAt, batch.run.completedAt, batch.urls.length, batch.visits.length,
        urlsInserted, visitsInserted,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { urlsInserted, visitsInserted, searchTermsInserted };
  }

  importOutputs(outputs: OutputRecord[]): { inserted: number; duplicates: number } {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO outputs(
        output_id, output_type, occurred_at, title, reference, repository, source_connector, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const output of outputs) {
        if (!output.outputId || !output.outputType || !output.sourceConnector || !Number.isFinite(Date.parse(output.occurredAt))) {
          throw new Error("Outputs require an ID, type, connector, and valid occurrence timestamp");
        }
        inserted += Number(insert.run(
          output.outputId.slice(0, 500), output.outputType.slice(0, 100), new Date(output.occurredAt).toISOString(),
          output.title?.slice(0, 2_000) ?? null, output.reference?.slice(0, 2_000) ?? null,
          output.repository?.slice(0, 500) ?? null, output.sourceConnector.slice(0, 100),
          JSON.stringify(output.metadata ?? {}),
        ).changes);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { inserted, duplicates: outputs.length - inserted };
  }

  addAnnotation(input: { episodeId: string; label: EpisodeAnnotationLabel; note?: string | null }): EpisodeAnnotation {
    if (!(EPISODE_ANNOTATION_LABELS as readonly string[]).includes(input.label)) throw new Error("Unsupported episode annotation label");
    const row = this.database.prepare("SELECT * FROM research_episodes WHERE episode_id = ?").get(input.episodeId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Research episode not found");
    const episode = rowToEpisode(row);
    const annotation: EpisodeAnnotation = {
      annotationId: randomUUID(),
      createdAt: new Date().toISOString(),
      episodeId: input.episodeId,
      label: input.label,
      note: input.note?.trim().slice(0, 10_000) || null,
      anchorIntervalIds: episode.intervalIds,
      anchorStartedAt: episode.startedAt,
      anchorEndedAt: episode.endedAt,
    };
    this.database.prepare(`
      INSERT INTO annotations(annotation_id, created_at, episode_id, label, note, evidence_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      annotation.annotationId,
      annotation.createdAt,
      annotation.episodeId,
      annotation.label,
      annotation.note,
      JSON.stringify(annotationEvidence(annotation)),
    );
    return annotation;
  }

  addEpisodeCorrection(input: EpisodeCorrectionInput): EpisodeCorrection {
    const row = this.database.prepare("SELECT * FROM research_episodes WHERE episode_id = ?").get(input.episodeId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Research episode not found");
    if (input.correctionType !== "rename" && input.correctionType !== "split_before" && input.correctionType !== "merge_before") {
      throw new Error("Unsupported episode correction type");
    }
    const episode = rowToEpisode(row);
    const anchorIntervalId = input.correctionType === "split_before"
      ? input.beforeIntervalId ?? ""
      : episode.intervalIds[0] ?? "";
    if (!anchorIntervalId || !episode.intervalIds.includes(anchorIntervalId)) throw new Error("Correction anchor is not part of the episode");
    if (input.correctionType === "split_before" && anchorIntervalId === episode.intervalIds[0]) {
      throw new Error("An episode cannot be split before its first interval");
    }
    const label = input.correctionType === "rename" ? input.label?.trim().slice(0, 200) || null : null;
    if (input.correctionType === "rename" && !label) throw new Error("A corrected topic label is required");
    const correction: EpisodeCorrection = {
      correctionId: randomUUID(),
      createdAt: new Date().toISOString(),
      correctionType: input.correctionType,
      anchorIntervalId,
      label,
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (correction.correctionType === "split_before" || correction.correctionType === "merge_before") {
        this.database.prepare(`
          DELETE FROM episode_corrections
          WHERE anchor_interval_id = ? AND correction_type IN ('split_before', 'merge_before')
        `).run(anchorIntervalId);
      } else {
        this.database.prepare("DELETE FROM episode_corrections WHERE anchor_interval_id = ? AND correction_type = 'rename'").run(anchorIntervalId);
      }
      this.database.prepare(`
        INSERT INTO episode_corrections(correction_id, created_at, correction_type, anchor_interval_id, label)
        VALUES (?, ?, ?, ?, ?)
      `).run(correction.correctionId, correction.createdAt, correction.correctionType, correction.anchorIntervalId, correction.label);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.rebuildDerivations();
    return correction;
  }

  removeEpisodeCorrection(correctionId: string): boolean {
    const removed = Number(this.database.prepare("DELETE FROM episode_corrections WHERE correction_id = ?").run(correctionId).changes) > 0;
    if (removed) this.rebuildDerivations();
    return removed;
  }

  ingestEvents(events: ActivityEvent[], settings: PrivacySettings, receivedAt = new Date().toISOString()): IngestionReport {
    const insertEvent = this.database.prepare(`
      INSERT OR IGNORE INTO activity_events(
        event_id, schema_version, event_type, occurred_at, received_at, device_id, browser,
        browser_version, browser_profile_id, browser_session_id, window_id, tab_id, url,
        canonical_url, domain, title, navigation_type, referrer_url, idle_state, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertIdea = this.database.prepare(`
      INSERT OR IGNORE INTO captured_ideas(
        idea_id, captured_at, text, source_url, source_title, episode_id, tags_json, created_via
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'extension')
    `);
    let inserted = 0;
    let excludedContexts = 0;
    let droppedIncognito = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        if (event.incognito && !settings.allowIncognito) {
          droppedIncognito += 1;
          continue;
        }
        const sanitized = sanitizeActivityEvent(event, settings);
        if (sanitized.metadata.excluded === true) excludedContexts += 1;
        const metadata = { ...sanitized.metadata, ...(sanitized.incognito ? { incognito: true } : {}) };
        const changes = Number(insertEvent.run(
          sanitized.eventId, sanitized.schemaVersion, sanitized.eventType, sanitized.occurredAt,
          receivedAt, sanitized.deviceId, sanitized.browser, sanitized.browserVersion,
          sanitized.browserProfileId, sanitized.browserSessionId, sanitized.windowId, sanitized.tabId,
          sanitized.url, sanitized.canonicalUrl, sanitized.domain, sanitized.title,
          sanitized.navigationType, sanitized.referrerUrl, sanitized.idleState, JSON.stringify(metadata),
        ).changes);
        inserted += changes;
        if (changes && sanitized.eventType === "idea_captured") {
          const text = typeof sanitized.metadata.text === "string" ? sanitized.metadata.text.trim() : "";
          const tags = Array.isArray(sanitized.metadata.tags)
            ? sanitized.metadata.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20)
            : [];
          if (text) insertIdea.run(
            sanitized.eventId, sanitized.occurredAt, text.slice(0, 10_000), sanitized.url,
            sanitized.title, JSON.stringify(tags),
          );
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      received: events.length,
      inserted,
      duplicates: events.length - inserted - droppedIncognito,
      excludedContexts,
      droppedIncognito,
    };
  }

  rebuildDerivations(endAt?: string, associationOptions: OutputAssociationOptions = {}): { intervals: number; episodes: number; outputLinks: number } {
    return this.rebuildDerivationsInternal({
      ...(endAt ? { endAt } : {}),
      associationOptions,
      pruneOrphanAnnotations: false,
    });
  }

  rebuildSessions(
    sessionIds: readonly string[],
    endAt?: string,
    associationOptions: OutputAssociationOptions = {},
  ): { intervals: number; episodes: number; outputLinks: number } {
    const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))];
    if (!uniqueSessionIds.length) return this.rebuildDerivations(endAt, associationOptions);
    return this.rebuildDerivationsInternal({
      ...(endAt ? { endAt } : {}),
      associationOptions,
      sessionIds: uniqueSessionIds,
      pruneOrphanAnnotations: false,
    });
  }

  private rebuildDerivationsInternal(options: {
    endAt?: string;
    associationOptions: OutputAssociationOptions;
    sessionIds?: string[];
    pruneOrphanAnnotations: boolean;
  }): { intervals: number; episodes: number; outputLinks: number } {
    const events = options.sessionIds
      ? this.readActivityEventsForSessions(options.sessionIds)
      : this.readActivityEvents();
    const ideas = this.readIdeas();
    const derivedIntervals = deriveActiveIntervals(events, options.endAt ? { endAt: options.endAt } : {});
    const retainedIntervals = options.sessionIds ? this.readStoredIntervalsExcept(options.sessionIds) : [];
    const intervals = [...retainedIntervals, ...derivedIntervals].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const corrections = this.readEpisodeCorrections();
    const episodes = groupResearchEpisodes(intervals, ideas, { corrections });
    const outputs = this.readOutputs().map(({ episodeId: _episodeId, associationGapMs: _gap, associationReason: _reason, ...output }) => output);
    const outputLinks = associateOutputsToEpisodes(outputs, episodes, options.associationOptions);
    const annotations = this.readAnnotationsWithCurrentEpisodeEvidence();
    const outputCounts = new Map<string, number>();
    for (const link of outputLinks) outputCounts.set(link.episodeId, (outputCounts.get(link.episodeId) ?? 0) + 1);
    const insertInterval = this.database.prepare(`
      INSERT INTO active_intervals(
        interval_id, device_id, browser_profile_id, browser_session_id, tab_id, started_at,
        ended_at, duration_ms, url, canonical_url, domain, title, termination_reason, derivation_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEpisode = this.database.prepare(`
      INSERT INTO research_episodes(
        episode_id, started_at, ended_at, topic_label, topic_confidence, active_duration_ms,
        idle_duration_ms, unique_domains, unique_urls, tab_switch_count, domain_switch_count,
        idea_count, output_count, derivation_version, evidence_json, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const associateIdea = this.database.prepare("UPDATE captured_ideas SET episode_id = ? WHERE idea_id = ?");
    const insertOutputLink = this.database.prepare(`
      INSERT INTO output_episode_links(output_id, episode_id, gap_ms, reason, association_version)
      VALUES (?, ?, ?, ?, ?)
    `);
    const updateAnnotation = this.database.prepare("UPDATE annotations SET episode_id = ?, evidence_json = ? WHERE annotation_id = ?");
    const deleteAnnotation = this.database.prepare("DELETE FROM annotations WHERE annotation_id = ?");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM output_episode_links; DELETE FROM research_episodes; UPDATE captured_ideas SET episode_id = NULL;");
      if (options.sessionIds) {
        const placeholders = options.sessionIds.map(() => "?").join(",");
        this.database.prepare(`DELETE FROM active_intervals WHERE browser_session_id IN (${placeholders})`).run(...options.sessionIds);
      } else {
        this.database.exec("DELETE FROM active_intervals");
      }
      for (const interval of (options.sessionIds ? derivedIntervals : intervals)) insertInterval.run(
        interval.intervalId, interval.deviceId, interval.browserProfileId, interval.browserSessionId,
        interval.tabId, interval.startedAt, interval.endedAt, interval.durationMs, interval.url,
        interval.canonicalUrl, interval.domain, interval.title, interval.terminationReason,
        interval.derivationVersion,
      );
      for (const episode of episodes) insertEpisode.run(
        episode.episodeId, episode.startedAt, episode.endedAt, episode.topicLabel,
        episode.topicConfidence, episode.activeDurationMs, episode.idleDurationMs,
        episode.uniqueDomains, episode.uniqueUrls, episode.tabSwitchCount,
        episode.domainSwitchCount, episode.ideaCount, outputCounts.get(episode.episodeId) ?? 0,
        episode.derivationVersion, JSON.stringify(episode.evidence),
        JSON.stringify({ intervalIds: episode.intervalIds, topicLabelSource: episode.topicLabelSource }),
      );
      for (const idea of ideas) {
        const episode = episodes.find((candidate) => idea.capturedAt >= candidate.startedAt && idea.capturedAt <= candidate.endedAt);
        if (episode) associateIdea.run(episode.episodeId, idea.ideaId);
      }
      for (const link of outputLinks) insertOutputLink.run(
        link.outputId, link.episodeId, link.gapMs, link.reason, link.associationVersion,
      );
      const episodeIds = new Set(episodes.map((episode) => episode.episodeId));
      for (const annotation of annotations) {
        const matched = episodeIds.has(annotation.episodeId)
          ? episodes.find((episode) => episode.episodeId === annotation.episodeId) ?? null
          : bestEpisodeForAnnotation(annotation, episodes, options.pruneOrphanAnnotations);
        if (matched) {
          const reassociated: EpisodeAnnotation = {
            ...annotation,
            episodeId: matched.episodeId,
            anchorIntervalIds: annotation.anchorIntervalIds.length ? annotation.anchorIntervalIds : matched.intervalIds,
            anchorStartedAt: annotation.anchorStartedAt ?? matched.startedAt,
            anchorEndedAt: annotation.anchorEndedAt ?? matched.endedAt,
          };
          updateAnnotation.run(reassociated.episodeId, JSON.stringify(annotationEvidence(reassociated)), reassociated.annotationId);
        } else if (options.pruneOrphanAnnotations) {
          deleteAnnotation.run(annotation.annotationId);
        }
      }
      if (options.pruneOrphanAnnotations) {
        this.database.exec(`
          DELETE FROM episode_corrections
          WHERE anchor_interval_id NOT IN (SELECT interval_id FROM active_intervals)
        `);
      }
      this.database.prepare(`
        INSERT INTO derivation_runs(derivation_version, completed_at, input_event_count, interval_count, episode_count)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(derivation_version) DO UPDATE SET
          completed_at = excluded.completed_at,
          input_event_count = excluded.input_event_count,
          interval_count = excluded.interval_count,
          episode_count = excluded.episode_count
      `).run(new Date().toISOString(), this.countRows("activity_events"), intervals.length, episodes.length);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { intervals: intervals.length, episodes: episodes.length, outputLinks: outputLinks.length };
  }

  getDailySummary(date: string, timeZone = "UTC"): DailySummary {
    const calendarWindow = calendarDayWindow(date, timeZone);
    const { start, end } = calendarWindow;
    const storedIntervals = (this.database.prepare(`
      SELECT * FROM active_intervals WHERE started_at < ? AND ended_at > ? ORDER BY started_at
    `).all(end, start) as Array<Record<string, unknown>>).map(rowToInterval);
    const storedEpisodes = (this.database.prepare(`
      SELECT * FROM research_episodes WHERE started_at < ? AND ended_at > ? ORDER BY started_at
    `).all(end, start) as Array<Record<string, unknown>>).map(rowToEpisode);
    const projection = projectActivityWindow(storedIntervals, storedEpisodes, calendarWindow);
    const intervals = projection.intervals;
    let episodes = projection.episodes;
    const ideas = this.readIdeas(start, end);
    const episodeIds = new Set(episodes.map((episode) => episode.episodeId));
    const outputs = this.readOutputs().filter((output) =>
      (output.occurredAt >= start && output.occurredAt < end) || (output.episodeId !== null && episodeIds.has(output.episodeId)),
    );
    const annotations = this.readAnnotations().filter((annotation) => episodeIds.has(annotation.episodeId));
    const intervalIds = new Set(intervals.map((interval) => interval.intervalId));
    const corrections = this.readEpisodeCorrections().filter((correction) => intervalIds.has(correction.anchorIntervalId));
    episodes = episodes.map((episode) => ({
      ...episode,
      ideaCount: ideas.filter((idea) => idea.episodeId === episode.episodeId).length,
      outputCount: outputs.filter((output) => output.episodeId === episode.episodeId).length,
    }));
    const boundaries = (this.database.prepare(`
      SELECT event_type, occurred_at, idle_state FROM activity_events
      WHERE occurred_at >= ? AND occurred_at < ?
        AND event_type IN ('window_focused','window_blurred','user_active','user_idle','user_locked','tracking_paused','tracking_resumed')
      ORDER BY occurred_at, rowid
    `).all(start, end) as Array<Record<string, unknown>>).map((row) => ({
      eventType: String(row.event_type), occurredAt: String(row.occurred_at), idleState: nullableString(row.idle_state),
    }));
    const focusPeriods = deriveFocusPeriods(intervals);
    const activeDurationMs = intervals.reduce((sum, interval) => sum + interval.durationMs, 0);
    const domainTotals = new Map<string, { activeDurationMs: number; intervalCount: number }>();
    for (const interval of intervals) {
      if (!interval.domain) continue;
      const existing = domainTotals.get(interval.domain) ?? { activeDurationMs: 0, intervalCount: 0 };
      existing.activeDurationMs += interval.durationMs;
      existing.intervalCount += 1;
      domainTotals.set(interval.domain, existing);
    }
    const tabSwitchCount = countTabTransitions(intervals);
    const domainSwitchCount = countDomainTransitions(intervals);
    const uniqueContextBoundaryCount = countUniqueContextBoundaries(intervals);
    return {
      date,
      timeZone,
      window: { start, end },
      metrics: {
        activeDurationMs,
        ideaCount: ideas.length,
        outputCount: outputs.filter((output) => output.occurredAt >= start && output.occurredAt < end).length,
        tabSwitchCount,
        domainSwitchCount,
        uniqueContextBoundaryCount,
        uniqueContextBoundariesPerActiveHour: activeDurationMs > 0
          ? (uniqueContextBoundaryCount * 3_600_000) / activeDurationMs
          : 0,
        // Kept for API compatibility with earlier local dashboards. New UI uses the explicit metric above.
        contextSwitchesPerActiveHour: activeDurationMs > 0
          ? (uniqueContextBoundaryCount * 3_600_000) / activeDurationMs
          : 0,
      },
      topDomains: [...domainTotals.entries()]
        .map(([domain, values]) => ({ domain, ...values }))
        .sort((left, right) => right.activeDurationMs - left.activeDurationMs),
      intervals,
      focusPeriods,
      episodes,
      ideas,
      outputs,
      annotations,
      corrections,
      boundaries,
      caveats: [
        "Active time is observed foreground activity, not a productivity judgement.",
        "Historical browser-recorded elapsed duration is not included in active time.",
      ],
      derivationVersion: 1,
    };
  }

  getRangeSummary(
    from: string,
    days: number,
    timeZone = "UTC",
    options: { mode?: CalendarRangeMode; to?: string } = {},
  ): Record<string, unknown> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isInteger(days) || days < 1 || days > 90) {
      throw new Error("Range requires YYYY-MM-DD and 1-90 days");
    }
    const range = options.mode
      ? calendarRange(from, timeZone, options.mode, options.mode === "custom" ? from : undefined, options.mode === "custom" ? options.to : undefined)
      : calendarRange(from, timeZone, "custom", from, addCalendarDays(from, days - 1));
    const daily = range.dates.map((date) => this.getDailySummary(date, timeZone));
    const domainTotals = new Map<string, number>();
    const topics = new Map<string, number>();
    const focusDurations: number[] = [];
    const revisits = new Map<string, { url: string; title: string | null; visits: number }>();
    const seenIntervals = new Set<string>();
    for (const day of daily) {
      for (const domain of day.topDomains) domainTotals.set(domain.domain, (domainTotals.get(domain.domain) ?? 0) + domain.activeDurationMs);
      for (const episode of day.episodes) topics.set(episode.topicLabel, (topics.get(episode.topicLabel) ?? 0) + episode.activeDurationMs);
      focusDurations.push(...day.focusPeriods.map((period) => period.durationMs));
      for (const interval of day.intervals) {
        if (seenIntervals.has(interval.intervalId)) continue;
        seenIntervals.add(interval.intervalId);
        const url = interval.canonicalUrl ?? interval.url;
        if (!url) continue;
        const existing = revisits.get(url) ?? { url, title: interval.title, visits: 0 };
        existing.visits += 1;
        revisits.set(url, existing);
      }
    }
    const activeDurationMs = daily.reduce((sum, day) => sum + day.metrics.activeDurationMs, 0);
    const tabSwitchCount = daily.reduce((sum, day) => sum + day.metrics.tabSwitchCount, 0);
    const domainSwitchCount = daily.reduce((sum, day) => sum + day.metrics.domainSwitchCount, 0);
    const uniqueContextBoundaryCount = daily.reduce((sum, day) => sum + day.metrics.uniqueContextBoundaryCount, 0);
    const activityByHour = bucketActiveByLocalHour(daily.flatMap((day) => day.intervals), timeZone);
    const outputsInRange = new Map(daily.flatMap((day) => day.outputs
      .filter((output) => output.occurredAt >= day.window.start && output.occurredAt < day.window.end)
      .map((output) => [output.outputId, output] as const)));
    return {
      from: range.from,
      to: range.to,
      anchorDate: from,
      mode: range.mode,
      days: range.dates.length,
      timeZone,
      daily: daily.map((day) => ({ date: day.date, ...day.metrics })),
      metrics: {
        activeDurationMs,
        medianFocusDurationMs: median(focusDurations),
        tabSwitchCount,
        domainSwitchCount,
        uniqueContextBoundaryCount,
        uniqueContextBoundariesPerActiveHour: activeDurationMs ? (uniqueContextBoundaryCount * 3_600_000) / activeDurationMs : 0,
        ideaCount: daily.reduce((sum, day) => sum + day.metrics.ideaCount, 0),
        outputCount: outputsInRange.size,
        outputLinkedEpisodeCount: new Set([...outputsInRange.values()].map((output) => output.episodeId).filter(Boolean)).size,
        contextSwitchesPerActiveHour: activeDurationMs ? (uniqueContextBoundaryCount * 3_600_000) / activeDurationMs : 0,
      },
      topDomains: [...domainTotals.entries()].map(([domain, durationMs]) => ({ domain, activeDurationMs: durationMs })).sort((a, b) => b.activeDurationMs - a.activeDurationMs).slice(0, 12),
      topics: [...topics.entries()].map(([topic, durationMs]) => ({ topic, activeDurationMs: durationMs })).sort((a, b) => b.activeDurationMs - a.activeDurationMs).slice(0, 12),
      revisitedPages: [...revisits.values()].filter((item) => item.visits > 1).sort((a, b) => b.visits - a.visits).slice(0, 12),
      activityByHour: activityByHour.map((activeDurationMs, hour) => ({ hour, activeDurationMs })),
      caveat: "These are observed browsing patterns, not productivity scores.",
    };
  }

  getOverview(
    from: string,
    days: number,
    timeZone = "UTC",
    options: { mode?: CalendarRangeMode; to?: string } = {},
  ): Record<string, unknown> {
    const range = options.mode
      ? calendarRange(from, timeZone, options.mode, options.mode === "custom" ? from : undefined, options.mode === "custom" ? options.to : undefined)
      : calendarRange(from, timeZone, "custom", from, addCalendarDays(from, days - 1));
    const daily = range.dates.map((date) => this.getDailySummary(date, timeZone));
    const episodes = uniqueById(daily.flatMap((day) => day.episodes), (episode) => episode.episodeId);
    const outputs = uniqueById(daily.flatMap((day) => day.outputs), (output) => output.outputId);
    const ideas = uniqueById(daily.flatMap((day) => day.ideas), (idea) => idea.ideaId);
    const annotations = uniqueById(daily.flatMap((day) => day.annotations), (annotation) => annotation.annotationId);
    const current = this.getRangeSummary(range.from, range.dates.length, timeZone, { mode: "custom", to: range.to });
    const previousFrom = addCalendarDays(range.from, -range.dates.length);
    const previousTo = addCalendarDays(previousFrom, range.dates.length - 1);
    const previous = this.getRangeSummary(previousFrom, range.dates.length, timeZone, { mode: "custom", to: previousTo });
    const latestEventAt = this.getLastObservedEventAt();
    const reviewItems = buildReviewItems({ episodes, annotations, outputs, ideas });
    const currentMetrics = current.metrics as InsightMetrics;
    const previousMetrics = previous.metrics as InsightMetrics;
    const insights = buildInsights({
      period: { from: range.from, to: range.to, timeZone },
      current: { from: range.from, to: range.to, timeZone, days: range.dates.length, metrics: currentMetrics, daysWithActivity: daily.filter((day) => day.intervals.length > 0).length },
      previous: { from: previousFrom, to: previousTo, timeZone, days: range.dates.length, metrics: previousMetrics, daysWithActivity: (previous.daily as Array<{ activeDurationMs: number }>).filter((day) => day.activeDurationMs > 0).length },
      episodes,
      intervals: uniqueById(daily.flatMap((day) => day.intervals), (interval) => interval.intervalId),
      focusPeriods: uniqueById(daily.flatMap((day) => day.focusPeriods), (period) => period.focusPeriodId),
      outputs,
      ideas,
      annotations,
      coverage: {
        observedDays: range.dates.length,
        daysWithActivity: daily.filter((day) => day.intervals.length > 0).length,
        intervalCount: new Set(daily.flatMap((day) => day.intervals.map((interval) => interval.intervalId))).size,
        lastObservedEventAt: latestEventAt,
      },
    });
    return {
      period: { mode: range.mode, from: range.from, to: range.to, timeZone: range.timeZone, days: range.dates.length },
      coverage: {
        observedDays: range.dates.length,
        daysWithActivity: daily.filter((day) => day.intervals.length > 0).length,
        intervalCount: new Set(daily.flatMap((day) => day.intervals.map((interval) => interval.intervalId))).size,
        activeDurationMs: daily.reduce((sum, day) => sum + day.metrics.activeDurationMs, 0),
        lastObservedEventAt: latestEventAt,
        historicalVisits: this.getHistoricalStats().visits,
      },
      summary: current,
      previousSummary: previous,
      reviewItems,
      insights,
      recentIdeas: ideas.slice(-8).reverse(),
      recentOutputs: outputs.slice(-8).reverse(),
      resumeCandidates: episodes.filter((episode) => episode.ideaCount > 0 && episode.outputCount === 0).slice(-8).reverse().map((episode) => ({
        episodeId: episode.episodeId,
        date: episode.startedAt.slice(0, 10),
        topicLabel: episode.topicLabel,
        activeDurationMs: episode.activeDurationMs,
        reason: "Contains an explicit idea and no linked output.",
      })),
    };
  }

  getInsights(
    from: string,
    days: number,
    timeZone = "UTC",
    options: { mode?: CalendarRangeMode; to?: string } = {},
  ): Record<string, unknown> {
    const overview = this.getOverview(from, days, timeZone, options);
    return { period: overview.period, coverage: overview.coverage, insights: overview.insights };
  }

  getHistoricalSummary(timeZone = "UTC", options: HistoricalSummaryOptions = {}): Record<string, unknown> {
    try { new Intl.DateTimeFormat("en", { timeZone }).format(0); }
    catch { throw new Error("Invalid IANA time zone"); }
    const allUrlRows = this.database.prepare("SELECT * FROM historical_urls ORDER BY last_visit_at").all() as Array<Record<string, unknown>>;
    const visibleUrlRows = allUrlRows.filter((row) => !options.privacy || !isExcludedUrl(String(row.url), options.privacy));
    const selectedUrlRows = visibleUrlRows.filter((row) => matchesHistoryProfile(row, options));
    const visibleUrlKeys = new Set(visibleUrlRows.map(historyRowKey));
    const selectedUrlKeys = new Set(selectedUrlRows.map(historyRowKey));
    const allVisitRows = this.database.prepare("SELECT * FROM historical_visits ORDER BY visited_at").all() as Array<Record<string, unknown>>;
    const visibleVisitRows = allVisitRows.filter((row) => visibleUrlKeys.has(historyRowKey(row)));
    const selectedVisitRows = visibleVisitRows.filter((row) => selectedUrlKeys.has(historyRowKey(row)) && matchesHistoryProfile(row, options));
    const displayUrl = (row: Record<string, unknown>): string | null => options.privacy
      ? sanitizeUrlForDisplay(String(row.url), options.privacy)
      : String(row.url);
    const displayUrlByKey = new Map(selectedUrlRows.map((row) => [historyRowKey(row), displayUrl(row)] as const));
    const visitTimesByUrl = new Map<string, string[]>();
    for (const row of selectedVisitRows) {
      const key = historyRowKey(row);
      const values = visitTimesByUrl.get(key) ?? [];
      values.push(String(row.visited_at));
      visitTimesByUrl.set(key, values);
    }
    // History timestamps are stored as UTC instants. Project each visit into the requested
    // IANA zone before grouping; grouping the raw ISO hour would mislabel local patterns.
    const hourCounts = Array.from({ length: 24 }, () => 0);
    for (const row of selectedVisitRows) {
      const local = formatLocalDateTime(String(row.visited_at), timeZone);
      hourCounts[Number(local.slice(11, 13))]! += 1;
    }
    const domainTotals = new Map<string, { visits: number; pages: number; firstVisitAt: string | null; latestVisitAt: string | null }>();
    for (const row of selectedUrlRows) {
      const domain = nullableString(row.domain);
      if (!domain) continue;
      const times = visitTimesByUrl.get(historyRowKey(row)) ?? [];
      const existing = domainTotals.get(domain) ?? { visits: 0, pages: 0, firstVisitAt: null, latestVisitAt: null };
      existing.visits += row.visit_count === null || row.visit_count === undefined ? times.length : Number(row.visit_count);
      existing.pages += 1;
      existing.firstVisitAt = minIso(existing.firstVisitAt, times[0] ?? null);
      existing.latestVisitAt = maxIso(existing.latestVisitAt, times.at(-1) ?? null);
      domainTotals.set(domain, existing);
    }
    const topDomains = [...domainTotals.entries()]
      .map(([domain, values]) => ({ domain, ...values }))
      .sort((left, right) => right.visits - left.visits || left.domain.localeCompare(right.domain))
      .slice(0, 20);
    const revisitedPages = selectedUrlRows
      .filter((row) => row.visit_count !== null && Number(row.visit_count) > 1)
      .map((row) => {
        const times = visitTimesByUrl.get(historyRowKey(row)) ?? [];
        return {
          url: displayUrlByKey.get(historyRowKey(row)), title: nullableString(row.title), domain: nullableString(row.domain),
          visitCount: row.visit_count === null || row.visit_count === undefined ? null : Number(row.visit_count),
          typedCount: row.typed_count === null || row.typed_count === undefined ? null : Number(row.typed_count),
          lastVisitAt: nullableString(row.last_visit_at), firstVisitAt: times[0] ?? null,
          browser: String(row.source_browser), profileId: String(row.source_profile_id),
        };
      })
      .sort((left, right) => (right.visitCount ?? 0) - (left.visitCount ?? 0) || (left.url ?? "").localeCompare(right.url ?? ""))
      .slice(0, 20);
    const searchTermRows = this.database.prepare("SELECT term, source_browser, source_profile_id, source_url_id FROM historical_search_terms ORDER BY term").all() as Array<Record<string, unknown>>;
    const selectedSearchTerms = searchTermRows.filter((row) => {
      const key = `${String(row.source_browser)}\0${String(row.source_profile_id)}\0${String(row.source_url_id)}`;
      return visibleUrlKeys.has(key) && selectedUrlKeys.has(key);
    });
    const searchTermCounts = new Map<string, { term: string; browser: string; profileId: string; occurrences: number }>();
    for (const row of selectedSearchTerms) {
      const key = `${String(row.source_browser)}\0${String(row.source_profile_id)}\0${String(row.term)}`;
      const existing = searchTermCounts.get(key) ?? { term: String(row.term), browser: String(row.source_browser), profileId: String(row.source_profile_id), occurrences: 0 };
      existing.occurrences += 1;
      searchTermCounts.set(key, existing);
    }
    const searchTerms = [...searchTermCounts.values()]
      .sort((left, right) => right.occurrences - left.occurrences || left.term.localeCompare(right.term))
      .slice(0, 50);
    const profileCounts = new Map<string, { browser: string; profileId: string; visits: number; firstVisitAt: string | null; latestVisitAt: string | null }>();
    for (const row of visibleVisitRows) {
      const key = `${String(row.source_browser)}\0${String(row.source_profile_id)}`;
      const existing = profileCounts.get(key) ?? { browser: String(row.source_browser), profileId: String(row.source_profile_id), visits: 0, firstVisitAt: null, latestVisitAt: null };
      existing.visits += 1;
      existing.firstVisitAt = minIso(existing.firstVisitAt, String(row.visited_at));
      existing.latestVisitAt = maxIso(existing.latestVisitAt, String(row.visited_at));
      profileCounts.set(key, existing);
    }
    const profileOptions = [...profileCounts.values()].sort((left, right) => left.browser.localeCompare(right.browser) || left.profileId.localeCompare(right.profileId));
    const profiles = profileOptions.filter((profile) => (!options.browser || profile.browser === options.browser) && (!options.profileId || profile.profileId === options.profileId));
    const importRuns = (this.database.prepare("SELECT import_id, source_browser, source_profile_id, source_schema_version, importer_version, fields_imported_json, started_at, completed_at, urls_seen, visits_seen, urls_inserted, visits_inserted FROM import_runs ORDER BY completed_at DESC").all() as Array<Record<string, unknown>>)
      .filter((row) => (!options.browser || row.source_browser === options.browser) && (!options.profileId || row.source_profile_id === options.profileId));
    const selectedStats = { urls: selectedUrlRows.length, visits: selectedVisitRows.length, searchTerms: selectedSearchTerms.length };
    return {
      ...selectedStats,
      timeZone,
      browser: options.browser ?? null,
      profileId: options.profileId ?? null,
      topDomains,
      revisitedPages,
      visitsByHour: hourCounts.map((visits, hour) => ({ hour, visits })),
      searchTerms: searchTerms.map((row) => ({
        term: row.term, browser: row.browser, profileId: row.profileId, occurrences: row.occurrences,
      })),
      profiles,
      profileOptions,
      importRuns: importRuns.map((row) => ({
        importId: String(row.import_id), browser: String(row.source_browser), profileId: String(row.source_profile_id),
        schemaVersion: row.source_schema_version === null || row.source_schema_version === undefined ? null : Number(row.source_schema_version),
        importerVersion: String(row.importer_version), fieldsImportedJson: String(row.fields_imported_json),
        startedAt: String(row.started_at), completedAt: String(row.completed_at), urlsSeen: Number(row.urls_seen), visitsSeen: Number(row.visits_seen),
        urlsInserted: Number(row.urls_inserted), visitsInserted: Number(row.visits_inserted),
      })),
      caveat: "Historical visits are browser-recorded evidence only. They are not prospective active intervals, focused attention, or productivity measures.",
    };
  }

  getLastObservedEventAt(): string | null {
    const row = this.database.prepare("SELECT MAX(occurred_at) AS occurred_at FROM activity_events").get() as { occurred_at?: string | null } | undefined;
    return row?.occurred_at ?? null;
  }

  readActivityEvents(): PersistedActivityEvent[] {
    const rows = this.database.prepare("SELECT * FROM activity_events ORDER BY occurred_at, rowid").all() as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  private readActivityEventsForSessions(sessionIds: readonly string[]): PersistedActivityEvent[] {
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT * FROM activity_events
      WHERE browser_session_id IN (${placeholders})
      ORDER BY occurred_at, rowid
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  private readStoredIntervalsExcept(sessionIds: readonly string[]): ActiveInterval[] {
    const placeholders = sessionIds.map(() => "?").join(",");
    const rows = this.database.prepare(`
      SELECT * FROM active_intervals
      WHERE browser_session_id NOT IN (${placeholders})
      ORDER BY started_at
    `).all(...sessionIds) as Array<Record<string, unknown>>;
    return rows.map(rowToInterval);
  }

  readIdeas(from?: string, to?: string): CapturedIdea[] {
    const rows = from && to
      ? this.database.prepare("SELECT * FROM captured_ideas WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at").all(from, to)
      : this.database.prepare("SELECT * FROM captured_ideas ORDER BY captured_at").all();
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      ideaId: String(row.idea_id),
      capturedAt: String(row.captured_at),
      text: String(row.text),
      sourceUrl: nullableString(row.source_url),
      sourceTitle: nullableString(row.source_title),
      episodeId: nullableString(row.episode_id),
      tags: parseStringArray(row.tags_json),
      createdVia: String(row.created_via),
    }));
  }

  readOutputs(): LinkedOutput[] {
    const rows = this.database.prepare(`
      SELECT o.*, l.episode_id, l.gap_ms, l.reason
      FROM outputs o LEFT JOIN output_episode_links l ON l.output_id = o.output_id
      ORDER BY o.occurred_at
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      outputId: String(row.output_id),
      outputType: String(row.output_type),
      occurredAt: String(row.occurred_at),
      title: nullableString(row.title),
      reference: nullableString(row.reference),
      repository: nullableString(row.repository),
      sourceConnector: String(row.source_connector),
      metadata: parseObject(row.metadata_json),
      episodeId: nullableString(row.episode_id),
      associationGapMs: row.gap_ms === null || row.gap_ms === undefined ? null : Number(row.gap_ms),
      associationReason: nullableString(row.reason),
    }));
  }

  readAnnotations(): EpisodeAnnotation[] {
    const rows = this.database.prepare("SELECT * FROM annotations ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map(rowToAnnotation);
  }

  readEpisodeCorrections(): EpisodeCorrection[] {
    const rows = this.database.prepare("SELECT * FROM episode_corrections ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      correctionId: String(row.correction_id),
      createdAt: String(row.created_at),
      correctionType: String(row.correction_type) as EpisodeCorrectionType,
      anchorIntervalId: String(row.anchor_interval_id),
      label: nullableString(row.label),
    }));
  }

  private readAnnotationsWithCurrentEpisodeEvidence(): EpisodeAnnotation[] {
    return this.readAnnotations().map((annotation) => {
      if (annotation.anchorIntervalIds.length || annotation.anchorStartedAt || annotation.anchorEndedAt) return annotation;
      const row = this.database.prepare("SELECT * FROM research_episodes WHERE episode_id = ?").get(annotation.episodeId) as Record<string, unknown> | undefined;
      if (!row) return annotation;
      const episode = rowToEpisode(row);
      return {
        ...annotation,
        anchorIntervalIds: episode.intervalIds,
        anchorStartedAt: episode.startedAt,
        anchorEndedAt: episode.endedAt,
      };
    });
  }

  deleteData(filter: DeleteFilter): DeleteReport {
    if (!Object.values(filter).some((value) => typeof value === "string" && value.length > 0)) {
      throw new Error("At least one deletion filter is required");
    }
    const eventConditions: string[] = [];
    const eventValues: string[] = [];
    if (filter.domain) { eventConditions.push("domain = ?"); eventValues.push(filter.domain.toLowerCase()); }
    if (filter.url) { eventConditions.push("(url = ? OR canonical_url = ?)"); eventValues.push(filter.url, filter.url); }
    if (filter.from) { eventConditions.push("occurred_at >= ?"); eventValues.push(filter.from); }
    if (filter.to) { eventConditions.push("occurred_at < ?"); eventValues.push(filter.to); }
    if (filter.sessionId) { eventConditions.push("browser_session_id = ?"); eventValues.push(filter.sessionId); }
    if (filter.profileId) { eventConditions.push("browser_profile_id = ?"); eventValues.push(filter.profileId); }
    const eventWhere = eventConditions.length ? eventConditions.join(" AND ") : "0";

    const urlConditions: string[] = [];
    const urlValues: string[] = [];
    if (filter.domain) { urlConditions.push("domain = ?"); urlValues.push(filter.domain.toLowerCase()); }
    if (filter.url) { urlConditions.push("(url = ? OR canonical_url = ?)"); urlValues.push(filter.url, filter.url); }
    if (filter.from) { urlConditions.push("last_visit_at >= ?"); urlValues.push(filter.from); }
    if (filter.to) { urlConditions.push("last_visit_at < ?"); urlValues.push(filter.to); }
    if (filter.profileId) { urlConditions.push("source_profile_id = ?"); urlValues.push(filter.profileId); }
    const urlWhere = urlConditions.length ? urlConditions.join(" AND ") : "0";

    const visitConditions: string[] = [];
    const visitValues: string[] = [];
    if (filter.from) { visitConditions.push("visited_at >= ?"); visitValues.push(filter.from); }
    if (filter.to) { visitConditions.push("visited_at < ?"); visitValues.push(filter.to); }
    if (filter.profileId) { visitConditions.push("source_profile_id = ?"); visitValues.push(filter.profileId); }
    if (filter.domain || filter.url) {
      visitConditions.push(`EXISTS (
        SELECT 1 FROM historical_urls u
        WHERE u.source_browser = historical_visits.source_browser
          AND u.source_profile_id = historical_visits.source_profile_id
          AND u.source_url_id = historical_visits.source_url_id
          AND ${[filter.domain ? "u.domain = ?" : "", filter.url ? "(u.url = ? OR u.canonical_url = ?)" : ""].filter(Boolean).join(" AND ")}
      )`);
      if (filter.domain) visitValues.push(filter.domain.toLowerCase());
      if (filter.url) visitValues.push(filter.url, filter.url);
    }
    const visitWhere = visitConditions.length ? visitConditions.join(" AND ") : "0";

    let activityEventsDeleted = 0;
    let historicalUrlsDeleted = 0;
    let historicalVisitsDeleted = 0;
    let ideasDeleted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const eventIds = this.database.prepare(`SELECT event_id FROM activity_events WHERE ${eventWhere}`)
        .all(...eventValues) as Array<{ event_id: string }>;
      const deleteIdea = this.database.prepare("DELETE FROM captured_ideas WHERE idea_id = ?");
      for (const row of eventIds) ideasDeleted += Number(deleteIdea.run(row.event_id).changes);
      activityEventsDeleted = Number(this.database.prepare(`DELETE FROM activity_events WHERE ${eventWhere}`).run(...eventValues).changes);
      historicalVisitsDeleted = Number(this.database.prepare(`DELETE FROM historical_visits WHERE ${visitWhere}`).run(...visitValues).changes);
      if (urlConditions.length) {
        this.database.prepare(`DELETE FROM historical_search_terms WHERE EXISTS (
          SELECT 1 FROM historical_urls u
          WHERE u.source_browser = historical_search_terms.source_browser
            AND u.source_profile_id = historical_search_terms.source_profile_id
            AND u.source_url_id = historical_search_terms.source_url_id
            AND ${urlWhere.replaceAll(/\b(domain|url|canonical_url|last_visit_at|source_profile_id)\b/g, "u.$1")}
        )`).run(...urlValues);
        historicalUrlsDeleted = Number(this.database.prepare(`DELETE FROM historical_urls WHERE ${urlWhere}`).run(...urlValues).changes);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.rebuildDerivationsInternal({ associationOptions: {}, pruneOrphanAnnotations: true });
    return { activityEventsDeleted, historicalUrlsDeleted, historicalVisitsDeleted, ideasDeleted };
  }

  getHistoricalStats(): { urls: number; visits: number; searchTerms: number } {
    const count = (table: string): number => {
      const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      return Number(row.count);
    };
    return {
      urls: count("historical_urls"),
      visits: count("historical_visits"),
      searchTerms: count("historical_search_terms"),
    };
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.database.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json?: string } | undefined;
    if (!row?.value_json) return fallback;
    try { return JSON.parse(row.value_json) as T; } catch { return fallback; }
  }

  setSetting(key: string, value: unknown): void {
    this.database.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  exportData(): Record<string, unknown> {
    const all = (sql: string): Array<Record<string, unknown>> => this.database.prepare(sql).all() as Array<Record<string, unknown>>;
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      caveat: "Browser activity is contextual evidence, not a productivity judgement.",
      activityEvents: this.readActivityEvents(),
      historicalUrls: all("SELECT * FROM historical_urls ORDER BY last_visit_at"),
      historicalVisits: all("SELECT * FROM historical_visits ORDER BY visited_at"),
      historicalSearchTerms: all("SELECT * FROM historical_search_terms ORDER BY imported_at"),
      activeIntervals: all("SELECT * FROM active_intervals ORDER BY started_at").map(rowToInterval),
      researchEpisodes: all("SELECT * FROM research_episodes ORDER BY started_at").map(rowToEpisode),
      capturedIdeas: this.readIdeas(),
      outputs: this.readOutputs(),
      annotations: this.readAnnotations(),
      episodeCorrections: this.readEpisodeCorrections(),
    };
  }

  createAnalysisExport(options: AnalysisExportOptions): AnalysisExportArtifact {
    const dates = calendarDates(options.from, options.to, 90);
    const days = dates.map((date) => this.getDailySummary(date, options.timeZone));
    return renderAnalysisExport(days, options);
  }

  private countRows(table: "activity_events"): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return Number(row.count);
  }

  close(): void {
    this.database.close();
  }
}

function rowToEvent(row: Record<string, unknown>): PersistedActivityEvent {
  const metadata = parseObject(row.metadata_json);
  return {
    eventId: String(row.event_id),
    schemaVersion: 1,
    eventType: String(row.event_type) as ActivityEvent["eventType"],
    occurredAt: String(row.occurred_at),
    receivedAt: String(row.received_at),
    deviceId: String(row.device_id),
    browser: nullableString(row.browser) as ActivityEvent["browser"],
    browserVersion: nullableString(row.browser_version),
    browserProfileId: nullableString(row.browser_profile_id),
    browserSessionId: String(row.browser_session_id),
    windowId: nullableString(row.window_id),
    tabId: nullableString(row.tab_id),
    url: nullableString(row.url),
    canonicalUrl: nullableString(row.canonical_url),
    domain: nullableString(row.domain),
    title: nullableString(row.title),
    navigationType: nullableString(row.navigation_type),
    referrerUrl: nullableString(row.referrer_url),
    idleState: nullableString(row.idle_state) as ActivityEvent["idleState"],
    incognito: metadata.incognito === true,
    metadata,
  };
}

function rowToInterval(row: Record<string, unknown>): ActiveInterval {
  return {
    intervalId: String(row.interval_id),
    deviceId: String(row.device_id),
    browserProfileId: nullableString(row.browser_profile_id),
    browserSessionId: String(row.browser_session_id),
    tabId: nullableString(row.tab_id),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    durationMs: Number(row.duration_ms),
    url: nullableString(row.url),
    canonicalUrl: nullableString(row.canonical_url),
    domain: nullableString(row.domain),
    title: nullableString(row.title),
    terminationReason: String(row.termination_reason),
    derivationVersion: 1,
  };
}

function rowToEpisode(row: Record<string, unknown>): ResearchEpisode {
  const metadata = parseObject(row.metadata_json);
  return {
    episodeId: String(row.episode_id),
    startedAt: String(row.started_at),
    endedAt: String(row.ended_at),
    topicLabel: String(row.topic_label ?? "unlabelled research"),
    topicConfidence: Number(row.topic_confidence ?? 0),
    topicLabelSource: metadata.topicLabelSource === "user" ? "user" : "deterministic",
    activeDurationMs: Number(row.active_duration_ms),
    idleDurationMs: Number(row.idle_duration_ms),
    uniqueDomains: Number(row.unique_domains),
    uniqueUrls: Number(row.unique_urls),
    tabSwitchCount: Number(row.tab_switch_count),
    domainSwitchCount: Number(row.domain_switch_count),
    ideaCount: Number(row.idea_count),
    outputCount: Number(row.output_count),
    derivationVersion: 1,
    evidence: parseStringArray(row.evidence_json),
    intervalIds: Array.isArray(metadata.intervalIds)
      ? metadata.intervalIds.filter((value): value is string => typeof value === "string")
      : [],
  };
}

function rowToAnnotation(row: Record<string, unknown>): EpisodeAnnotation {
  const evidence = parseObject(row.evidence_json);
  return {
    annotationId: String(row.annotation_id),
    createdAt: String(row.created_at),
    episodeId: String(row.episode_id),
    label: String(row.label) as EpisodeAnnotationLabel,
    note: nullableString(row.note),
    anchorIntervalIds: Array.isArray(evidence.intervalIds)
      ? evidence.intervalIds.filter((value): value is string => typeof value === "string")
      : [],
    anchorStartedAt: nullableString(evidence.startedAt),
    anchorEndedAt: nullableString(evidence.endedAt),
  };
}

function annotationEvidence(annotation: EpisodeAnnotation): Record<string, unknown> {
  return {
    intervalIds: annotation.anchorIntervalIds,
    startedAt: annotation.anchorStartedAt,
    endedAt: annotation.anchorEndedAt,
  };
}

function bestEpisodeForAnnotation(
  annotation: EpisodeAnnotation,
  episodes: ResearchEpisode[],
  requireSharedInterval: boolean,
): ResearchEpisode | null {
  const anchorIds = new Set(annotation.anchorIntervalIds);
  const anchorStart = annotation.anchorStartedAt ? Date.parse(annotation.anchorStartedAt) : Number.NaN;
  const anchorEnd = annotation.anchorEndedAt ? Date.parse(annotation.anchorEndedAt) : Number.NaN;
  let best: { episode: ResearchEpisode; sharedIntervals: number; overlapMs: number } | null = null;
  for (const episode of episodes) {
    const sharedIntervals = episode.intervalIds.filter((intervalId) => anchorIds.has(intervalId)).length;
    const overlapMs = Number.isFinite(anchorStart) && Number.isFinite(anchorEnd)
      ? Math.max(0, Math.min(anchorEnd, Date.parse(episode.endedAt)) - Math.max(anchorStart, Date.parse(episode.startedAt)))
      : 0;
    if (sharedIntervals === 0 && (requireSharedInterval || overlapMs === 0)) continue;
    if (!best || sharedIntervals > best.sharedIntervals || (sharedIntervals === best.sharedIntervals && overlapMs > best.overlapMs)) {
      best = { episode, sharedIntervals, overlapMs };
    }
  }
  return best?.episode ?? null;
}

function applySchemaMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const columns = database.prepare("PRAGMA table_info(annotations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "evidence_json")) {
    database.exec("ALTER TABLE annotations ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '{}'");
  }
  const insert = database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)");
  const appliedAt = new Date().toISOString();
  insert.run(1, appliedAt);
  insert.run(2, appliedAt);
  insert.run(3, appliedAt);
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function uniqueById<T>(values: T[], id: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = id(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function historyRowKey(row: Record<string, unknown>): string {
  return `${String(row.source_browser)}\0${String(row.source_profile_id)}\0${String(row.source_url_id)}`;
}

function matchesHistoryProfile(row: Record<string, unknown>, options: HistoricalSummaryOptions): boolean {
  return (!options.browser || String(row.source_browser) === options.browser)
    && (!options.profileId || String(row.source_profile_id) === options.profileId);
}

function minIso(current: string | null, candidate: string | null): string | null {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate < current ? candidate : current;
}

function maxIso(current: string | null, candidate: string | null): string | null {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate > current ? candidate : current;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS activity_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  browser TEXT,
  browser_version TEXT,
  browser_profile_id TEXT,
  browser_session_id TEXT,
  window_id TEXT,
  tab_id TEXT,
  url TEXT,
  canonical_url TEXT,
  domain TEXT,
  title TEXT,
  navigation_type TEXT,
  referrer_url TEXT,
  idle_state TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS activity_events_occurred_idx ON activity_events(occurred_at);
CREATE INDEX IF NOT EXISTS activity_events_domain_idx ON activity_events(domain, occurred_at);

CREATE TABLE IF NOT EXISTS historical_urls (
  source_browser TEXT NOT NULL,
  source_profile_id TEXT NOT NULL,
  source_url_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT,
  domain TEXT,
  title TEXT,
  visit_count INTEGER,
  typed_count INTEGER,
  last_visit_at TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_browser, source_profile_id, source_url_id)
);
CREATE INDEX IF NOT EXISTS historical_urls_domain_idx ON historical_urls(domain, last_visit_at);

CREATE TABLE IF NOT EXISTS historical_visits (
  source_browser TEXT NOT NULL,
  source_profile_id TEXT NOT NULL,
  source_visit_id INTEGER NOT NULL,
  source_url_id INTEGER NOT NULL,
  visited_at TEXT NOT NULL,
  browser_elapsed_duration_ms INTEGER,
  transition_type TEXT,
  transition_raw INTEGER,
  referring_visit_id INTEGER,
  opener_visit_id INTEGER,
  visit_source TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_browser, source_profile_id, source_visit_id)
);
CREATE INDEX IF NOT EXISTS historical_visits_time_idx ON historical_visits(visited_at);

CREATE TABLE IF NOT EXISTS historical_search_terms (
  source_browser TEXT NOT NULL,
  source_profile_id TEXT NOT NULL,
  source_url_id INTEGER NOT NULL,
  term TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(source_browser, source_profile_id, source_url_id, term)
);

CREATE TABLE IF NOT EXISTS import_runs (
  import_id TEXT PRIMARY KEY,
  source_browser TEXT NOT NULL,
  source_profile_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  source_schema_version INTEGER,
  importer_version TEXT NOT NULL,
  fields_imported_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  urls_seen INTEGER NOT NULL,
  visits_seen INTEGER NOT NULL,
  urls_inserted INTEGER NOT NULL,
  visits_inserted INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS active_intervals (
  interval_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  browser_profile_id TEXT,
  browser_session_id TEXT,
  tab_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  url TEXT,
  canonical_url TEXT,
  domain TEXT,
  title TEXT,
  termination_reason TEXT NOT NULL,
  derivation_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS active_intervals_time_idx ON active_intervals(started_at, ended_at);

CREATE TABLE IF NOT EXISTS research_episodes (
  episode_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  topic_label TEXT,
  topic_confidence REAL,
  active_duration_ms INTEGER NOT NULL,
  idle_duration_ms INTEGER NOT NULL,
  unique_domains INTEGER NOT NULL,
  unique_urls INTEGER NOT NULL,
  tab_switch_count INTEGER NOT NULL,
  domain_switch_count INTEGER NOT NULL,
  idea_count INTEGER NOT NULL,
  output_count INTEGER NOT NULL,
  derivation_version INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS captured_ideas (
  idea_id TEXT PRIMARY KEY,
  captured_at TEXT NOT NULL,
  text TEXT NOT NULL,
  source_url TEXT,
  source_title TEXT,
  episode_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_via TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  annotation_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  episode_id TEXT,
  label TEXT,
  note TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS episode_corrections (
  correction_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  correction_type TEXT NOT NULL,
  anchor_interval_id TEXT NOT NULL,
  label TEXT
);
CREATE INDEX IF NOT EXISTS episode_corrections_anchor_idx ON episode_corrections(anchor_interval_id);

CREATE TABLE IF NOT EXISTS outputs (
  output_id TEXT PRIMARY KEY,
  output_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  title TEXT,
  reference TEXT,
  repository TEXT,
  source_connector TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS outputs_time_idx ON outputs(occurred_at);

CREATE TABLE IF NOT EXISTS output_episode_links (
  output_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  gap_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  association_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS output_episode_links_episode_idx ON output_episode_links(episode_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS derivation_runs (
  derivation_version INTEGER PRIMARY KEY,
  completed_at TEXT NOT NULL,
  input_event_count INTEGER NOT NULL,
  interval_count INTEGER NOT NULL,
  episode_count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;
