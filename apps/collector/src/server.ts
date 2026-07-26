import { timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { EPISODE_ANNOTATION_LABELS, isActivityEventType, type ActivityEvent, type EpisodeAnnotationLabel, type EpisodeCorrectionType } from "../../../packages/domain/src/index.ts";
import { type ActivityStore, type OverviewOptions } from "../../../packages/database/src/index.ts";
import { defaultPrivacySettings, serializePrivacySettings, type PrivacySettings } from "../../../packages/privacy/src/index.ts";
import type { CalendarRangeMode } from "../../../packages/calendar-analysis/src/index.ts";
import { discoverBrowserProfiles, importBrowserHistory } from "../../../packages/browser-history-import/src/index.ts";
import { GitOutputConnector } from "../../../packages/connectors/src/index.ts";
import type { AnalysisExportOptions } from "../../../packages/analysis-pack/src/index.ts";

export interface CollectorServerOptions {
  store: ActivityStore;
  token: string;
  host?: "127.0.0.1" | "::1";
  port?: number;
  privacySettings?: PrivacySettings;
  dashboardDir?: string;
}

export interface CollectorServer {
  start(): Promise<string>;
  stop(): Promise<void>;
}

export interface ConnectionDiagnostic {
  ok: true;
  service: "chromelens";
  schemaVersion: 1;
  authenticated: true;
  collectorTime: string;
  trackingEnabled: boolean;
  privacyConfigVersion: string;
  lastObservedEventAt: string | null;
  trackingControlEndpointReachable: true;
  privacyConfigEndpointReachable: true;
  queuedEvents: number;
  droppedEvents: number;
  privacyDrift: boolean;
}

export function createCollectorServer(options: CollectorServerOptions): CollectorServer {
  if (options.token.length < 8) throw new Error("Collector token must contain at least eight characters");
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 47_832;
  const privacySettings = options.store.getSetting("privacy", options.privacySettings ?? defaultPrivacySettings);
  const control = options.store.getSetting("trackingControl", { trackingEnabled: true, updatedAt: "1970-01-01T00:00:00.000Z" });
  let server: Server | null = null;

  return {
    async start() {
      if (server) throw new Error("Collector is already running");
      server = createServer((request, response) => {
        handleRequest(request, response, options.store, options.token, privacySettings, control, options.dashboardDir).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Unexpected collector error";
          json(response, 500, { error: "collector_error", message });
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, () => {
          server!.off("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo;
      const printableHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
      return `http://${printableHost}:${address.port}`;
    },
    async stop() {
      if (!server) return;
      const active = server;
      server = null;
      await new Promise<void>((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: ActivityStore,
  token: string,
  privacySettings: PrivacySettings,
  control: { trackingEnabled: boolean; updatedAt: string },
  dashboardDir?: string,
): Promise<void> {
  applyCors(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/api/health") {
    json(response, 200, { ok: true, service: "chromelens", schemaVersion: 1 });
    return;
  }
  if (url.pathname.startsWith("/api/") && !authorized(request, token)) {
    response.setHeader("www-authenticate", "Bearer");
    json(response, 401, { error: "unauthorized" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/control") {
    json(response, 200, control);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/diagnostics/connection") {
    const delivery = deliveryHealth(store);
    const diagnostic: ConnectionDiagnostic = {
      ok: true,
      service: "chromelens",
      schemaVersion: 1,
      authenticated: true,
      collectorTime: new Date().toISOString(),
      trackingEnabled: control.trackingEnabled,
      privacyConfigVersion: privacyVersion(privacySettings),
      lastObservedEventAt: store.getLastObservedEventAt(),
      trackingControlEndpointReachable: true,
      privacyConfigEndpointReachable: true,
      queuedEvents: delivery.queuedEvents,
      droppedEvents: delivery.droppedEvents,
      privacyDrift: delivery.privacyConfigVersion !== null && delivery.privacyConfigVersion !== privacyVersion(privacySettings),
    };
    json(response, 200, diagnostic);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/diagnostics/status") {
    const delivery = deliveryHealth(store);
    json(response, 200, {
      ok: true,
      service: "chromelens",
      schemaVersion: 1,
      collectorTime: new Date().toISOString(),
      trackingEnabled: control.trackingEnabled,
      privacyConfigVersion: privacyVersion(privacySettings),
      lastObservedEventAt: store.getLastObservedEventAt(),
      queuedEvents: delivery.queuedEvents,
      droppedEvents: delivery.droppedEvents,
      privacyDrift: delivery.privacyConfigVersion !== null && delivery.privacyConfigVersion !== privacyVersion(privacySettings),
    });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/diagnostics/delivery") {
    const body = await readJson(request);
    if (!isRecord(body) || !Number.isInteger(body.queuedEvents) || !Number.isInteger(body.droppedEvents)
      || Number(body.queuedEvents) < 0 || Number(body.queuedEvents) > 5_000
      || Number(body.droppedEvents) < 0 || Number(body.droppedEvents) > 5_000
      || (body.privacyConfigVersion !== undefined && body.privacyConfigVersion !== null && typeof body.privacyConfigVersion !== "string")) {
      json(response, 400, { error: "invalid_delivery_health", message: "queuedEvents and droppedEvents must be bounded integers" });
      return;
    }
    const health = { queuedEvents: Number(body.queuedEvents), droppedEvents: Number(body.droppedEvents), privacyConfigVersion: typeof body.privacyConfigVersion === "string" ? body.privacyConfigVersion : null, reportedAt: new Date().toISOString() };
    store.setSetting("deliveryHealth", health);
    json(response, 200, health);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/privacy/config") {
    json(response, 200, { config: privacySettings, version: privacyVersion(privacySettings) });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/control") {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.trackingEnabled !== "boolean") {
      json(response, 400, { error: "invalid_control" });
      return;
    }
    const updatedAt = typeof body.updatedAt === "string" && Number.isFinite(Date.parse(body.updatedAt))
      ? new Date(body.updatedAt).toISOString()
      : new Date().toISOString();
    if (Date.parse(updatedAt) >= Date.parse(control.updatedAt)) {
      control.trackingEnabled = body.trackingEnabled;
      control.updatedAt = updatedAt;
      store.setSetting("trackingControl", control);
      if (!control.trackingEnabled) store.rebuildDerivations(updatedAt);
    }
    json(response, 200, control);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/events") {
    const body = await readJson(request);
    const values = isRecord(body) && Array.isArray(body.events) ? body.events : null;
    if (!values || values.length > 500) {
      json(response, 400, { error: "invalid_batch", message: "events must be an array containing at most 500 items" });
      return;
    }
    let events: ActivityEvent[];
    try {
      events = values.map(parseActivityEvent);
    } catch (error) {
      json(response, 400, { error: "invalid_event", message: error instanceof Error ? error.message : "Invalid event" });
      return;
    }
    if (!control.trackingEnabled) {
      json(response, 202, { received: events.length, inserted: 0, duplicates: 0, excludedContexts: 0, droppedIncognito: 0, droppedWhilePaused: events.length });
      return;
    }
    const report = store.ingestEvents(events, privacySettings);
    if (report.inserted > 0) store.rebuildSessions(events.map((event) => event.browserSessionId));
    json(response, 202, report);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/settings") {
    json(response, 200, {
      privacy: store.getSetting("privacy", privacySettings),
      retention: store.getSetting("retention", { mode: "user-controlled", automaticCompaction: false }),
      connectors: { git: store.getSetting("gitConnector", { repositoryPath: "", associationWindowMinutes: 30 }) },
      annotationLabels: EPISODE_ANNOTATION_LABELS,
      llm: {
        enabled: false,
        available: false,
        analysisExportAvailable: true,
        message: "No model client is included. Preview and export a deliberately selected local analysis pack for an LLM you choose.",
      },
    });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJson(request);
    if (!isRecord(body) || !isRecord(body.privacy)) {
      json(response, 400, { error: "invalid_settings" });
      return;
    }
    const updated = mergePrivacySettings(privacySettings, body.privacy);
    Object.assign(privacySettings, updated);
    store.setSetting("privacy", updated);
    json(response, 200, { privacy: updated });
    return;
  }
  if (request.method === "PUT" && url.pathname === "/api/privacy/config") {
    const body = await readJson(request);
    if (!isRecord(body) || !isRecord(body.config)) {
      json(response, 400, { error: "invalid_privacy_config", message: "config must be an object" });
      return;
    }
    const updated = mergePrivacySettings(privacySettings, body.config);
    Object.assign(privacySettings, updated);
    store.setSetting("privacy", updated);
    json(response, 200, { config: updated, version: privacyVersion(updated) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/export/preview") {
    try {
      const artifact = store.createAnalysisExport(parseAnalysisExportOptions(url));
      json(response, 200, artifact);
    } catch (error) {
      json(response, 400, { error: "invalid_analysis_export", message: error instanceof Error ? error.message : "Invalid analysis export" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/export") {
    const format = url.searchParams.get("format") ?? "json";
    if (format === "json") {
      response.setHeader("content-disposition", `attachment; filename="chromelens-export-${new Date().toISOString().slice(0, 10)}.json"`);
      json(response, 200, store.exportData());
      return;
    }
    try {
      const artifact = store.createAnalysisExport(parseAnalysisExportOptions(url));
      response.setHeader("content-disposition", `attachment; filename="${artifact.filename}"`);
      text(response, 200, artifact.content, artifact.mediaType);
    } catch (error) {
      json(response, 400, { error: "invalid_analysis_export", message: error instanceof Error ? error.message : "Invalid analysis export" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/summary/daily") {
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    const timeZone = url.searchParams.get("timezone") ?? "UTC";
    try {
      json(response, 200, store.getDailySummary(date, timeZone));
    } catch (error) {
      json(response, 400, { error: "invalid_date", message: error instanceof Error ? error.message : "Invalid date" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/insights") {
    const from = url.searchParams.get("from") ?? new Date().toISOString().slice(0, 10);
    const days = Number(url.searchParams.get("days") ?? 7);
    const timeZone = url.searchParams.get("timezone") ?? "UTC";
    const to = url.searchParams.get("to") ?? undefined;
    try {
      const mode = parseRangeMode(url.searchParams.get("mode"));
      json(response, 200, store.getInsights(from, days, timeZone, { ...(mode ? { mode } : {}), ...(to ? { to } : {}), ...overviewHealthOptions(store, privacySettings) }));
    } catch (error) {
      json(response, 400, { error: "invalid_insights", message: error instanceof Error ? error.message : "Invalid insight range" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/search") {
    const query = url.searchParams.get("q") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const timeZone = url.searchParams.get("timezone") ?? "UTC";
    if (query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      json(response, 400, { error: "invalid_search", message: "q must be at most 200 characters and limit must be 1-100" });
      return;
    }
    try { json(response, 200, { query, timeZone, results: store.search(query, limit, timeZone, privacySettings) }); }
    catch (error) { json(response, 400, { error: "invalid_search", message: error instanceof Error ? error.message : "Invalid search" }); }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/patterns") {
    const from = url.searchParams.get("from") ?? new Date().toISOString().slice(0, 10);
    const days = Number(url.searchParams.get("days") ?? 7);
    const timeZone = url.searchParams.get("timezone") ?? "UTC";
    const to = url.searchParams.get("to") ?? undefined;
    try {
      const mode = parseRangeMode(url.searchParams.get("mode"));
      json(response, 200, store.getPatterns(from, days, timeZone, { ...(mode ? { mode } : {}), ...(to ? { to } : {}), ...overviewHealthOptions(store, privacySettings) }));
    } catch (error) {
      json(response, 400, { error: "invalid_patterns", message: error instanceof Error ? error.message : "Invalid patterns range" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/overview") {
    const from = url.searchParams.get("from") ?? new Date().toISOString().slice(0, 10);
    const days = Number(url.searchParams.get("days") ?? 7);
    const timeZone = url.searchParams.get("timezone") ?? "UTC";
    const to = url.searchParams.get("to") ?? undefined;
    try {
      const mode = parseRangeMode(url.searchParams.get("mode"));
      json(response, 200, store.getOverview(from, days, timeZone, { ...(mode ? { mode } : {}), ...(to ? { to } : {}), ...overviewHealthOptions(store, privacySettings) }));
    } catch (error) {
      json(response, 400, { error: "invalid_overview", message: error instanceof Error ? error.message : "Invalid overview range" });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/summary/range") {
    const from = url.searchParams.get("from") ?? new Date().toISOString().slice(0, 10);
    const days = Number(url.searchParams.get("days") ?? 7);
    const timeZone = url.searchParams.get("timezone") ?? "UTC";
    const to = url.searchParams.get("to") ?? undefined;
    try {
      const mode = parseRangeMode(url.searchParams.get("mode"));
      json(response, 200, store.getRangeSummary(from, days, timeZone, mode ? { mode, ...(to ? { to } : {}) } : {}));
    }
    catch (error) { json(response, 400, { error: "invalid_range", message: error instanceof Error ? error.message : "Invalid range" }); }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/history/summary") {
    const browser = url.searchParams.get("browser") || undefined;
    const profileId = url.searchParams.get("profileId") || undefined;
    if (browser && browser !== "chrome" && browser !== "brave") {
      json(response, 400, { error: "invalid_history_filter", message: "browser must be chrome or brave" });
      return;
    }
    const historyOptions = { privacy: privacySettings, ...(browser ? { browser } : {}), ...(profileId ? { profileId } : {}) };
    try { json(response, 200, store.getHistoricalSummary(url.searchParams.get("timezone") ?? "UTC", historyOptions)); }
    catch (error) { json(response, 400, { error: "invalid_timezone", message: error instanceof Error ? error.message : "Invalid time zone" }); }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/profiles") {
    const profiles = await discoverBrowserProfiles({ homeDir: homedir() });
    json(response, 200, { profiles });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/import") {
    const body = await readJson(request);
    const profileId = isRecord(body) && typeof body.profileId === "string" ? body.profileId : "";
    const profiles = await discoverBrowserProfiles({ homeDir: homedir() });
    const profile = profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) {
      json(response, 400, { error: "unknown_profile", message: "Select a discovered Chrome or Brave profile" });
      return;
    }
    const report = await importBrowserHistory({ profile, store });
    json(response, 200, report);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/connectors/git") {
    const body = await readJson(request);
    if (!isRecord(body)) {
      json(response, 400, { error: "invalid_connector_request" });
      return;
    }
    try {
      const repositoryPath = requiredString(body.repositoryPath, "repositoryPath", 4_096);
      const from = requiredString(body.from, "from", 100);
      const to = requiredString(body.to, "to", 100);
      const associationWindowMinutes = body.associationWindowMinutes === undefined ? 30 : Number(body.associationWindowMinutes);
      if (!Number.isFinite(associationWindowMinutes) || associationWindowMinutes < 0 || associationWindowMinutes > 1_440) {
        throw new Error("associationWindowMinutes must be between zero and 1440");
      }
      const outputs = await new GitOutputConnector(repositoryPath).collect({ from, to });
      const imported = store.importOutputs(outputs);
      const rebuilt = store.rebuildDerivations(undefined, { afterEpisodeMs: associationWindowMinutes * 60_000 });
      store.setSetting("gitConnector", { repositoryPath, associationWindowMinutes });
      json(response, 200, { collected: outputs.length, ...imported, ...rebuilt });
    } catch (error) {
      json(response, 400, { error: "git_collection_failed", message: error instanceof Error ? error.message : "Could not collect Git outputs" });
    }
    return;
  }
  const annotationMatch = /^\/api\/episodes\/([^/]+)\/annotations$/.exec(url.pathname);
  if (request.method === "POST" && annotationMatch) {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.label !== "string") {
      json(response, 400, { error: "invalid_annotation" });
      return;
    }
    try {
      const annotation = store.addAnnotation({
        episodeId: decodeURIComponent(annotationMatch[1]!),
        label: body.label as EpisodeAnnotationLabel,
        note: optionalString(body.note, 10_000),
      });
      json(response, 201, annotation);
    } catch (error) {
      json(response, 400, { error: "annotation_failed", message: error instanceof Error ? error.message : "Could not save annotation" });
    }
    return;
  }
  const correctionMatch = /^\/api\/episodes\/([^/]+)\/corrections$/.exec(url.pathname);
  if (request.method === "POST" && correctionMatch) {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.correctionType !== "string") {
      json(response, 400, { error: "invalid_episode_correction" });
      return;
    }
    try {
      const correction = store.addEpisodeCorrection({
        episodeId: decodeURIComponent(correctionMatch[1]!),
        correctionType: body.correctionType as EpisodeCorrectionType,
        ...(typeof body.label === "string" ? { label: body.label } : {}),
        ...(typeof body.beforeIntervalId === "string" ? { beforeIntervalId: body.beforeIntervalId } : {}),
      });
      json(response, 201, correction);
    } catch (error) {
      json(response, 400, { error: "episode_correction_failed", message: error instanceof Error ? error.message : "Could not correct episode" });
    }
    return;
  }
  const correctionDeleteMatch = /^\/api\/episode-corrections\/([^/]+)$/.exec(url.pathname);
  if (request.method === "DELETE" && correctionDeleteMatch) {
    const removed = store.removeEpisodeCorrection(decodeURIComponent(correctionDeleteMatch[1]!));
    json(response, removed ? 200 : 404, removed ? { removed: true } : { error: "episode_correction_not_found" });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/rebuild") {
    json(response, 200, store.rebuildDerivations());
    return;
  }
  if (request.method === "DELETE" && url.pathname === "/api/data") {
    const body = await readJson(request);
    if (!isRecord(body)) {
      json(response, 400, { error: "invalid_delete_filter" });
      return;
    }
    try {
      json(response, 200, store.deleteData({
        ...(typeof body.domain === "string" ? { domain: body.domain } : {}),
        ...(typeof body.url === "string" ? { url: body.url } : {}),
        ...(typeof body.from === "string" ? { from: body.from } : {}),
        ...(typeof body.to === "string" ? { to: body.to } : {}),
        ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
        ...(typeof body.profileId === "string" ? { profileId: body.profileId } : {}),
      }));
    } catch (error) {
      json(response, 400, { error: "delete_failed", message: error instanceof Error ? error.message : "Invalid deletion filter" });
    }
    return;
  }
  if (request.method === "GET" && !url.pathname.startsWith("/api/") && dashboardDir) {
    await serveDashboard(url.pathname, dashboardDir, response);
    return;
  }
  json(response, 404, { error: "not_found" });
}

function parseActivityEvent(value: unknown): ActivityEvent {
  if (!isRecord(value)) throw new Error("Event must be an object");
  if (value.schemaVersion !== 1) throw new Error("Unsupported event schema version");
  if (!isActivityEventType(value.eventType)) throw new Error("Unknown event type");
  const occurredAt = requiredString(value.occurredAt, "occurredAt");
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error("occurredAt must be an ISO timestamp");
  const browser = value.browser === null || value.browser === undefined
    ? null
    : value.browser === "chrome" || value.browser === "brave" || value.browser === "chromium"
      ? value.browser
      : (() => { throw new Error("Unsupported browser"); })();
  return {
    eventId: requiredString(value.eventId, "eventId", 200),
    schemaVersion: 1,
    eventType: value.eventType,
    occurredAt,
    deviceId: requiredString(value.deviceId, "deviceId", 200),
    browser,
    browserVersion: optionalString(value.browserVersion),
    browserProfileId: optionalString(value.browserProfileId),
    browserSessionId: requiredString(value.browserSessionId, "browserSessionId", 200),
    windowId: optionalString(value.windowId),
    tabId: optionalString(value.tabId),
    url: optionalString(value.url, 20_000),
    canonicalUrl: optionalString(value.canonicalUrl, 20_000),
    domain: optionalString(value.domain, 500),
    title: optionalString(value.title, 10_000),
    navigationType: optionalString(value.navigationType, 200),
    referrerUrl: optionalString(value.referrerUrl, 20_000),
    idleState: value.idleState === "active" || value.idleState === "idle" || value.idleState === "locked" ? value.idleState : null,
    incognito: value.incognito === true,
    metadata: isRecord(value.metadata) ? value.metadata : {},
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2 * 1024 * 1024) throw new Error("Request body exceeds 2 MiB");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice(7));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin && (origin.startsWith("chrome-extension://") || /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(origin))) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  response.setHeader("access-control-allow-headers", "authorization, content-type");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function text(response: ServerResponse, status: number, body: string, contentType: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

function parseAnalysisExportOptions(url: URL): AnalysisExportOptions {
  const requestedFormat = url.searchParams.get("format");
  const format = requestedFormat === "llm-markdown"
    ? "markdown"
    : requestedFormat === "llm-jsonl"
      ? "jsonl"
      : (() => { throw new Error("Use format=llm-markdown or format=llm-jsonl"); })();
  const privacy = url.searchParams.get("privacy") ?? "aggregate";
  if (privacy !== "aggregate" && privacy !== "contextual" && privacy !== "detailed") {
    throw new Error("privacy must be aggregate, contextual, or detailed");
  }
  const maxTokens = Number(url.searchParams.get("maxTokens") ?? 50_000);
  const question = url.searchParams.get("question") ?? undefined;
  if (question && question.length > 1_000) throw new Error("question must be at most 1000 characters");
  return {
    from: requiredQueryParameter(url, "from"),
    to: requiredQueryParameter(url, "to"),
    timeZone: requiredQueryParameter(url, "timezone"),
    privacy,
    format,
    maxTokens,
    ...(question ? { question } : {}),
  };
}

function requiredQueryParameter(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string, maximum = 1_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function privacyVersion(settings: PrivacySettings): string {
  return `privacy_v1_${createHash("sha256").update(serializePrivacySettings(settings)).digest("hex").slice(0, 16)}`;
}

function deliveryHealth(store: ActivityStore): { queuedEvents: number; droppedEvents: number; privacyConfigVersion: string | null; reportedAt: string | null } {
  const value = store.getSetting("deliveryHealth", { queuedEvents: 0, droppedEvents: 0, privacyConfigVersion: null as string | null, reportedAt: null as string | null });
  return {
    queuedEvents: Number.isInteger(value.queuedEvents) ? Math.max(0, Math.min(5_000, value.queuedEvents)) : 0,
    droppedEvents: Number.isInteger(value.droppedEvents) ? Math.max(0, Math.min(5_000, value.droppedEvents)) : 0,
    privacyConfigVersion: typeof value.privacyConfigVersion === "string" ? value.privacyConfigVersion : null,
    reportedAt: typeof value.reportedAt === "string" ? value.reportedAt : null,
  };
}

function overviewHealthOptions(store: ActivityStore, settings: PrivacySettings): OverviewOptions {
  const delivery = deliveryHealth(store);
  return {
    queuedEvents: delivery.queuedEvents,
    droppedEvents: delivery.droppedEvents,
    ...(delivery.reportedAt ? { collectorRecentlyObserved: Date.now() - Date.parse(delivery.reportedAt) < 15 * 60_000 } : {}),
    ...(delivery.privacyConfigVersion ? { privacyDrift: delivery.privacyConfigVersion !== privacyVersion(settings) } : {}),
  };
}

function parseRangeMode(value: string | null): CalendarRangeMode | undefined {
  if (!value) return undefined;
  if (value === "calendar_week" || value === "calendar_month" || value === "rolling_7" || value === "rolling_30" || value === "custom") return value;
  throw new Error("Unsupported range mode");
}

function optionalString(value: unknown, maximum = 1_000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maximum) throw new Error("Invalid string field");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergePrivacySettings(current: PrivacySettings, update: Record<string, unknown>): PrivacySettings {
  const domains = update.excludedDomains === undefined ? current.excludedDomains : stringArray(update.excludedDomains, "excludedDomains");
  const patterns = update.excludedUrlPatterns === undefined ? current.excludedUrlPatterns : stringArray(update.excludedUrlPatterns, "excludedUrlPatterns");
  const mode = update.redactQueryValues === undefined ? current.redactQueryValues : update.redactQueryValues;
  if (mode !== "all" && mode !== "sensitive" && mode !== "none") throw new Error("Invalid query redaction mode");
  const boolean = (key: keyof PrivacySettings, fallback: boolean): boolean => {
    const value = update[key];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new Error(`${key} must be boolean`);
    return value;
  };
  return {
    excludedDomains: domains.map((domain) => domain.toLowerCase()),
    excludedUrlPatterns: patterns,
    redactQueryValues: mode,
    removeFragments: boolean("removeFragments", current.removeFragments),
    redactLocalhostPaths: boolean("redactLocalhostPaths", current.redactLocalhostPaths),
    dropTrackingParameters: boolean("dropTrackingParameters", current.dropTrackingParameters),
    allowIncognito: boolean("allowIncognito", current.allowIncognito),
  };
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 500 || value.some((item) => typeof item !== "string" || item.length > 2_000)) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

async function serveDashboard(pathname: string, dashboardDir: string, response: ServerResponse): Promise<void> {
  const files: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css" };
  const file = files[pathname];
  if (!file) {
    json(response, 404, { error: "not_found" });
    return;
  }
  try {
    const content = await readFile(join(dashboardDir, file));
    const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(content);
  } catch {
    json(response, 404, { error: "dashboard_not_built", message: "Run npm run build" });
  }
}
