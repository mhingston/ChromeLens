import type { ActivityEvent, ActivityEventType, IdleState } from "../../../packages/domain/src/index.ts";
import { mergeRestrictivePrivacySettings, sanitizeActivityEvent, withExcludedOrigin } from "../../../packages/privacy/src/index.ts";
import {
  enqueueForDelivery,
  markDeliveryFailed,
  markDeliverySucceeded,
  newDeliveryQueue,
  type DeliveryQueueState,
} from "./delivery-queue.ts";
import { getExtensionSettings, saveExtensionSettings, type ExtensionSettings } from "./settings.ts";
import { fetchConnectionDiagnostic, statusLabel, type ConnectionStatus } from "./connection.ts";

const QUEUE_KEY = "deliveryQueue";
const MAX_QUEUE_SIZE = 5_000;
const ICONS = {
  active: {
    16: "icons/icon-active-16.png",
    32: "icons/icon-active-32.png",
    48: "icons/icon-active-48.png",
    128: "icons/icon-active-128.png",
  },
  paused: {
    16: "icons/icon-paused-16.png",
    32: "icons/icon-paused-32.png",
    48: "icons/icon-paused-48.png",
    128: "icons/icon-paused-128.png",
  },
} as const;
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
  if (alarm.name === "chromelens-delivery") void syncRemoteControl().then(() => syncPrivacyConfig()).then(() => flushQueue());
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
  await updateIcon();
  if (!session.startedRecorded) {
    await emit("browser_session_started", {});
    await chrome.storage.session.set({ session: { ...session, startedRecorded: true } });
  }
  await captureCurrentContext("window_focused");
  await syncPrivacyConfig();
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
  const stored = await chrome.storage.local.get(QUEUE_KEY) as { deliveryQueue?: DeliveryQueueState };
  const queue = stored.deliveryQueue ?? newDeliveryQueue();
  void reportDeliveryHealth(settings, queue);
}

async function reportDeliveryHealth(settings: ExtensionSettings, queue: DeliveryQueueState): Promise<void> {
  try {
    await fetch(`${settings.collectorUrl.replace(/\/$/, "")}/api/diagnostics/delivery`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${settings.token}` },
      body: JSON.stringify({ queuedEvents: queue.events.length, droppedEvents: queue.droppedCount, privacyConfigVersion: settings.privacyConfigVersion }),
    });
  } catch {
    // Delivery health is advisory; local queueing must continue when the collector is offline.
  }
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
    const connection = await connectionState(settings, queue);
    return { ok: true, trackingEnabled: settings.trackingEnabled, queueLength: queue.events.length, droppedCount: queue.droppedCount, lastError: queue.lastError, configured: Boolean(settings.token), collectorUrl: settings.collectorUrl, connectionStatus: connection.status, connectionLabel: statusLabel(connection.status), privacyDrift: connection.privacyDrift, privacySyncedAt: settings.privacySyncedAt };
  }
  if (request.type === "set-tracking") {
    const settings = await getExtensionSettings();
    const enabled = request.enabled === true;
    settings.trackingEnabled = enabled;
    settings.trackingUpdatedAt = new Date().toISOString();
    await saveExtensionSettings(settings);
    await updateIcon();
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
  if (request.type === "sync-privacy") {
    return { ok: await syncPrivacyConfig() };
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

async function updateIcon(): Promise<void> {
  const { trackingEnabled } = await getExtensionSettings();
  await chrome.action.setIcon({ path: trackingEnabled ? ICONS.active : ICONS.paused });
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
      await updateIcon();
      await captureCurrentContext(remote.trackingEnabled ? "tracking_resumed" : "tracking_paused");
    }
    return true;
  } catch {
    return false;
  }
}

async function syncPrivacyConfig(): Promise<boolean> {
  const settings = await getExtensionSettings();
  if (!settings.token) return false;
  try {
    const response = await fetch(`${settings.collectorUrl.replace(/\/$/, "")}/api/privacy/config`, { headers: { authorization: `Bearer ${settings.token}` } });
    if (!response.ok) return false;
    const payload = await response.json() as { config?: unknown; version?: unknown };
    if (!isPrivacyConfig(payload.config) || typeof payload.version !== "string") return false;
    settings.remotePrivacy = payload.config;
    settings.privacy = mergeRestrictivePrivacySettings(settings.privacy, payload.config);
    settings.privacyConfigVersion = payload.version;
    settings.privacySyncedAt = new Date().toISOString();
    await saveExtensionSettings(settings);
    return true;
  } catch {
    return false;
  }
}

async function connectionState(settings: ExtensionSettings, queue: DeliveryQueueState): Promise<{ status: ConnectionStatus; privacyDrift: boolean }> {
  if (!settings.token) return { status: "not-configured", privacyDrift: false };
  if (queue.nextRetryAt > Date.now()) return { status: "queue-backing-off", privacyDrift: false };
  try {
    const diagnostic = await fetchConnectionDiagnostic(settings);
    const privacyDrift = Boolean(settings.privacyConfigVersion && diagnostic.privacyConfigVersion && settings.privacyConfigVersion !== diagnostic.privacyConfigVersion);
    if (privacyDrift) return { status: "connected-privacy-stale", privacyDrift };
    if (!settings.trackingEnabled || diagnostic.trackingEnabled === false) return { status: "tracking-paused", privacyDrift };
    return { status: "connected", privacyDrift };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("Authentication failed")) return { status: "authentication-failed", privacyDrift: false };
    if (message.startsWith("Collector schema")) return { status: "unsupported-schema", privacyDrift: false };
    return { status: "collector-unavailable", privacyDrift: false };
  }
}

function isPrivacyConfig(value: unknown): value is ExtensionSettings["privacy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.excludedDomains)
    && Array.isArray(record.excludedUrlPatterns)
    && (record.redactQueryValues === "all" || record.redactQueryValues === "sensitive" || record.redactQueryValues === "none")
    && typeof record.removeFragments === "boolean"
    && typeof record.redactLocalhostPaths === "boolean"
    && typeof record.dropTrackingParameters === "boolean"
    && typeof record.allowIncognito === "boolean";
}

void initialise();
