import { describe, expect, it, vi } from "vitest";
import { CollectorApiError, requestApi } from "../apps/dashboard/src/api.ts";

describe("dashboard collector API errors", () => {
  it("preserves actionable JSON errors with operation and status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "invalid_range", message: "Range requires YYYY-MM-DD" }), { status: 400, headers: { "content-type": "application/json" } })));
    const result = requestApi("/api/summary/range", "token");
    await expect(result).rejects.toMatchObject({
      status: 400,
      code: "invalid_range",
      message: "GET /api/summary/range: Range requires YYYY-MM-DD (HTTP 400)",
    });
  });
});
