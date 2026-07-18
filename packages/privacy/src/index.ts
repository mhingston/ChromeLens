import type { ActivityEvent } from "../../domain/src/index.ts";

export interface PrivacySettings {
  excludedDomains: string[];
  excludedUrlPatterns: string[];
  redactQueryValues: "all" | "sensitive" | "none";
  removeFragments: boolean;
  redactLocalhostPaths: boolean;
  dropTrackingParameters: boolean;
  allowIncognito: boolean;
}

export const defaultPrivacySettings: PrivacySettings = {
  excludedDomains: [
    "accounts.google.com",
    "login.microsoftonline.com",
    "mail.google.com",
    "outlook.office.com",
    "outlook.live.com",
    "1password.com",
    "lastpass.com",
    "bitwarden.com",
    "mychart.com",
  ],
  excludedUrlPatterns: [
    "http://127.0.0.1:47832/*",
    "http://localhost:47832/*",
    "http://[::1]:47832/*",
    "*://*/oauth/*",
    "*://*/authorize*",
    "*://*/login*",
    "*://*/signin*",
    "*://*/password*",
  ],
  redactQueryValues: "all",
  removeFragments: true,
  redactLocalhostPaths: true,
  dropTrackingParameters: true,
  allowIncognito: false,
};

export function withExcludedOrigin(settings: PrivacySettings, originUrl: string): PrivacySettings {
  try {
    const pattern = `${new URL(originUrl).origin}/*`;
    if (settings.excludedUrlPatterns.includes(pattern)) return settings;
    return { ...settings, excludedUrlPatterns: [...settings.excludedUrlPatterns, pattern] };
  } catch {
    return settings;
  }
}

const SENSITIVE_QUERY_KEY = /(?:^|_)(?:access_?token|auth|authorization|code|credential|jwt|key|password|secret|session|signature|token)(?:$|_)/i;
const TRACKING_QUERY_KEY = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;

export function sanitizeActivityEvent(event: ActivityEvent, settings: PrivacySettings): ActivityEvent {
  if (event.incognito && !settings.allowIncognito) {
    return excludedMarker(event, "incognito_disabled");
  }
  if (!event.url?.trim()) return { ...event, url: null, canonicalUrl: null, domain: null };

  let parsed: URL;
  try {
    parsed = new URL(event.url);
  } catch {
    return excludedMarker(event, "invalid_url");
  }
  if (!isTrackableProtocol(parsed.protocol)) return excludedMarker(event, "unsupported_protocol");

  const domain = parsed.hostname.toLowerCase();
  if (isExcludedDomain(domain, settings.excludedDomains) || matchesAnyPattern(event.url, settings.excludedUrlPatterns)) {
    return excludedMarker(event, "exclusion_rule");
  }

  const sanitized = sanitizeUrl(parsed, settings);
  const referrerUrl = event.referrerUrl ? sanitizeOptionalUrl(event.referrerUrl, settings) : null;
  return {
    ...event,
    url: sanitized,
    canonicalUrl: canonicalizeUrl(sanitized),
    domain,
    referrerUrl,
    metadata: { ...event.metadata, excluded: false },
  };
}

export function canonicalizeUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return null;
  }
}

export function isExcludedDomain(domain: string, exclusions: string[]): boolean {
  const lower = domain.toLowerCase().replace(/^\.+|\.+$/g, "");
  return exclusions.some((entry) => {
    const excluded = entry.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+|\.+$/g, "");
    return excluded.length > 0 && (lower === excluded || lower.endsWith(`.${excluded}`));
  });
}

function sanitizeUrl(parsed: URL, settings: PrivacySettings): string {
  parsed.hostname = parsed.hostname.toLowerCase();
  if (settings.removeFragments) parsed.hash = "";
  if (settings.redactLocalhostPaths && isLocalHostname(parsed.hostname)) {
    parsed.pathname = "/[REDACTED]";
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (settings.dropTrackingParameters && TRACKING_QUERY_KEY.test(key)) {
      parsed.searchParams.delete(key);
      continue;
    }
    if (settings.redactQueryValues === "all" || SENSITIVE_QUERY_KEY.test(key)) {
      const values = parsed.searchParams.getAll(key);
      parsed.searchParams.delete(key);
      for (let index = 0; index < Math.max(values.length, 1); index += 1) {
        parsed.searchParams.append(key, "[REDACTED]");
      }
    }
  }
  parsed.searchParams.sort();
  return parsed.toString();
}

function sanitizeOptionalUrl(rawUrl: string, settings: PrivacySettings): string | null {
  try {
    const parsed = new URL(rawUrl);
    return isTrackableProtocol(parsed.protocol) ? sanitizeUrl(parsed, settings) : null;
  } catch {
    return null;
  }
}

function excludedMarker(event: ActivityEvent, reason: string): ActivityEvent {
  return {
    ...event,
    url: null,
    canonicalUrl: null,
    domain: null,
    title: null,
    navigationType: null,
    referrerUrl: null,
    metadata: { ...event.metadata, excluded: true, exclusionReason: reason },
  };
}

function isTrackableProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

function matchesAnyPattern(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const expression = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*");
    try {
      return new RegExp(`^${expression}$`, "i").test(url);
    } catch {
      return false;
    }
  });
}
