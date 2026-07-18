import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityEvent } from "../packages/domain/src/index.ts";
import { ActivityStore } from "../packages/database/src/index.ts";
import { createCollectorServer, type CollectorServer } from "../apps/collector/src/server.ts";

const running: CollectorServer[] = [];
const run = promisify(execFile);
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

describe("loopback collector", () => {
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
    const finalSummary = await (await fetch(`${address}/api/summary/daily?date=2026-07-18`, { headers })).json() as { annotations: unknown[] };

    expect(collected.status).toBe(200);
    expect(await collected.json()).toMatchObject({ collected: 1, inserted: 1, outputLinks: 1 });
    expect(firstSummary.outputs).toHaveLength(1);
    expect(annotated.status).toBe(201);
    expect(finalSummary.annotations).toHaveLength(1);
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
});
