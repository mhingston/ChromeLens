import type { ActivityEvent, ActivityEventType, IdleState } from "../../../packages/domain/src/index.ts";
import { sanitizeActivityEvent, withExcludedOrigin } from "../../../packages/privacy/src/index.ts";
import {
  enqueueForDelivery,
  markDeliveryFailed,
  markDeliverySucceeded,
  newDeliveryQueue,
  type DeliveryQueueState,
} from "./delivery-queue.ts";
import { getExtensionSettings, saveExtensionSettings, type ExtensionSettings } from "./settings.ts";

const QUEUE_KEY = "deliveryQueue";
const MAX_QUEUE_SIZE = 5_000;
let mutation = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void initialise();
});
chrome.runtime.onStartup.addListener(() => {
  void initialise();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs.get(tabId).then((tab) => emitTabEvent("tab_activated", tab));
});
chrome.tabs.onCreated.addListener((tab) => {
  void emitTabEvent("tab_opened", tab);
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void emit("tab_closed", { windowId: removeInfo.windowId, tabId });
});
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.url) void emitTabEvent("url_changed", tab);
  if (change.title) void emitTabEvent("title_changed", tab);
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void emit("window_blurred", {});
    return;
  }
  void activeTabInWindow(windowId).then((tab) => tab ? emitTabEvent("window_focused", tab) : emit("window_focused", { windowId }));
});
chrome.idle.onStateChanged.addListener((state) => {
  const types: Record<chrome.idle.IdleState, ActivityEventType> = {
    active: "user_active",
    idle: "user_idle",
    locked: "user_locked",
  };
  void emit(types[state], { idleState: state });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "chromelens-delivery") void syncRemoteControl().then(() => flushQueue());
});
chrome.runtime.onSuspend.addListener(() => {
  void emit("browser_session_ended", {});
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void handleMessage(message).then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unexpected error" }));
  return true;
});

async function initialise(): Promise<void> {
  await getExtensionSettings();
  await chrome.idle.setDetectionInterval(60);
  await chrome.alarms.create("chromelens-delivery", { periodInMinutes: 1 });
  const session = await ensureBrowserSession();
  await updateBadge();
  if (!session.startedRecorded) {
    await emit("browser_session_started", {});
    await chrome.storage.session.set({ session: { ...session, startedRecorded: true } });
  }
  await captureCurrentContext("window_focused");
  await flushQueue();
}

async function ensureBrowserSession(): Promise<{ browserSessionId: string; startedRecorded: boolean }> {
  const result = await chrome.storage.session.get("session") as { session?: { browserSessionId: string; startedRecorded: boolean } };
  if (result.session) return result.session;
  const session = { browserSessionId: crypto.randomUUID(), startedRecorded: false };
  await chrome.storage.session.set({ session });
  return session;
}

async function emitTabEvent(eventType: ActivityEventType, tab: chrome.tabs.Tab): Promise<void> {
  await emit(eventType, {
    windowId: tab.windowId,
    ...(tab.id === undefined ? {} : { tabId: tab.id }),
    url: tab.url ?? null,
    title: tab.title ?? null,
    incognito: tab.incognito,
  });
}

async function emit(
  eventType: ActivityEventType,
  context: { windowId?: number; tabId?: number; url?: string | null; title?: string | null; idleState?: IdleState; incognito?: boolean; metadata?: Record<string, unknown> },
): Promise<void> {
  const [settings, session] = await Promise.all([getExtensionSettings(), ensureBrowserSession()]);
  if (!settings.trackingEnabled && !["tracking_paused", "tracking_resumed", "browser_session_ended"].includes(eventType)) return;
  if (context.incognito && !settings.privacy.allowIncognito) return;
  const namespaced = (value: number | undefined): string | null => value === undefined ? null : `${session.browserSessionId}:${value}`;
  const event: ActivityEvent = {
    eventId: crypto.randomUUID(),
    schemaVersion: 1,
    eventType,
    occurredAt: new Date().toISOString(),
    deviceId: settings.deviceId,
    browser: settings.browser,
    browserVersion: navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] ?? null,
    browserProfileId: settings.browserProfileId,
    browserSessionId: session.browserSessionId,
    windowId: namespaced(context.windowId),
    tabId: namespaced(context.tabId),
    url: context.url ?? null,
    canonicalUrl: null,
    domain: null,
    title: context.title ?? null,
    navigationType: null,
    referrerUrl: null,
    idleState: context.idleState ?? null,
    incognito: context.incognito ?? false,
    metadata: context.metadata ?? {},
  };
  const sanitized = sanitizeActivityEvent(event, withExcludedOrigin(settings.privacy, settings.collectorUrl));
  await mutateQueue((queue) => enqueueForDelivery(queue, sanitized, MAX_QUEUE_SIZE));
  void flushQueue();
}

async function flushQueue(): Promise<void> {
  const settings = await getExtensionSettings();
  if (!settings.token) return;
  await mutateQueue(async (queue) => {
    if (!queue.events.length || queue.nextRetryAt > Date.now()) return queue;
    const batch = queue.events.slice(0, 100);
    try {
      const response = await fetch(`${settings.collectorUrl.replace(/\/$/, "")}/api/events`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ events: batch }),
      });
      if (!response.ok) throw new Error(`Collector returned ${response.status}`);
      return markDeliverySucceeded(queue, batch.map((event) => event.eventId));
    } catch (error) {
      return markDeliveryFailed(queue, Date.now(), error instanceof Error ? error.message : "Collector unavailable");
    }
  });
}

