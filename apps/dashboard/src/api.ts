export type Json = Record<string, any>;

export interface CollectorErrorPayload {
  error?: string;
  message?: string;
}

export class CollectorApiError extends Error {
  readonly status: number;
  readonly operation: string;
  readonly code: string | null;

  constructor(status: number, operation: string, payload: CollectorErrorPayload | null = null) {
    const detail = payload?.message ?? payload?.error ?? `HTTP ${status}`;
    super(`${operation}: ${detail} (HTTP ${status})`);
    this.name = "CollectorApiError";
    this.status = status;
    this.operation = operation;
    this.code = payload?.error ?? null;
  }
}

export async function requestApi(path: string, token: string, init: RequestInit = {}): Promise<Json> {
  const operation = operationName(path, init.method ?? "GET");
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) throw new CollectorApiError(response.status, operation, await readErrorPayload(response));
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  return await response.json() as Json;
}

async function readErrorPayload(response: Response): Promise<CollectorErrorPayload | null> {
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.error === "string" ? { error: record.error } : {}),
      ...(typeof record.message === "string" ? { message: record.message } : {}),
    };
  } catch {
    return null;
  }
}

function operationName(path: string, method: string): string {
  const pathname = path.split("?")[0] || "/";
  const labels: Record<string, string> = {
    "/api/diagnostics/connection": "Connection diagnostic",
    "/api/settings": "Save privacy settings",
    "/api/connectors/git": "Collect Git outputs",
    "/api/import": "Import browser history",
    "/api/rebuild": "Rebuild derivations",
    "/api/history/summary": "Load history evidence",
    "/api/insights": "Load deterministic insights",
    "/api/patterns": "Load pattern evidence",
    "/api/search": "Search local evidence",
  };
  return labels[pathname] ?? `${method.toUpperCase()} ${pathname}`;
}
