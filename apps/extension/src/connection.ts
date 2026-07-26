import { validateCollectorUrl, type ExtensionSettings } from "./settings.ts";

export type ConnectionStatus = "not-configured" | "collector-unavailable" | "authentication-failed" | "unsupported-schema" | "queue-backing-off" | "connected" | "connected-privacy-stale" | "tracking-paused";

export interface ConnectionDiagnostic {
  ok: boolean;
  service?: "chromelens";
  schemaVersion?: number;
  authenticated?: true;
  collectorTime?: string;
  trackingEnabled?: boolean;
  privacyConfigVersion?: string;
}

export async function fetchConnectionDiagnostic(settings: Pick<ExtensionSettings, "collectorUrl" | "token">): Promise<ConnectionDiagnostic> {
  const collector = validateCollectorUrl(settings.collectorUrl);
  const response = await fetch(`${collector.origin}${collector.pathname.replace(/\/$/, "")}/api/diagnostics/connection`, {
    headers: { authorization: `Bearer ${settings.token}` },
  });
  let payload: unknown = {};
  try { payload = await response.json(); } catch { /* Use status below. */ }
  if (!response.ok) {
    if (response.status === 401) throw new Error("Authentication failed: check the bearer token.");
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? payload.message : null;
    throw new Error(message ?? `Collector returned ${response.status}.`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Collector schema is unsupported.");
  const diagnostic = payload as Partial<ConnectionDiagnostic>;
  if (diagnostic.service !== "chromelens" || diagnostic.schemaVersion !== 1 || diagnostic.authenticated !== true || typeof diagnostic.ok !== "boolean") {
    throw new Error("Collector schema is unsupported.");
  }
  return diagnostic as ConnectionDiagnostic;
}

export function statusLabel(status: ConnectionStatus): string {
  const labels: Record<ConnectionStatus, string> = {
    "not-configured": "Not configured",
    "collector-unavailable": "Collector unavailable",
    "authentication-failed": "Authentication failed",
    "unsupported-schema": "Collector schema unsupported",
    "queue-backing-off": "Queue backing off",
    connected: "Connected",
    "connected-privacy-stale": "Connected · privacy configuration stale",
    "tracking-paused": "Tracking paused",
  };
  return labels[status];
}
