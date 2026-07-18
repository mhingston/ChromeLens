import { getExtensionSettings, saveExtensionSettings } from "./settings.ts";

const form = document.querySelector<HTMLFormElement>("#settings-form")!;
const feedback = document.querySelector<HTMLElement>("#feedback")!;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  feedback.textContent = "Saving…";
  try {
    const settings = await getExtensionSettings();
    settings.collectorUrl = value("collector-url").replace(/\/$/, "");
    settings.token = value("token").trim();
    settings.browserProfileId = value("profile-id").trim() || settings.browserProfileId;
    settings.privacy.allowIncognito = checked("allow-incognito");
    settings.privacy.redactLocalhostPaths = checked("redact-localhost");
    settings.privacy.removeFragments = checked("remove-fragments");
    settings.privacy.dropTrackingParameters = checked("drop-tracking");
    settings.privacy.redactQueryValues = value("query-redaction") as "all" | "sensitive" | "none";
    settings.privacy.excludedDomains = lines("excluded-domains");
    settings.privacy.excludedUrlPatterns = lines("excluded-patterns");
    await saveExtensionSettings(settings);
    await chrome.runtime.sendMessage({ type: "sync-control" });
    feedback.textContent = "Settings saved locally.";
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "Could not save settings.";
  }
});

document.querySelector("#test-collector")!.addEventListener("click", async () => {
  feedback.textContent = "Testing collector…";
  try {
    const settings = await getExtensionSettings();
    const response = await fetch(`${settings.collectorUrl}/api/health`);
    if (!response.ok) throw new Error(`Collector returned ${response.status}`);
    feedback.textContent = "Collector is reachable on loopback.";
  } catch (error) {
    feedback.textContent = error instanceof Error ? error.message : "Collector unavailable.";
  }
});

async function populate(): Promise<void> {
  const settings = await getExtensionSettings();
  setValue("collector-url", settings.collectorUrl);
  setValue("token", settings.token);
  setValue("profile-id", settings.browserProfileId);
  setChecked("allow-incognito", settings.privacy.allowIncognito);
  setChecked("redact-localhost", settings.privacy.redactLocalhostPaths);
  setChecked("remove-fragments", settings.privacy.removeFragments);
  setChecked("drop-tracking", settings.privacy.dropTrackingParameters);
  setValue("query-redaction", settings.privacy.redactQueryValues);
  setValue("excluded-domains", settings.privacy.excludedDomains.join("\n"));
  setValue("excluded-patterns", settings.privacy.excludedUrlPatterns.join("\n"));
}

function value(id: string): string { return (document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)!).value; }
function checked(id: string): boolean { return document.querySelector<HTMLInputElement>(`#${id}`)!.checked; }
function lines(id: string): string[] { return value(id).split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function setValue(id: string, next: string): void { document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`#${id}`)!.value = next; }
function setChecked(id: string, next: boolean): void { document.querySelector<HTMLInputElement>(`#${id}`)!.checked = next; }

void populate();
