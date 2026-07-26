import { describe, expect, it } from "vitest";
import { defaultPrivacySettings, mergeRestrictivePrivacySettings, serializePrivacySettings } from "../packages/privacy/src/index.ts";

describe("privacy configuration synchronization", () => {
  it("merges conflicting local and canonical rules restrictively", () => {
    const merged = mergeRestrictivePrivacySettings(
      { ...defaultPrivacySettings, excludedDomains: ["local.example"], redactQueryValues: "sensitive", allowIncognito: true },
      { ...defaultPrivacySettings, excludedDomains: ["remote.example"], redactQueryValues: "all", allowIncognito: false },
    );
    expect(merged.excludedDomains).toEqual(expect.arrayContaining(["local.example", "remote.example"]));
    expect(merged.redactQueryValues).toBe("all");
    expect(merged.allowIncognito).toBe(false);
  });

  it("serializes equivalent rule sets deterministically", () => {
    const left = { ...defaultPrivacySettings, excludedDomains: ["B.example", "a.example"] };
    const right = { ...defaultPrivacySettings, excludedDomains: ["a.example", "b.example"] };
    expect(serializePrivacySettings(left)).toBe(serializePrivacySettings(right));
  });
});
