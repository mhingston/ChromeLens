const WINDOWS_TO_UNIX_EPOCH_MICROSECONDS = 11_644_473_600_000_000;

import { access, copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  HistoricalSearchTermInput,
  HistoricalUrlInput,
  HistoricalVisitInput,
  HistoryImportBatch,
} from "../../database/src/index.ts";

export type BrowserKind = "chrome" | "brave";

export interface BrowserProfile {
  browser: BrowserKind;
  profileName: string;
  profileId: string;
  path: string;
  historyPath: string;
}

export interface ProfileDiscoveryOptions {
  platform?: NodeJS.Platform;
  homeDir: string;
  localAppData?: string;
}

export interface HistoryImportSink {
  importHistoryBatch(batch: HistoryImportBatch): {
    urlsInserted: number;
    visitsInserted: number;
    searchTermsInserted: number;
  };
}

export interface HistoryImportReport {
  importId: string;
  browser: BrowserKind;
  profileId: string;
  sourceSchemaVersion: number | null;
  urlsSeen: number;
  visitsSeen: number;
  searchTermsSeen: number;
  urlsInserted: number;
  visitsInserted: number;
  searchTermsInserted: number;
  fieldsImported: { urls: string[]; visits: string[]; searchTerms: string[] };
  snapshotFiles: string[];
  historicalDurationCaveat: string;
}

export function chromiumTimeToIso(value: number | bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const microseconds = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  if (microseconds <= 0n) return null;

  const unixMilliseconds = (microseconds - BigInt(WINDOWS_TO_UNIX_EPOCH_MICROSECONDS)) / 1_000n;
  const date = new Date(Number(unixMilliseconds));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function discoverBrowserProfiles(options: ProfileDiscoveryOptions): Promise<BrowserProfile[]> {
  const platform = options.platform ?? process.platform;
  const roots: Array<{ browser: BrowserKind; path: string }> = [];

  if (platform === "darwin") {
    roots.push(
      { browser: "chrome", path: join(options.homeDir, "Library/Application Support/Google/Chrome") },
      { browser: "brave", path: join(options.homeDir, "Library/Application Support/BraveSoftware/Brave-Browser") },
    );
  } else if (platform === "win32") {
    const localAppData = options.localAppData ?? join(options.homeDir, "AppData/Local");
    roots.push(
      { browser: "chrome", path: join(localAppData, "Google/Chrome/User Data") },
      { browser: "brave", path: join(localAppData, "BraveSoftware/Brave-Browser/User Data") },
    );
  } else {
    roots.push(
      { browser: "chrome", path: join(options.homeDir, ".config/google-chrome") },
      { browser: "brave", path: join(options.homeDir, ".config/BraveSoftware/Brave-Browser") },
    );
  }

  const profiles: BrowserProfile[] = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !isProfileDirectory(entry.name)) continue;
      const historyPath = join(root.path, entry.name, "History");
      try {
        await access(historyPath, constants.R_OK);
      } catch {
        continue;
      }
      profiles.push({
        browser: root.browser,
        profileName: entry.name,
        profileId: `${root.browser}:${entry.name}`,
        path: join(root.path, entry.name),
        historyPath,
      });
    }
  }

  return profiles.sort((left, right) =>
    left.browser.localeCompare(right.browser) || left.profileName.localeCompare(right.profileName),
  );
}

function isProfileDirectory(name: string): boolean {
  return name === "Default" || name === "Guest Profile" || /^Profile \d+$/.test(name);
}

