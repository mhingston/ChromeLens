import { describe, expect, it } from "vitest";
import { defaultPrivacySettings, sanitizeActivityEvent } from "../packages/privacy/src/index.ts";
import type { ActivityEvent } from "../packages/domain/src/index.ts";

const event = (url: string): ActivityEvent => ({
  eventId: crypto.randomUUID(),
  schemaVersion: 1,
  eventType: "tab_activated",
  occurredAt: "2026-07-18T09:00:00.000Z",
  deviceId: "device-test",
  browser: "chrome",
  browserVersion: null,
  browserProfileId: "chrome:Default",
  browserSessionId: "session-test",
  windowId: "session-test:1",
  tabId: "session-test:2",
  url,
  canonicalUrl: null,
  domain: null,
  title: "Private account",
  navigationType: null,
  referrerUrl: null,
  idleState: "active",
  incognito: false,
  metadata: {},
});

describe("privacy enforcement", () => {
  it("removes excluded contexts and redacts URL values before persistence", () => {
    const settings = {
      ...defaultPrivacySettings,
      excludedDomains: [...defaultPrivacySettings.excludedDomains, "bank.example"],
      redactQueryValues: "all" as const,
    };

    const excluded = sanitizeActivityEvent(event("https://bank.example/account?token=secret"), settings);
    const redacted = sanitizeActivityEvent(event("https://Example.com/research?q=private&utm_source=news#notes"), settings);
    const collectorUi = sanitizeActivityEvent(event("http://127.0.0.1:47832/#settings"), defaultPrivacySettings);

    expect(excluded).toMatchObject({ url: null, canonicalUrl: null, domain: null, title: null, metadata: { excluded: true } });
    expect(redacted.domain).toBe("example.com");
    expect(new URL(redacted.url!).searchParams.get("q")).toBe("[REDACTED]");
    expect(redacted.url).not.toContain("private");
    expect(redacted.url).not.toContain("utm_source");
    expect(redacted.url).not.toContain("#notes");
    expect(collectorUi).toMatchObject({ url: null, domain: null, metadata: { excluded: true } });
  });

  it("normalizes an empty pending-navigation URL to a URL-free transition", () => {
    const pendingNavigation = sanitizeActivityEvent(event(""), defaultPrivacySettings);

    expect(pendingNavigation).toMatchObject({ url: null, canonicalUrl: null, domain: null });
  });
});