async function mutateQueue(
  transform: (queue: DeliveryQueueState) => DeliveryQueueState | Promise<DeliveryQueueState>,
): Promise<void> {
  const operation = mutation.then(async () => {
    const result = await chrome.storage.local.get(QUEUE_KEY) as { deliveryQueue?: DeliveryQueueState };
    const next = await transform(result.deliveryQueue ?? newDeliveryQueue());
    await chrome.storage.local.set({ [QUEUE_KEY]: next });
  });
  mutation = operation.catch(() => undefined);
  await operation;
}

async function handleMessage(message: unknown): Promise<Record<string, unknown>> {
  if (!message || typeof message !== "object") throw new Error("Invalid message");
  const request = message as Record<string, unknown>;
  if (request.type === "status") {
    const [settings, stored] = await Promise.all([getExtensionSettings(), chrome.storage.local.get(QUEUE_KEY)]) as [ExtensionSettings, { deliveryQueue?: DeliveryQueueState }];
    const queue = stored.deliveryQueue ?? newDeliveryQueue();
    return { ok: true, trackingEnabled: settings.trackingEnabled, queueLength: queue.events.length, droppedCount: queue.droppedCount, lastError: queue.lastError, configured: Boolean(settings.token), collectorUrl: settings.collectorUrl };
  }
  if (request.type === "set-tracking") {
    const settings = await getExtensionSettings();
    const enabled = request.enabled === true;
    settings.trackingEnabled = enabled;
    settings.trackingUpdatedAt = new Date().toISOString();
    await saveExtensionSettings(settings);
    await updateBadge();
    if (enabled) {
      await syncRemoteControl();
      await captureCurrentContext("tracking_resumed");
    } else {
      await captureCurrentContext("tracking_paused");
      await flushQueue();
      await syncRemoteControl();
    }
    return { ok: true, trackingEnabled: enabled };
  }
  if (request.type === "capture-idea") {
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!text) throw new Error("Write an idea before capturing it");
    const tags = typeof request.tags === "string" ? request.tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 20) : [];
    const tab = await activeTab();
    if (tab) await emit("idea_captured", { windowId: tab.windowId, ...(tab.id === undefined ? {} : { tabId: tab.id }), url: tab.url ?? null, title: tab.title ?? null, incognito: tab.incognito, metadata: { text, tags } });
    else await emit("idea_captured", { metadata: { text, tags } });
    return { ok: true };
  }
  if (request.type === "flush") {
    await flushQueue();
    return { ok: true };
  }
  if (request.type === "sync-control") {
    return { ok: await syncRemoteControl() };
  }
  throw new Error("Unknown message type");
}

async function captureCurrentContext(eventType: ActivityEventType): Promise<void> {
  const tab = await activeTab();
  if (tab) await emitTabEvent(eventType, tab);
  else await emit(eventType, {});
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

async function activeTabInWindow(windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, windowId });
  return tabs[0];
}

async function updateBadge(): Promise<void> {
  const { trackingEnabled } = await getExtensionSettings();
  await chrome.action.setBadgeText({ text: trackingEnabled ? "ON" : "Ⅱ" });
  await chrome.action.setBadgeBackgroundColor({ color: trackingEnabled ? "#2D7D68" : "#B36A2E" });
  await chrome.action.setTitle({ title: trackingEnabled ? "ChromeLens — tracking active" : "ChromeLens — tracking paused" });
}

async function syncRemoteControl(): Promise<boolean> {
  const settings = await getExtensionSettings();
  if (!settings.token) return false;
  try {
    const endpoint = `${settings.collectorUrl.replace(/\/$/, "")}/api/control`;
    const response = await fetch(endpoint, { headers: { authorization: `Bearer ${settings.token}` } });
    if (!response.ok) return false;
    const remote = await response.json() as { trackingEnabled?: unknown; updatedAt?: unknown };
    if (typeof remote.trackingEnabled !== "boolean" || typeof remote.updatedAt !== "string" || !Number.isFinite(Date.parse(remote.updatedAt))) return false;
    if (Date.parse(settings.trackingUpdatedAt) > Date.parse(remote.updatedAt)) {
      const update = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
        body: JSON.stringify({ trackingEnabled: settings.trackingEnabled, updatedAt: settings.trackingUpdatedAt }),
      });
      return update.ok;
    }
    if (Date.parse(remote.updatedAt) > Date.parse(settings.trackingUpdatedAt) && remote.trackingEnabled !== settings.trackingEnabled) {
      settings.trackingEnabled = remote.trackingEnabled;
      settings.trackingUpdatedAt = new Date(remote.updatedAt).toISOString();
      await saveExtensionSettings(settings);
      await updateBadge();
      await captureCurrentContext(remote.trackingEnabled ? "tracking_resumed" : "tracking_paused");
    }
    return true;
  } catch {
    return false;
  }
}

void initialise();