export async function importBrowserHistory(options: {
  profile: BrowserProfile;
  store: HistoryImportSink;
  now?: () => Date;
}): Promise<HistoryImportReport> {
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const snapshot = await createHistorySnapshot(options.profile.historyPath);
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(snapshot.historyPath, { readOnly: true });
    const tables = getTables(source);
    if (!tables.has("urls") || !tables.has("visits")) {
      throw new Error("Unsupported Chromium History schema: required urls and visits tables were not found");
    }

    const urlColumns = getColumns(source, "urls");
    const visitColumns = getColumns(source, "visits");
    const searchColumns = tables.has("keyword_search_terms")
      ? getColumns(source, "keyword_search_terms")
      : new Set<string>();
    requireColumns("urls", urlColumns, ["id", "url"]);
    requireColumns("visits", visitColumns, ["id", "url", "visit_time"]);

    const importedAt = (options.now?.() ?? new Date()).toISOString();
    const urlStatement = source.prepare(`SELECT ${selectColumns(urlColumns, [
      "id", "url", "title", "visit_count", "typed_count", "last_visit_time",
    ])} FROM urls`);
    urlStatement.setReadBigInts(true);
    const urlRows = urlStatement.all() as Array<Record<string, unknown>>;
    const visitSource = readVisitSources(source, tables, visitColumns);
    const visitStatement = source.prepare(`SELECT ${selectColumns(visitColumns, [
      "id", "url", "visit_time", "from_visit", "transition", "visit_duration", "opener_visit",
    ])} FROM visits`);
    visitStatement.setReadBigInts(true);
    const visitRows = visitStatement.all() as Array<Record<string, unknown>>;

    const urls: HistoricalUrlInput[] = urlRows.flatMap((row) => {
      const rawUrl = asString(row.url);
      const sourceUrlId = asNumber(row.id);
      if (!rawUrl || sourceUrlId === null) return [];
      const normalised = normaliseUrl(rawUrl);
      return [{
        sourceBrowser: options.profile.browser,
        sourceProfileId: options.profile.profileId,
        sourceUrlId,
        url: rawUrl,
        canonicalUrl: normalised.canonicalUrl,
        domain: normalised.domain,
        title: asString(row.title),
        visitCount: asNumber(row.visit_count),
        typedCount: asNumber(row.typed_count),
        lastVisitAt: chromiumTimeToIso(asNumeric(row.last_visit_time)),
        importedAt,
      }];
    });

    const visits: HistoricalVisitInput[] = visitRows.flatMap((row) => {
      const sourceVisitId = asNumber(row.id);
      const sourceUrlId = asNumber(row.url);
      const visitedAt = chromiumTimeToIso(asNumeric(row.visit_time));
      if (sourceVisitId === null || sourceUrlId === null || !visitedAt) return [];
      const durationMicros = asNumeric(row.visit_duration);
      const transitionRaw = asNumber(row.transition);
      return [{
        sourceBrowser: options.profile.browser,
        sourceProfileId: options.profile.profileId,
        sourceVisitId,
        sourceUrlId,
        visitedAt,
        browserElapsedDurationMs: durationMicros === null ? null : Math.max(0, Math.trunc(Number(durationMicros) / 1_000)),
        transitionType: decodeTransition(transitionRaw),
        transitionRaw,
        referringVisitId: nonZero(asNumber(row.from_visit)),
        openerVisitId: nonZero(asNumber(row.opener_visit)),
        visitSource: visitSource.get(sourceVisitId) ?? "browsed",
        importedAt,
      }];
    });

    const searchTerms: HistoricalSearchTermInput[] = readSearchTerms(
      source,
      searchColumns,
      options.profile,
      importedAt,
    );
    const fieldsImported = {
      urls: [...urlColumns].sort(),
      visits: [...visitColumns].sort(),
      searchTerms: [...searchColumns].sort(),
    };
    const importId = randomUUID();
    const sourceSchemaVersion = readSchemaVersion(source, tables);
    const inserted = options.store.importHistoryBatch({
      urls,
      visits,
      searchTerms,
      run: {
        importId,
        sourceBrowser: options.profile.browser,
        sourceProfileId: options.profile.profileId,
        sourcePath: options.profile.historyPath,
        sourceSchemaVersion,
        importerVersion: "1.0.0",
        fieldsImportedJson: JSON.stringify(fieldsImported),
        startedAt,
        completedAt: importedAt,
      },
    });

    return {
      importId,
      browser: options.profile.browser,
      profileId: options.profile.profileId,
      sourceSchemaVersion,
      urlsSeen: urls.length,
      visitsSeen: visits.length,
      searchTermsSeen: searchTerms.length,
      ...inserted,
      fieldsImported,
      snapshotFiles: snapshot.files,
      historicalDurationCaveat: "Browser-recorded elapsed duration may include inactivity and is not active attention.",
    };
  } finally {
    source?.close();
    await rm(snapshot.directory, { recursive: true, force: true });
  }
}

