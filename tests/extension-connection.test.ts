import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConnectionDiagnostic, statusLabel } from "../apps/extension/src/connection.ts";

describe("extension connection diagnostics", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses the current collector URL and token for an authenticated diagnostic", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:47832/api/diagnostics/connection");
      expect(init?.headers).toEqual({ authorization: "Bearer entered-token" });
      return new Response(JSON.stringify({ ok: true, service: "chromelens", schemaVersion: 1, authenticated: true, trackingEnabled: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchConnectionDiagnostic({ collectorUrl: "http://127.0.0.1:47832", token: "entered-token" });
    expect(result).toMatchObject({ ok: true, trackingEnabled: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps authentication failures to a distinct state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })));
    await expect(fetchConnectionDiagnostic({ collectorUrl: "http://localhost:47832", token: "bad-token" })).rejects.toThrow("Authentication failed");
    expect(statusLabel("connected-privacy-stale")).toContain("privacy configuration stale");
  });
});
