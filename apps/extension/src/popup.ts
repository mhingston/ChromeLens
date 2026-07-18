interface Status {
  ok: boolean;
  trackingEnabled: boolean;
  queueLength: number;
  droppedCount: number;
  lastError: string | null;
  configured: boolean;
  collectorUrl: string;
}

const statusPill = document.querySelector<HTMLElement>("#status-pill")!;
const statusLabel = document.querySelector<HTMLElement>("#status-label")!;
const toggle = document.querySelector<HTMLButtonElement>("#toggle-tracking")!;
const idea = document.querySelector<HTMLTextAreaElement>("#idea")!;
const tags = document.querySelector<HTMLInputElement>("#tags")!;
const capture = document.querySelector<HTMLButtonElement>("#capture-idea")!;
const feedback = document.querySelector<HTMLElement>("#feedback")!;
const queue = document.querySelector<HTMLElement>("#queue-count")!;
const dropped = document.querySelector<HTMLElement>("#dropped-count")!;

toggle.addEventListener("click", async () => {
  const status = await getStatus();
  toggle.disabled = true;
  await chrome.runtime.sendMessage({ type: "set-tracking", enabled: !status.trackingEnabled });
  await refresh();
  toggle.disabled = false;
});

capture.addEventListener("click", async () => {
  capture.disabled = true;
  feedback.textContent = "Capturing…";
  const result = await chrome.runtime.sendMessage({ type: "capture-idea", text: idea.value, tags: tags.value }) as { ok: boolean; error?: string };
  if (result.ok) {
    idea.value = "";
    tags.value = "";
    feedback.textContent = "Idea captured with this page.";
  } else {
    feedback.textContent = result.error ?? "Could not capture idea.";
  }
  capture.disabled = false;
  await refresh();
});

document.querySelector("#open-options")!.addEventListener("click", () => chrome.runtime.openOptionsPage());
document.querySelector("#open-dashboard")!.addEventListener("click", async () => {
  const status = await getStatus();
  await chrome.tabs.create({ url: status.collectorUrl });
});
document.querySelector("#retry")!.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "flush" });
  await refresh();
});

async function getStatus(): Promise<Status> {
  return chrome.runtime.sendMessage({ type: "status" }) as Promise<Status>;
}

async function refresh(): Promise<void> {
  const status = await getStatus();
  statusPill.dataset.state = status.trackingEnabled ? "active" : "paused";
  statusLabel.textContent = status.trackingEnabled ? "Tracking active" : "Tracking paused";
  toggle.textContent = status.trackingEnabled ? "Pause tracking" : "Resume tracking";
  queue.textContent = String(status.queueLength);
  dropped.textContent = String(status.droppedCount);
  const connection = document.querySelector<HTMLElement>("#connection")!;
  connection.textContent = !status.configured ? "Collector token needed" : status.lastError ? status.lastError : "Collector configured";
  connection.dataset.state = !status.configured || status.lastError ? "warning" : "ok";
}

void refresh();
