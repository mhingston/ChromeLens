import { defaultPrivacySettings, type PrivacySettings } from "../../../packages/privacy/src/index.ts";

export interface ExtensionSettings {
  collectorUrl: string;
  token: string;
  trackingEnabled: boolean;
  trackingUpdatedAt: string;
  deviceId: string;
  browserProfileId: string;
  browser: "chrome" | "brave" | "chromium";
  privacy: PrivacySettings;
  remotePrivacy: PrivacySettings | null;
  privacyConfigVersion: string | null;
  privacySyncedAt: string | null;
}

export const defaultExtensionSettings = (): ExtensionSettings => ({
  collectorUrl: "http://127.0.0.1:47832",
  token: "",
  trackingEnabled: true,
  trackingUpdatedAt: "1970-01-01T00:00:00.000Z",
  deviceId: crypto.randomUUID(),
  browserProfileId: "chrome:Default",
  browser: detectBrowser(),
  privacy: structuredClone(defaultPrivacySettings),
  remotePrivacy: null,
  privacyConfigVersion: null,
  privacySyncedAt: null,
});

export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const { settings } = await chrome.storage.local.get("settings") as { settings?: Partial<ExtensionSettings> };
  const defaults = defaultExtensionSettings();
  const merged: ExtensionSettings = {
    ...defaults,
    ...settings,
    privacy: { ...defaults.privacy, ...(settings?.privacy ?? {}) },
    remotePrivacy: settings?.remotePrivacy ? { ...defaults.privacy, ...settings.remotePrivacy } : null,
    privacyConfigVersion: settings?.privacyConfigVersion ?? null,
    privacySyncedAt: settings?.privacySyncedAt ?? null,
  };
  if (!settings?.deviceId) await chrome.storage.local.set({ settings: merged });
  return merged;
}

export async function saveExtensionSettings(settings: ExtensionSettings): Promise<void> {
  validateCollectorUrl(settings.collectorUrl);
  await chrome.storage.local.set({ settings });
}

export function validateCollectorUrl(value: string): URL {
  let collector: URL;
  try { collector = new URL(value); } catch { throw new Error("Collector URL must be a valid URL"); }
  if ((collector.protocol !== "http:" && collector.protocol !== "https:") || !isLoopback(collector.hostname)) {
    throw new Error("Collector must use localhost or a loopback IP address");
  }
  return collector;
}

function detectBrowser(): "chrome" | "brave" | "chromium" {
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("brave")) return "brave";
  if (userAgent.includes("chrome")) return "chrome";
  return "chromium";
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
