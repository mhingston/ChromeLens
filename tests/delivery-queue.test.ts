import { describe, expect, it } from "vitest";
import type { ActivityEvent } from "../packages/domain/src/index.ts";
import {
  enqueueForDelivery,
  markDeliveryFailed,
  markDeliverySucceeded,
  newDeliveryQueue,
} from "../apps/extension/src/delivery-queue.ts";

const event = (id: string): ActivityEvent => ({
  eventId: id, schemaVersion: 1, eventType: "tab_opened", occurredAt: "2026-07-18T10:00:00.000Z",
  deviceId: "device", browser: "chrome", browserVersion: null, browserProfileId: null,
  browserSessionId: "session", windowId: "session:1", tabId: `session:${id}`, url: "https://example.com",
  canonicalUrl: null, domain: null, title: "Example", navigationType: null, referrerUrl: null,
  idleState: "active", incognito: false, metadata: {},
});

describe("extension event delivery queue", () => {
  it("survives outages with bounded storage, visible drops, backoff, and idempotent acknowledgement", () => {
    let queue = newDeliveryQueue();
    queue = enqueueForDelivery(queue, event("one"), 2);
    queue = enqueueForDelivery(queue, event("two"), 2);
    queue = enqueueForDelivery(queue, event("three"), 2);
    queue = enqueueForDelivery(queue, event("three"), 2);
    queue = markDeliveryFailed(queue, 1_000);

    expect(queue.events.map(({ eventId }) => eventId)).toEqual(["two", "three"]);
    expect(queue.droppedCount).toBe(1);
    expect(queue.attempts).toBe(1);
    expect(queue.nextRetryAt).toBe(2_000);

    queue = markDeliverySucceeded(queue, ["two"]);
    expect(queue.events.map(({ eventId }) => eventId)).toEqual(["three"]);
    expect(queue.attempts).toBe(0);
  });
});
