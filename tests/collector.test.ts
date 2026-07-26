import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent } from "../packages/domain/src/index.ts";
import { ActivityStore } from "../packages/database/src/index.ts";
import { createCollectorServer, type CollectorServer } from "../apps/collector/src/server.ts";
import { defaultPrivacySettings } from "../packages/privacy/src/index.ts";

const running: CollectorServer[] = [];
const run = promisify(execFile);
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

describe("loopback collector", () => {
  it("serves privacy-filtered historical evidence with profile filters and local-time counts", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-history-api-"));
    const store = new ActivityStore(join(root, "collector.sqlite"));
    store.importHistoryBatch({
      urls: [
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourceUrlId: 1, url: "https://example.com/research?token=raw-secret", canonicalUrl: "https://example.com/research?token=raw-secret", domain: "example.com", title: "Research page", visitCount: 2, typedCount: 1, lastVisitAt: "2026-07-19T00:30:00.000Z", importedAt: "2026-07-19T01:00:00.000Z" },
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Profile 2", sourceUrlId: 2, url: "https://other.example/notes", canonicalUrl: "https://other.example/notes", domain: "other.example", title: "Notes", visitCount: 1, typedCount: 0, lastVisitAt: "2026-07-19T02:30:00.000Z", importedAt: "2026-07-19T03:00:00.000Z" },
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourceUrlId: 3, url: "https://secret.example/account", canonicalUrl: "https://secret.example/account", domain: "secret.example", title: "Private account", visitCount: 4, typedCount: 2, lastVisitAt: "2026-07-19T03:30:00.000Z", importedAt: "2026-07-19T04:00:00.000Z" },
      ],
      visits: [
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourceVisitId: 1, sourceUrlId: 1, visitedAt: "2026-07-18T23:30:00.000Z", browserElapsedDurationMs: 1000, transitionType: "typed", transitionRaw: null, referringVisitId: null, openerVisitId: null, visitSource: "local", importedAt: "2026-07-19T01:00:00.000Z" },
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourceVisitId: 2, sourceUrlId: 1, visitedAt: "2026-07-19T00:30:00.000Z", browserElapsedDurationMs: 1000, transitionType: "link", transitionRaw: null, referringVisitId: null, openerVisitId: null, visitSource: "local", importedAt: "2026-07-19T01:00:00.000Z" },
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Profile 2", sourceVisitId: 3, sourceUrlId: 2, visitedAt: "2026-07-19T02:30:00.000Z", browserElapsedDurationMs: null, transitionType: "link", transitionRaw: null, referringVisitId: null, openerVisitId: null, visitSource: "local", importedAt: "2026-07-19T03:00:00.000Z" },
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourceVisitId: 4, sourceUrlId: 3, visitedAt: "2026-07-19T03:30:00.000Z", browserElapsedDurationMs: null, transitionType: "typed", transitionRaw: null, referringVisitId: null, openerVisitId: null, visitSource: "local", importedAt: "2026-07-19T04:00:00.000Z" },
      ],
      searchTerms: [
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourceUrlId: 1, term: "visible research", importedAt: "2026-07-19T01:00:00.000Z" },
        { sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourceUrlId: 3, term: "private query", importedAt: "2026-07-19T04:00:00.000Z" },
      ],
      run: { importId: "history-run", sourceBrowser: "chrome", sourceProfileId: "chrome:Default", sourcePath: "/not-returned", sourceSchemaVersion: 70, importerVersion: "test", fieldsImportedJson: "{\"searchTerms\":true}", startedAt: "2026-07-19T00:00:00.000Z", completedAt: "2026-07-19T04:00:00.000Z" },
    });
    const privacy = { ...defaultPrivacySettings, excludedDomains: [...defaultPrivacySettings.excludedDomains, "secret.example"] };
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0, privacySettings: privacy });
    running.push(server);
    const address = await server.start();
    const headers = { authorization: "Bearer test-secret" };
    const all = await fetch(`${address}/api/history/summary?timezone=Europe%2FLondon`, { headers });
    const filtered = await fetch(`${address}/api/history/summary?timezone=Europe%2FLondon&profileId=chrome%3AProfile%202`, { headers });
    const invalid = await fetch(`${address}/api/history/summary?browser=safari`, { headers });
    const body = await all.json() as Record<string, any>;
    const filteredBody = await filtered.json() as Record<string, any>;

    expect(all.status).toBe(200);
    expect(body.visits).toBe(3);
    expect(body.revisitedPages[0]).toMatchObject({ title: "Research page", typedCount: 1, browser: "chrome" });
    expect(body.revisitedPages[0].url).toContain("%5BREDACTED%5D");
    expect(body.searchTerms.map((term: Record<string, unknown>) => term.term)).toEqual(["visible research"]);
    expect(body.visitsByHour.find((entry: Record<string, number>) => entry.hour === 0)?.visits).toBe(1);
    expect(body.visitsByHour.find((entry: Record<string, number>) => entry.hour === 1)?.visits).toBe(1);
    expect(body.importRuns[0]).toMatchObject({ importerVersion: "test", schemaVersion: 70 });
    expect(filteredBody.visits).toBe(1);
    expect(filteredBody.profiles[0]).toMatchObject({ profileId: "chrome:Profile 2" });
    expect(invalid.status).toBe(400);
    store.close();
  });

  it("builds an authenticated overview with review items and a previous-period comparison", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-overview-"));
    const store = new ActivityStore(join(root, "collector.sqlite"));
    store.importOutputs([{
      outputId: "output-without-episode",
      outputType: "git_commit",
      occurredAt: "2026-07-18T11:00:00.000Z",
      title: "Unlinked local output",
      reference: "abc123",
      repository: "local-repo",
      sourceConnector: "git",
      metadata: {},
    }]);
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0 });
    running.push(server);
    const address = await server.start();
    const headers = { "content-type": "application/json", authorization: "Bearer test-secret" };
    const base = {
      schemaVersion: 1 as const, deviceId: "device", browser: "chrome" as const, browserVersion: null,
      browserProfileId: "chrome:Default", browserSessionId: "session", windowId: "session:1",
      tabId: null, url: null, canonicalUrl: null, domain: null, title: null, navigationType: null,
      referrerUrl: null, idleState: "active" as const, incognito: false, metadata: {},
    };
    const ingestion = await fetch(`${address}/api/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [
        { ...base, eventId: crypto.randomUUID(), eventType: "window_focused", occurredAt: "2026-07-18T09:00:00.000Z" },
        { ...base, eventId: crypto.randomUUID(), eventType: "tab_activated", occurredAt: "2026-07-18T09:00:00.000Z", tabId: "A", url: "https://example.com/", title: null },
        { ...base, eventId: crypto.randomUUID(), eventType: "idea_captured", occurredAt: "2026-07-18T09:05:00.000Z", metadata: { text: "Return to this source", tags: ["resume"] } },
        { ...base, eventId: crypto.randomUUID(), eventType: "window_blurred", occurredAt: "2026-07-18T09:10:00.000Z" },
      ] }),
    });
    const overview = await fetch(`${address}/api/overview?from=2026-07-18&to=2026-07-18&days=1&mode=custom&timezone=UTC`, { headers });
    const insights = await fetch(`${address}/api/insights?from=2026-07-18&to=2026-07-18&days=1&mode=custom&timezone=UTC`, { headers });
    const body = await overview.json() as {
      period: { from: string; to: string; days: number };
      previousSummary: { from: string; to: string };
      reviewItems: Array<{ kind: string; evidenceRefs: unknown[] }>;
      resumeCandidates: Array<{ episodeId: string }>;
    };
    const insightBody = await insights.json() as { period: { from: string; to: string }; insights: Array<{ kind: string; evidenceRefs: unknown[] }> };

    expect(ingestion.status).toBe(202);
    expect(overview.status).toBe(200);
    expect(insights.status).toBe(200);
    expect(insightBody.period).toMatchObject({ from: "2026-07-18", to: "2026-07-18" });
    expect(insightBody.insights.some((insight) => insight.kind === "review" && insight.evidenceRefs.length > 0)).toBe(true);
    expect(body.period).toMatchObject({ from: "2026-07-18", to: "2026-07-18", days: 1 });
    expect(body.previousSummary).toMatchObject({ from: "2026-07-17", to: "2026-07-17" });
    expect(body.reviewItems.map((item) => item.kind)).toEqual(["episode_label", "unlinked_output", "idea_without_output"]);
    expect(body.reviewItems.every((item) => item.evidenceRefs.length > 0)).toBe(true);
    expect(body.resumeCandidates).toHaveLength(1);
    store.close();
  });

  it("requires authentication for connection diagnostics and reports privacy version", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-diagnostics-"));
    const store = new ActivityStore(join(root, "collector.sqlite"));
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0 });
    running.push(server);
    const address = await server.start();

    const invalid = await fetch(`${address}/api/diagnostics/connection`, { headers: { authorization: "Bearer wrong-token" } });
    const valid = await fetch(`${address}/api/diagnostics/connection`, { headers: { authorization: "Bearer test-secret" } });
    const body = await valid.json() as Record<string, unknown>;

    expect(invalid.status).toBe(401);
    expect(valid.status).toBe(200);
    expect(body).toMatchObject({ ok: true, authenticated: true, schemaVersion: 1, trackingEnabled: true, trackingControlEndpointReachable: true });
    expect(body.privacyConfigVersion).toMatch(/^privacy_v1_[a-f0-9]{16}$/);
    store.close();
  });

  it("rejects unauthenticated ingestion and serves authenticated summaries on loopback", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-collector-"));
    const store = new ActivityStore(join(root, "collector.sqlite"));
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0 });
    running.push(server);
    const address = await server.start();
    const event: ActivityEvent = {
      eventId: crypto.randomUUID(), schemaVersion: 1, eventType: "browser_session_started",
      occurredAt: "2026-07-18T08:00:00.000Z", deviceId: "device", browser: "chrome",
      browserVersion: null, browserProfileId: "chrome:Default", browserSessionId: "session",
      windowId: null, tabId: null, url: null, canonicalUrl: null, domain: null, title: null,
      navigationType: null, referrerUrl: null, idleState: "active", incognito: false, metadata: {},
    };

    const unauthorized = await fetch(`${address}/api/events`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [event] }),
    });
    const accepted = await fetch(`${address}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      body: JSON.stringify({ events: [event] }),
    });
    const summary = await fetch(`${address}/api/summary/daily?date=2026-07-18`, {
      headers: { authorization: "Bearer test-secret" },
    });

    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(unauthorized.status).toBe(401);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ received: 1, inserted: 1 });
    expect(summary.status).toBe(200);
    store.close();
  });

  it("applies authenticated privacy settings before data can appear in export", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-controls-"));
    const store = new ActivityStore(join(root, "collector.sqlite"));
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0 });
    running.push(server);
    const address = await server.start();
    const headers = { "content-type": "application/json", authorization: "Bearer test-secret" };
    const settings = await fetch(`${address}/api/settings`, {
      method: "PUT", headers, body: JSON.stringify({ privacy: { excludedDomains: ["secret.example"] } }),
    });
    const base = {
      schemaVersion: 1 as const, occurredAt: "2026-07-18T08:00:00.000Z", deviceId: "device",
      browser: "chrome" as const, browserVersion: null, browserProfileId: "chrome:Default",
      browserSessionId: "session", windowId: "session:1", tabId: null, url: null, canonicalUrl: null,
      domain: null, title: null, navigationType: null, referrerUrl: null, idleState: "active" as const,
      incognito: false, metadata: {},
    };
    const events: ActivityEvent[] = [
      { ...base, eventId: crypto.randomUUID(), eventType: "window_focused" },
      { ...base, eventId: crypto.randomUUID(), eventType: "tab_activated", tabId: "session:A", url: "https://secret.example/account?token=raw-secret", title: "Sensitive account" },
      { ...base, eventId: crypto.randomUUID(), eventType: "window_blurred", occurredAt: "2026-07-18T08:05:00.000Z" },
    ];
    const ingestion = await fetch(`${address}/api/events`, { method: "POST", headers, body: JSON.stringify({ events }) });
    const exported = await fetch(`${address}/api/export?format=json`, { headers: { authorization: "Bearer test-secret" } });
    const exportText = await exported.text();

    expect(settings.status).toBe(200);
    expect(await ingestion.json()).toMatchObject({ excludedContexts: 1 });
    expect(exported.status).toBe(200);
    expect(exportText).not.toContain("secret.example");
    expect(exportText).not.toContain("raw-secret");
    store.close();
  });

  it("collects Git outputs and creates reviewable episode annotations through authenticated APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-api-output-"));
    const repositoryPath = join(root, "research-repo");
    await run("git", ["init", "--quiet", repositoryPath]);
    await writeFile(join(repositoryPath, "result.md"), "result\n");
    await run("git", ["add", "result.md"], { cwd: repositoryPath });
    await run("git", ["commit", "--quiet", "-m", "Turn research into an output"], {
      cwd: repositoryPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "ChromeLens Test", GIT_AUTHOR_EMAIL: "test@localhost",
        GIT_COMMITTER_NAME: "ChromeLens Test", GIT_COMMITTER_EMAIL: "test@localhost",
        GIT_AUTHOR_DATE: "2026-07-18T10:14:00Z", GIT_COMMITTER_DATE: "2026-07-18T10:14:00Z",
      },
    });
    const store = new ActivityStore(join(root, "collector.sqlite"));
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0 });
    running.push(server);
    const address = await server.start();
    const headers = { "content-type": "application/json", authorization: "Bearer test-secret" };
    const base = {
      schemaVersion: 1 as const, deviceId: "device", browser: "chrome" as const, browserVersion: null,
      browserProfileId: "chrome:Default", browserSessionId: "session", windowId: "session:1",
      tabId: null, url: null, canonicalUrl: null, domain: null, title: null, navigationType: null,
      referrerUrl: null, idleState: "active" as const, incognito: false, metadata: {},
    };
    await fetch(`${address}/api/events`, { method: "POST", headers, body: JSON.stringify({ events: [
      { ...base, eventId: crypto.randomUUID(), eventType: "window_focused", occurredAt: "2026-07-18T10:00:00.000Z" },
      { ...base, eventId: crypto.randomUUID(), eventType: "tab_activated", occurredAt: "2026-07-18T10:00:00.000Z", tabId: "A", url: "https://docs.example/research", title: "Browser evidence" },
      { ...base, eventId: crypto.randomUUID(), eventType: "window_blurred", occurredAt: "2026-07-18T10:10:00.000Z" },
    ] }) });
    const collected = await fetch(`${address}/api/connectors/git`, { method: "POST", headers, body: JSON.stringify({
      repositoryPath, from: "2026-07-18T10:00:00.000Z", to: "2026-07-18T10:30:00.000Z", associationWindowMinutes: 5,
    }) });
    const firstSummary = await (await fetch(`${address}/api/summary/daily?date=2026-07-18`, { headers })).json() as { episodes: Array<{ episodeId: string }>; outputs: unknown[] };
    const annotated = await fetch(`${address}/api/episodes/${firstSummary.episodes[0]!.episodeId}/annotations`, {
      method: "POST", headers, body: JSON.stringify({ label: "learning", note: "The sources informed a concrete commit" }),
    });
    const corrected = await fetch(`${address}/api/episodes/${firstSummary.episodes[0]!.episodeId}/corrections`, {
      method: "POST", headers, body: JSON.stringify({ correctionType: "rename", label: "Corrected browser evidence" }),
    });
    const correction = await corrected.json() as { correctionId: string };
    const finalSummary = await (await fetch(`${address}/api/summary/daily?date=2026-07-18`, { headers })).json() as { annotations: unknown[]; episodes: Array<{ topicLabel: string }>; corrections: unknown[] };
    const removed = await fetch(`${address}/api/episode-corrections/${correction.correctionId}`, { method: "DELETE", headers });

    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({ collected: 1, inserted: 1, outputLinks: 1 });
    expect(firstSummary.outputs).toHaveLength(1);
    expect(annotated.status).toBe(201);
    expect(finalSummary.annotations).toHaveLength(1);
    expect(corrected.status).toBe(201);
    expect(finalSummary.episodes[0]!.topicLabel).toBe("Corrected browser evidence");
    expect(finalSummary.corrections).toHaveLength(1);
    expect(removed.status).toBe(200);
    store.close();
  });

  it("enforces dashboard pause state before activity events reach storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-control-"));
    const store = new ActivityStore(join(root, "collector.sqlite"));
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0 });
    running.push(server);
    const address = await server.start();
    const headers = { "content-type": "application/json", authorization: "Bearer test-secret" };
    const paused = await fetch(`${address}/api/control`, { method: "PUT", headers, body: JSON.stringify({ trackingEnabled: false }) });
    const event: ActivityEvent = {
      eventId: crypto.randomUUID(), schemaVersion: 1, eventType: "tab_activated", occurredAt: "2026-07-18T12:00:00.000Z",
      deviceId: "device", browser: "chrome", browserVersion: null, browserProfileId: "chrome:Default",
      browserSessionId: "session", windowId: "window", tabId: "tab", url: "https://example.com/private",
      canonicalUrl: null, domain: null, title: "Excluded while paused", navigationType: null, referrerUrl: null,
      idleState: "active", incognito: false, metadata: {},
    };
    const ingestion = await fetch(`${address}/api/events`, { method: "POST", headers, body: JSON.stringify({ events: [event] }) });
    const control = await fetch(`${address}/api/control`, { headers });

    expect(paused.status).toBe(200);
    expect(await ingestion.json()).toMatchObject({ received: 1, inserted: 0, droppedWhilePaused: 1 });
    expect(await control.json()).toMatchObject({ trackingEnabled: false, updatedAt: expect.any(String) });
    expect(store.readActivityEvents()).toHaveLength(0);
    store.close();
  });

  it("previews and downloads range-limited LLM analysis packs", async () => {
    const root = await mkdtemp(join(tmpdir(), "chromelens-analysis-export-"));
    const store = new ActivityStore(join(root, "collector.sqlite"));
    const server = createCollectorServer({ store, token: "test-secret", host: "127.0.0.1", port: 0 });
    running.push(server);
    const address = await server.start();
    const headers = { "content-type": "application/json", authorization: "Bearer test-secret" };
    const base = {
      schemaVersion: 1 as const, deviceId: "device", browser: "chrome" as const, browserVersion: null,
      browserProfileId: "chrome:Default", browserSessionId: "session", windowId: "session:1",
      tabId: null, url: null, canonicalUrl: null, domain: null, title: null, navigationType: null,
      referrerUrl: null, idleState: "active" as const, incognito: false, metadata: {},
    };
    await fetch(`${address}/api/events`, { method: "POST", headers, body: JSON.stringify({ events: [
      { ...base, eventId: crypto.randomUUID(), eventType: "window_focused", occurredAt: "2026-07-18T09:00:00.000Z" },
      { ...base, eventId: crypto.randomUUID(), eventType: "tab_activated", occurredAt: "2026-07-18T09:00:00.000Z", tabId: "A", url: "https://example.com/private-path", title: "Private page title" },
      { ...base, eventId: crypto.randomUUID(), eventType: "window_blurred", occurredAt: "2026-07-18T09:10:00.000Z" },
    ] }) });
    const query = "format=llm-markdown&from=2026-07-18&to=2026-07-18&timezone=Europe%2FLondon&privacy=aggregate&maxTokens=10000";
    const preview = await fetch(`${address}/api/export/preview?${query}`, { headers });
    const downloaded = await fetch(`${address}/api/export?${query}`, { headers });
    const previewBody = await preview.json() as { content: string; estimatedTokens: number };

    expect(preview.status).toBe(200);
    expect(previewBody.estimatedTokens).toBeGreaterThan(0);
    expect(previewBody.content).toContain("example.com");
    expect(previewBody.content).not.toContain("Private page title");
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toContain("text/markdown");
    expect(downloaded.headers.get("content-disposition")).toContain("chromelens-analysis");
    store.close();
  });
});
