import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  chromiumTimeToIso,
  discoverBrowserProfiles,
  importBrowserHistory,
} from "../packages/browser-history-import/src/index.ts";
import { ActivityStore } from "../packages/database/src/index.ts";

describe("historical browser import", () => {
  it("converts Chromium's 1601 microsecond timestamp through the public importer interface", () => {
    expect(chromiumTimeToIso(13_327_417_845_000_000)).toBe("2023-05-01T12:30:45.000Z");
    expect(chromiumTimeToIso(0)).toBeNull();
  });

  it("discovers every Chrome and Brave profile instead of assuming Default", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "chromelens-profiles-"));
    const chromeRoot = join(homeDir, "Library/Application Support/Google/Chrome");
    const braveRoot = join(homeDir, "Library/Application Support/BraveSoftware/Brave-Browser");
    for (const profile of [join(chromeRoot, "Default"), join(chromeRoot, "Profile 2"), join(braveRoot, "Profile 1")]) {
      await mkdir(profile, { recursive: true });
      await writeFile(join(profile, "History"), "fixture");
    }

    const profiles = await discoverBrowserProfiles({ platform: "darwin", homeDir });

    expect(profiles.map(({ browser, profileName }) => `${browser}:${profileName}`)).toEqual([
      "brave:Profile 1",
      "chrome:Default",
      "chrome:Profile 2",
    ]);
  });

  it("imports a WAL-backed snapshot idempotently without querying the live database", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-import-"));
    const profilePath = join(root, "Default");
    await mkdir(profilePath, { recursive: true });
    const historyPath = join(profilePath, "History");
    const liveHistory = new DatabaseSync(historyPath);
    liveHistory.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER);
      CREATE TABLE visits(id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, from_visit INTEGER, transition INTEGER, visit_duration INTEGER, opener_visit INTEGER);
      CREATE TABLE visit_source(id INTEGER PRIMARY KEY, source INTEGER NOT NULL);
      CREATE TABLE keyword_search_terms(keyword_id INTEGER, url_id INTEGER, term TEXT);
      INSERT INTO urls VALUES(7, 'https://Example.com/read?utm_source=test', 'A useful page', 2, 1, 13327417845000000, 0);
      INSERT INTO visits VALUES(11, 7, 13327417845000000, 0, 1, 120000000, 0);
      INSERT INTO visit_source VALUES(11, 1);
      INSERT INTO keyword_search_terms VALUES(2, 7, 'event sourcing');
    `);

    const store = new ActivityStore(join(root, "chromelens.sqlite"));
    const profile = {
      browser: "chrome" as const,
      profileName: "Default",
      profileId: "chrome:Default",
      path: profilePath,
      historyPath,
    };

    const first = await importBrowserHistory({ profile, store });
    const second = await importBrowserHistory({ profile, store });

    expect(first).toMatchObject({ urlsSeen: 1, visitsSeen: 1, urlsInserted: 1, visitsInserted: 1 });
    expect(second).toMatchObject({ urlsSeen: 1, visitsSeen: 1, urlsInserted: 0, visitsInserted: 0 });
    expect(store.getHistoricalStats()).toEqual({ urls: 1, visits: 1, searchTerms: 1 });
    expect(first.fieldsImported.visits).toContain("visit_duration");
    liveHistory.close();
    store.close();
  });
});