async function createHistorySnapshot(historyPath: string): Promise<{ directory: string; historyPath: string; files: string[] }> {
  await access(historyPath, constants.R_OK);
  const directory = await mkdtemp(join(tmpdir(), "chromelens-history-snapshot-"));
  const copiedHistory = join(directory, "History");
  const files: string[] = [];
  for (const suffix of ["", "-wal", "-shm"] as const) {
    try {
      await copyFile(`${historyPath}${suffix}`, `${copiedHistory}${suffix}`);
      files.push(`History${suffix}`);
    } catch (error) {
      if (suffix === "") {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
  }
  return { directory, historyPath: copiedHistory, files };
}

function getTables(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function getColumns(database: DatabaseSync, table: string): Set<string> {
  if (!/^[a-z_]+$/i.test(table)) throw new Error("Invalid table name");
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function requireColumns(table: string, actual: Set<string>, required: string[]): void {
  const missing = required.filter((column) => !actual.has(column));
  if (missing.length) throw new Error(`Unsupported ${table} schema; missing columns: ${missing.join(", ")}`);
}

function selectColumns(actual: Set<string>, requested: string[]): string {
  return requested.map((column) => actual.has(column) ? column : `NULL AS ${column}`).join(", ");
}

function readVisitSources(database: DatabaseSync, tables: Set<string>, visitColumns: Set<string>): Map<number, string> {
  if (!tables.has("visit_source")) return new Map();
  const sourceColumns = getColumns(database, "visit_source");
  if (!sourceColumns.has("id") || !sourceColumns.has("source")) return new Map();
  const rows = database.prepare("SELECT id, source FROM visit_source").all() as Array<{ id: number; source: number }>;
  const labels = ["synced", "browsed", "extension", "firefox_imported", "ie_imported", "safari_imported", "actor", "os_migration_imported"];
  return new Map(rows.map((row) => [Number(row.id), labels[Number(row.source)] ?? `source_${row.source}`]));
}

function readSearchTerms(
  database: DatabaseSync,
  columns: Set<string>,
  profile: BrowserProfile,
  importedAt: string,
): HistoricalSearchTermInput[] {
  if (!columns.has("url_id") || !columns.has("term")) return [];
  const rows = database.prepare("SELECT url_id, term FROM keyword_search_terms").all() as Array<{ url_id: number; term: string }>;
  return rows.flatMap((row) => {
    const sourceUrlId = asNumber(row.url_id);
    const term = asString(row.term);
    return sourceUrlId === null || !term ? [] : [{
      sourceBrowser: profile.browser,
      sourceProfileId: profile.profileId,
      sourceUrlId,
      term,
      importedAt,
    }];
  });
}

function readSchemaVersion(database: DatabaseSync, tables: Set<string>): number | null {
  if (!tables.has("meta")) return null;
  const columns = getColumns(database, "meta");
  if (!columns.has("key") || !columns.has("value")) return null;
  const row = database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: number } | undefined;
  return row?.value === undefined ? null : Number(row.value);
}

function normaliseUrl(rawUrl: string): { canonicalUrl: string | null; domain: string | null } {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return { canonicalUrl: parsed.toString(), domain: parsed.hostname || null };
  } catch {
    return { canonicalUrl: null, domain: null };
  }
}

function decodeTransition(value: number | null): string | null {
  if (value === null) return null;
  const labels = ["link", "typed", "auto_bookmark", "auto_subframe", "manual_subframe", "generated", "auto_toplevel", "form_submit", "reload", "keyword", "keyword_generated"];
  return labels[value & 0xff] ?? `transition_${value & 0xff}`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function asNumeric(value: unknown): number | bigint | null {
  return typeof value === "number" || typeof value === "bigint" ? value : null;
}

function nonZero(value: number | null): number | null {
  return value === null || value === 0 ? null : value;
}
