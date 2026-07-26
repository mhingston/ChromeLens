import { countLabel, formatDuration, summarizeEpisodePages, summarizeFocusPeriods, type EpisodeIntervalView, type FocusPeriodView } from "./presentation.ts";
import { CollectorApiError, requestApi, type Json } from "./api.ts";
import { calendarDayWindow, calendarRange, type CalendarRangeMode } from "../../../packages/calendar-analysis/src/index.ts";

const content = document.querySelector<HTMLElement>("#content")!;
const dateInput = document.querySelector<HTMLInputElement>("#date")!;
const rangeModeInput = document.querySelector<HTMLSelectElement>("#range-mode")!;
const customRange = document.querySelector<HTMLElement>("#custom-range")!;
const customFromInput = document.querySelector<HTMLInputElement>("#custom-from")!;
const customToInput = document.querySelector<HTMLInputElement>("#custom-to")!;
const tokenDialog = document.querySelector<HTMLDialogElement>("#token-dialog")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
const evidenceDrawer = document.querySelector<HTMLDialogElement>("#evidence-drawer")!;
const evidenceDrawerContent = document.querySelector<HTMLElement>("#evidence-drawer-content")!;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
let token = localStorage.getItem("chromelens-token") ?? "";
let view = "day";
dateInput.value = localCalendarDate(new Date());
rangeModeInput.value = "calendar_week";
customFromInput.value = shiftCalendarDate(dateInput.value, -6);
customToInput.value = dateInput.value;

document.querySelectorAll<HTMLButtonElement>(".nav-button").forEach((button) => button.addEventListener("click", () => {
  view = button.dataset.view ?? "day";
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("active", item === button));
  void load();
}));
document.querySelector("#previous-date")!.addEventListener("click", () => shiftDate(-periodStep()));
document.querySelector("#next-date")!.addEventListener("click", () => shiftDate(periodStep()));
dateInput.addEventListener("change", () => void load());
rangeModeInput.addEventListener("change", () => { syncRangeControls(); void load(); });
customFromInput.addEventListener("change", () => void load());
customToInput.addEventListener("change", () => void load());
document.querySelector("#today")!.addEventListener("click", () => { dateInput.value = localCalendarDate(new Date()); void load(); });
document.querySelector("#close-evidence-drawer")!.addEventListener("click", () => evidenceDrawer.close());
document.querySelector<HTMLFormElement>("#token-form")!.addEventListener("submit", () => {
  token = document.querySelector<HTMLInputElement>("#dashboard-token")!.value.trim();
  localStorage.setItem("chromelens-token", token);
  window.setTimeout(() => void load(), 0);
});

async function load(): Promise<void> {
  const titles: Record<string, [string,string]> = {
    day:["DAILY LENS","A day in context."], week:["WEEKLY PATTERNS","Seven days, observed."],
    month:["MONTHLY PATTERNS","A calendar month, observed."], settings:["LOCAL CONTROLS","Privacy & data."],
  };
  document.querySelector("#view-kicker")!.textContent = titles[view]![0];
  document.querySelector("#view-title")!.textContent = titles[view]![1];
  document.querySelector<HTMLElement>("#date-controls")!.hidden = view === "settings";
  rangeModeInput.hidden = view === "day" || view === "settings";
  syncRangeControls();
  content.replaceChildren(el("div", "loading", "Focusing the lens…"));
  notice.hidden = true;
  try {
    if (!token) return requireToken();
    await refreshCollectorStatus();
    if (view === "day") renderDay(await api(`/api/summary/daily?date=${dateInput.value}&timezone=${encodeURIComponent(timeZone)}`));
    else if (view === "week" || view === "month") renderRange(await api(rangeQuery()));
    else await renderSettings();
  } catch (error) {
    if (error instanceof CollectorApiError && error.status === 401) return requireToken();
    content.replaceChildren(el("div", "empty", error instanceof Error ? error.message : "Could not load local data."));
  }
}

async function refreshCollectorStatus(): Promise<void> {
  const status = document.querySelector<HTMLElement>("#collector-health")!;
  try {
    const diagnostic = await api("/api/diagnostics/connection");
    status.dataset.state = diagnostic.trackingEnabled ? "connected" : "paused";
    const observed = diagnostic.lastObservedEventAt ? ` · last observed ${clock(diagnostic.lastObservedEventAt)}` : "";
    status.querySelector("span")!.textContent = diagnostic.trackingEnabled ? `Collector connected${observed}` : `Collector connected · tracking paused${observed}`;
  } catch (error) {
    status.dataset.state = error instanceof CollectorApiError && error.status === 401 ? "auth" : "offline";
    status.querySelector("span")!.textContent = error instanceof CollectorApiError && error.status === 401 ? "Collector authentication failed" : "Collector unavailable";
  }
}

function rangeQuery(): string {
  const mode = (view === "month" ? "calendar_month" : rangeModeInput.value) as CalendarRangeMode;
  const range = mode === "custom"
    ? calendarRange(dateInput.value, timeZone, mode, customFromInput.value, customToInput.value)
    : calendarRange(dateInput.value, timeZone, mode);
  return `/api/summary/range?from=${range.from}&to=${range.to}&days=${range.dates.length}&mode=${mode}&timezone=${encodeURIComponent(timeZone)}`;
}

function syncRangeControls(): void {
  customRange.hidden = view === "day" || view === "settings" || rangeModeInput.value !== "custom";
}

function renderDay(data: Json): void {
  const metrics = el("section", "metric-grid");
  metrics.append(
    metric("Active foreground", duration(data.metrics.activeDurationMs), "Observed, not scored"),
    metric("Median focus", duration(median(data.focusPeriods.map((item: Json) => item.durationMs))), `${data.focusPeriods.length} focus periods`),
    metric("Tab switches", String(data.metrics.tabSwitchCount), "Observed transitions"),
    metric("Domain switches", String(data.metrics.domainSwitchCount), "Observed transitions"),
    metric("Unique context boundaries", String(data.metrics.uniqueContextBoundaryCount), "A tab or domain boundary, counted once"),
    metric("Linked outputs", String(data.metrics.outputCount), "Local connector evidence"),
  );
  const grid = el("section", "grid");
  grid.append(timelineCard(data), focusCard(data.focusPeriods), boundariesCard(data.boundaries), domainsCard(data.topDomains), episodesCard(data.episodes,data.outputs,data.annotations,data.corrections??[],data.intervals,data.ideas), ideasCard(data.ideas), outputsCard(data.outputs));
  content.replaceChildren(metrics, grid);
  if (!data.intervals.length) showNotice("No prospective activity intervals for this day. Historical visits cannot be presented as active attention.");
}

function timelineCard(data: Json): HTMLElement {
  const card = cardShell("Active browsing timeline", "Foreground intervals only. Gaps represent idle, blur, pause, exclusions, or no observed activity.", "wide");
  if (!data.intervals.length) { card.append(empty("No active intervals yet.")); return card; }
  const track = el("div", "timeline");
  const colors = ["#2d7d68","#c26c35","#55739b","#7c638e","#8a814f","#4e8a8e"];
  const lanes: number[] = [];
  data.intervals.forEach((interval: Json, index: number) => {
    const startMinute = minuteWithinCalendarDay(interval.startedAt, data.date, false);
    const endMinute = minuteWithinCalendarDay(interval.endedAt, data.date, true);
    let lane = lanes.findIndex((last) => last <= startMinute); if (lane < 0) lane = lanes.length; lanes[lane] = endMinute;
    const item = el("button", "time-row", interval.title || interval.domain || "Untitled page");
    item.style.left = `${(startMinute/1440)*100}%`; item.style.width = `${Math.max(.55,((endMinute-startMinute)/1440)*100)}%`; item.style.top = `${lane*39+10}px`; item.style.setProperty("--domain-color", colors[index%colors.length]!);
    const label = `${interval.title || interval.domain || "Untitled page"}. ${clock(interval.startedAt)} to ${clock(interval.endedAt)}. ${interval.domain ?? "Private or excluded context"}. ${duration(interval.durationMs)}.`;
    item.title = label;
    item.setAttribute("aria-label", `Open evidence: ${label}`);
    item.addEventListener("click", () => openEvidenceDrawer(interval, data));
    track.append(item);
  });
  const labels = el("div", "hour-labels"); ["00","04","08","12","16","20","24"].forEach((hour) => labels.append(el("span", "", hour)));
  card.append(track, labels); return card;
}

function openEvidenceDrawer(interval: Json, data: Json): void {
  const index = data.intervals.findIndex((candidate: Json) => candidate.intervalId === interval.intervalId);
  const episode = data.episodes.find((candidate: Json) => candidate.intervalIds.includes(interval.intervalId));
  evidenceDrawerContent.replaceChildren();
  const heading = el("p", "eyebrow", "INTERVAL EVIDENCE");
  const title = el("h2", "drawer-title", interval.title || interval.domain || "Private or excluded context");
  title.id = "evidence-drawer-title";
  const intro = el("p", "card-subtitle", "Observed interval details. Retained fields follow the active privacy rules.");
  const facts = el("dl", "evidence-facts");
  const fact = (label: string, value: string): void => { facts.append(el("dt", "", label), el("dd", "", value)); };
  fact("Domain", interval.domain ?? "Not retained");
  fact("Canonical URL", interval.canonicalUrl ?? "Not retained by privacy configuration");
  fact("Start", `${clock(interval.startedAt)} · ${interval.startedAt}`);
  fact("End", `${clock(interval.endedAt)} · ${interval.endedAt}`);
  fact("Duration", duration(interval.durationMs));
  fact("Browser profile", interval.browserProfileId ?? "Unknown profile");
  fact("Browser session", interval.browserSessionId ?? "Unknown session");
  fact("Termination reason", labelText(interval.terminationReason));
  fact("Privacy status", interval.domain || interval.url ? "Retained after configured redaction" : "Excluded or redacted context; URL/title not retained");
  const context = el("div", "drawer-context");
  const previous = index > 0 ? data.intervals[index - 1] : null;
  const next = index >= 0 ? data.intervals[index + 1] : null;
  context.append(el("p", "", `Previous context: ${previous ? `${previous.title || previous.domain || "Private context"} · ${clock(previous.endedAt)}` : "None in this range"}`));
  context.append(el("p", "", `Next context: ${next ? `${next.title || next.domain || "Private context"} · ${clock(next.startedAt)}` : "None in this range"}`));
  const actions = el("div", "actions");
  if (episode) {
    const episodeButton = el("button", "secondary", `Open episode: ${episode.topicLabel}`);
    episodeButton.type = "button";
    episodeButton.addEventListener("click", () => focusEpisode(episode.episodeId));
    const annotationButton = el("button", "secondary", "Annotate episode");
    annotationButton.type = "button";
    annotationButton.addEventListener("click", () => focusEpisode(episode.episodeId, "annotation-disclosure"));
    const correctionButton = el("button", "secondary", "Correct episode grouping");
    correctionButton.type = "button";
    correctionButton.addEventListener("click", () => focusEpisode(episode.episodeId, "correction-disclosure", true));
    actions.append(episodeButton, annotationButton, correctionButton);
  }
  evidenceDrawerContent.append(heading, title, intro, facts, context, actions);
  evidenceDrawer.showModal();
}

function focusEpisode(episodeId: string, selector = "episode-details", openDetails = false): void {
  evidenceDrawer.close();
  const episode = document.querySelector<HTMLElement>(`#episode-${CSS.escape(episodeId)}`);
  if (!episode) return;
  const details = episode.querySelector<HTMLDetailsElement>(`.${selector}`);
  if (details && openDetails) details.open = true;
  episode.scrollIntoView({ behavior: "smooth", block: "start" });
  if (details && !openDetails) details.open = true;
}

function domainsCard(domains: Json[]): HTMLElement {
  const card = cardShell("Top domains", "Ranked by observed foreground duration.");
  if (!domains.length) { card.append(empty("No domains recorded.")); return card; }
  const list = scrollRegion(el("div", "bar-list"), "Top domains"); const maximum = domains[0]!.activeDurationMs || 1;
  domains.slice(0,8).forEach((item) => list.append(barRow(item.domain, duration(item.activeDurationMs), item.activeDurationMs/maximum)));
  card.append(list); return card;
}

type EpisodeFilter = "all" | "ideas" | "outputs" | "annotated" | "review";

function episodesCard(episodes: Json[], outputs: Json[], annotations: Json[], corrections: Json[], intervals: EpisodeIntervalView[], ideas: Json[]): HTMLElement {
  const card = cardShell("Research episodes", "Review the strongest signals first; open an episode for its pages and grouping evidence.", "wide episodes-card");
  const toolbar = el("div", "episode-toolbar");
  const filters = el("div", "episode-filters");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "Filter research episodes");
  const status = el("span", "episode-filter-status");
  status.setAttribute("aria-live", "polite");
  const list = scrollRegion(el("div", "episode-list"), "Research episodes", "tall");
  let activeFilter: EpisodeFilter = "all";

  const filterDefinitions: Array<[EpisodeFilter, string]> = [
    ["all", "All"],
    ["ideas", "With ideas"],
    ["outputs", "With outputs"],
    ["annotated", "Annotated"],
    ["review", "Needs review"],
  ];

  const matchesFilter = (episode: Json): boolean => {
    const episodeAnnotations = annotations.filter((annotation) => annotation.episodeId === episode.episodeId);
    if (activeFilter === "ideas") return episode.ideaCount > 0;
    if (activeFilter === "outputs") return episode.outputCount > 0;
    if (activeFilter === "annotated") return episodeAnnotations.length > 0;
    if (activeFilter === "review") return episode.topicLabel === "unlabelled research"
      || episode.topicConfidence < 0.5
      || episodeAnnotations.some((annotation) => annotation.label === "misclassified");
    return true;
  };

  const renderList = (): void => {
    const visible = episodes.filter(matchesFilter);
    status.textContent = `${visible.length} of ${countLabel(episodes.length, "episode")}`;
    list.replaceChildren();
    if (!visible.length) {
      list.append(empty(episodes.length ? "No episodes match this filter." : "No episode evidence for this day."));
      return;
    }
    visible.forEach((episode) => list.append(episodeItem(episode, outputs, annotations, corrections, intervals, ideas, episodes.indexOf(episode) > 0)));
  };

  filterDefinitions.forEach(([value, text]) => {
    const button = el("button", `filter-chip${value === activeFilter ? " active" : ""}`, text);
    button.type = "button";
    button.setAttribute("aria-pressed", String(value === activeFilter));
    button.addEventListener("click", () => {
      activeFilter = value;
      filters.querySelectorAll<HTMLButtonElement>("button").forEach((candidate) => {
        const selected = candidate === button;
        candidate.classList.toggle("active", selected);
        candidate.setAttribute("aria-pressed", String(selected));
      });
      renderList();
    });
    filters.append(button);
  });

  toolbar.append(filters, status);
  card.append(toolbar, list);
  renderList();
  return card;
}

function episodeItem(episode: Json, outputs: Json[], annotations: Json[], corrections: Json[], intervals: EpisodeIntervalView[], ideas: Json[], hasPrevious: boolean): HTMLElement {
  const item = el("article", "episode");
  item.id = `episode-${episode.episodeId}`;
  item.dataset.episodeId = episode.episodeId;
  const head = el("div", "episode-header");
  const heading = el("div", "episode-heading");
  heading.append(el("h3", "", episode.topicLabel), el("time", "", `${clock(episode.startedAt)}–${clock(episode.endedAt)}`));
  const durationValue = el("strong", "episode-duration", formatDuration(episode.activeDurationMs));
  head.append(heading, durationValue);

  const meta = el("div", "episode-meta");
  [
    countLabel(episode.uniqueDomains, "domain"),
    countLabel(episode.tabSwitchCount, "tab switch"),
    countLabel(episode.ideaCount, "idea"),
    countLabel(episode.outputCount, "output"),
  ].forEach((value) => meta.append(el("span", "", value)));

  const pageSummaries = summarizeEpisodePages(episode.intervalIds, intervals);
  const domains = [...new Set(pageSummaries.map((page) => page.domain).filter(Boolean))];
  const context = el("p", "episode-context", domains.length ? domains.slice(0, 4).join(" · ") : "Private or excluded context");
  if (domains.length > 4) context.append(` · +${domains.length - 4} more`);

  const linked = outputs.filter((output) => output.episodeId === episode.episodeId);
  const relatedIdeas = ideas.filter((idea) => idea.episodeId === episode.episodeId);
  const signals = el("div", "episode-signals");
  relatedIdeas.forEach((idea) => signals.append(el("p", "episode-idea", `“${idea.text}”`)));
  linked.forEach((output) => signals.append(el("p", "episode-output", `↗ ${output.title || output.reference || "Local output"}`)));

  const existing = annotations.filter((annotation) => annotation.episodeId === episode.episodeId);
  const annotationList = el("div", "annotation-list");
  existing.forEach((annotation) => annotationList.append(el("p", "", `${labelText(annotation.label)}${annotation.note ? ` — ${annotation.note}` : ""}`)));

  const details = el("details", "episode-details");
  const detailsSummary = el("summary", "", `${countLabel(pageSummaries.length, "page")} and grouping evidence`);
  const pages = el("ol", "episode-pages");
  pageSummaries.forEach((page) => {
    const row = el("li", "episode-page");
    const pageTitle = el("span", "episode-page-title", page.title);
    const pageMeta = el("small", "", [
      clock(page.startedAt),
      page.domain || "excluded",
      page.visits > 1 ? countLabel(page.visits, "visit") : null,
      formatDuration(page.durationMs),
    ].filter(Boolean).join(" · "));
    row.append(pageTitle, pageMeta);
    pages.append(row);
  });
  const evidence = el("ul", "evidence");
  episode.evidence.forEach((value: string) => evidence.append(el("li", "", value)));
  details.append(detailsSummary, pages, evidence);

  const annotationDisclosure = el("details", "annotation-disclosure");
  annotationDisclosure.append(el("summary", "", existing.length ? "Add another annotation" : "Add annotation"));
  annotationDisclosure.append(annotationEditor(episode));

  const correctionDisclosure = el("details", "annotation-disclosure correction-disclosure");
  correctionDisclosure.append(el("summary", "", "Correct grouping or topic"));
  correctionDisclosure.append(episodeCorrectionEditor(episode, corrections, intervals, hasPrevious));

  item.append(head, meta, context);
  if (signals.childElementCount) item.append(signals);
  if (annotationList.childElementCount) item.append(annotationList);
  item.append(details, annotationDisclosure, correctionDisclosure);
  return item;
}

function episodeCorrectionEditor(episode: Json, corrections: Json[], intervals: EpisodeIntervalView[], hasPrevious: boolean): HTMLElement {
  const editor = el("div", "correction-editor");
  const relevant = corrections.filter((correction) => episode.intervalIds.includes(correction.anchorIntervalId));
  if (relevant.length) {
    const list = el("div", "correction-list");
    relevant.forEach((correction) => {
      const row = el("div", "correction-row");
      row.append(el("span", "", correction.correctionType === "rename" ? `Topic renamed to “${correction.label}”` : labelText(correction.correctionType)));
      const undo = el("button", "secondary", "Undo");
      undo.type = "button";
      undo.addEventListener("click", async () => {
        await api(`/api/episode-corrections/${encodeURIComponent(correction.correctionId)}`, { method: "DELETE" });
        await load();
        showNotice("Episode correction removed.");
      });
      row.append(undo);
      list.append(row);
    });
    editor.append(list);
  }

  const rename = inputField("Corrected topic label", episode.topicLabelSource === "user" ? episode.topicLabel : "");
  const renameButton = el("button", "secondary", "Rename topic");
  renameButton.type = "button";
  renameButton.addEventListener("click", async () => {
    if (!rename.input.value.trim()) return;
    await saveEpisodeCorrection(episode.episodeId, { correctionType: "rename", label: rename.input.value });
  });
  const renameRow = el("div", "correction-action");
  renameRow.append(rename.wrapper, renameButton);
  editor.append(renameRow);

  if (episode.intervalIds.length > 1) {
    const splitField = el("label", "field");
    const splitSelect = el("select", "") as HTMLSelectElement;
    const intervalsById = new Map(intervals.map((interval) => [interval.intervalId, interval]));
    episode.intervalIds.slice(1).forEach((intervalId: string) => {
      const interval = intervalsById.get(intervalId);
      const option = el("option", "", `${interval ? clock(interval.startedAt) : "Later"} · ${interval?.title || interval?.domain || "Private context"}`) as HTMLOptionElement;
      option.value = intervalId;
      splitSelect.append(option);
    });
    splitField.append(el("span", "", "Start a new episode before"), splitSelect);
    const splitButton = el("button", "secondary", "Split episode");
    splitButton.type = "button";
    splitButton.addEventListener("click", async () => saveEpisodeCorrection(episode.episodeId, { correctionType: "split_before", beforeIntervalId: splitSelect.value }));
    const splitRow = el("div", "correction-action");
    splitRow.append(splitField, splitButton);
    editor.append(splitRow);
  }

  if (hasPrevious) {
    const mergeButton = el("button", "secondary", "Merge with previous episode");
    mergeButton.type = "button";
    mergeButton.addEventListener("click", async () => saveEpisodeCorrection(episode.episodeId, { correctionType: "merge_before" }));
    editor.append(mergeButton);
  }
  return editor;
}

async function saveEpisodeCorrection(episodeId: string, correction: Json): Promise<void> {
  await api(`/api/episodes/${encodeURIComponent(episodeId)}/corrections`, { method: "POST", body: JSON.stringify(correction) });
  await load();
  showNotice("Episode correction saved and derivations rebuilt.");
}

function annotationEditor(episode: Json): HTMLElement {
  const editor = el("div", "annotation-editor");
  const labelField = el("label", "annotation-field");
  const label = el("select", "") as HTMLSelectElement;
  const placeholder = el("option", "", "Choose label") as HTMLOptionElement;
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = true;
  label.append(placeholder);
  ["useful", "unproductive", "exploratory", "deep_work", "administrative", "learning", "idea_generating", "interrupted", "misclassified", "private_or_excluded"].forEach((value) => {
    const option = el("option", "", labelText(value)) as HTMLOptionElement;
    option.value = value;
    label.append(option);
  });
  labelField.append(el("span", "annotation-field-label", "Label"), label);

  const noteField = el("label", "annotation-field");
  const note = el("input", "") as HTMLInputElement;
  note.placeholder = "Optional note";
  noteField.append(el("span", "annotation-field-label", "Note"), note);

  const save = el("button", "secondary", "Save annotation");
  save.type = "button";
  save.disabled = true;
  label.addEventListener("change", () => { save.disabled = !label.value; });
  save.addEventListener("click", async () => {
    if (!label.value) return;
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      await api(`/api/episodes/${encodeURIComponent(episode.episodeId)}/annotations`, { method: "POST", body: JSON.stringify({ label: label.value, note: note.value }) });
      await load();
      showNotice("Episode annotation saved locally.");
    } finally {
      save.disabled = false;
      save.textContent = "Save annotation";
    }
  });
  editor.append(labelField, noteField, save);
  return editor;
}

function outputsCard(outputs:Json[]):HTMLElement{const card=cardShell("Linked outputs","Local Git commits associated by time; proximity is evidence, not causation.");const list=scrollRegion(el("div","output-list"),"Linked outputs");if(!outputs.length)list.append(empty("No local outputs collected for this day."));outputs.forEach((output)=>{const item=el("article","output");item.append(el("strong","",output.title||"Untitled output"),el("small","",`${clock(output.occurredAt)} · ${output.repository||output.sourceConnector}${output.reference?` · ${String(output.reference).slice(0,8)}`:""}`),el("p","",output.associationReason||"Not linked to an episode"));list.append(item)});card.append(list);return card}

function focusCard(periods:FocusPeriodView[]):HTMLElement{const contexts=summarizeFocusPeriods(periods);const card=cardShell("Focus by context","Total observed foreground time across distinct focus periods.");const list=scrollRegion(el("div","bar-list"),"Focus by context");const max=Math.max(1,...contexts.map((context)=>context.durationMs));if(!contexts.length)list.append(empty("No focus periods derived."));contexts.slice(0,10).forEach((context)=>list.append(barRow(context.domain||"Mixed context",duration(context.durationMs),context.durationMs/max,countLabel(context.periodCount,"period"))));card.append(list);return card}

function boundariesCard(boundaries:Json[]):HTMLElement{const card=cardShell("State boundaries","Idle, browser-focus, and tracking transitions that start or stop active time.");const list=scrollRegion(el("div","boundary-list"),"State boundaries");if(!boundaries.length)list.append(empty("No state boundaries recorded."));boundaries.forEach((boundary)=>{const row=el("p","");row.append(el("time","",clock(boundary.occurredAt)),el("span","",labelText(boundary.eventType)));list.append(row)});card.append(list);return card}

function ideasCard(ideas: Json[]): HTMLElement {
  const card = cardShell("Captured ideas", "Explicit thoughts, linked to their browsing context."); const list = scrollRegion(el("div","idea-list"), "Captured ideas");
  if (!ideas.length) list.append(empty("No ideas captured on this day."));
  ideas.forEach((idea) => { const item=el("article","idea"); item.append(el("p","",idea.text),el("small","",`${clock(idea.capturedAt)}${idea.episodeId?" · linked to episode":""}`)); const tags=el("div",""); idea.tags.forEach((tag:string)=>tags.append(el("span","tag",tag))); item.append(tags); list.append(item); });
  card.append(list); return card;
}

function renderRange(data: Json): void {
  const rangeLabel = `${data.from} to ${data.to} · ${data.timeZone} · ${labelText(data.mode)}`;
  const metrics=el("section","metric-grid"); metrics.append(metric("Active foreground",duration(data.metrics.activeDurationMs),rangeLabel),metric("Median focus",duration(data.metrics.medianFocusDurationMs),"Derived, version 1"),metric("Tab transitions",String(data.metrics.tabSwitchCount),"Observed transitions"),metric("Domain transitions",String(data.metrics.domainSwitchCount),"Observed transitions"),metric("Unique context boundaries",String(data.metrics.uniqueContextBoundaryCount),"A tab or domain boundary, counted once"),metric("Linked outputs",String(data.metrics.outputCount),`${data.metrics.outputLinkedEpisodeCount} linked episodes`));
  const grid=el("section","grid"); const chart=cardShell("Activity by day",`Observed foreground duration · ${rangeLabel}. Height is not a productivity score.` ,"wide"); const bars=el("div","range-chart"); const summaries=el("div","chart-summary"); const max=Math.max(1,...data.daily.map((day:Json)=>day.activeDurationMs)); data.daily.forEach((day:Json)=>{const wrapper=el("div","day-bar");const bar=el("i","");bar.style.height=`${Math.max(1,(day.activeDurationMs/max)*100)}%`;bar.title=`${day.date}: ${duration(day.activeDurationMs)}`;bar.setAttribute("role","img");bar.setAttribute("aria-label",`${day.date}: ${duration(day.activeDurationMs)} observed foreground duration`);wrapper.append(bar,el("span","",day.date.slice(5)));bars.append(wrapper);summaries.append(el("span","",`${day.date}: ${duration(day.activeDurationMs)}`));});chart.append(bars,summaries);grid.append(chart,timeOfDayCard(data.activityByHour),domainsCard(data.topDomains),topicsCard(data.topics),revisitsCard(data.revisitedPages));content.replaceChildren(metrics,grid);
}

function topicsCard(topics: Json[]): HTMLElement { const card=cardShell("Topics explored","Deterministic labels inferred from titles and URLs.");const list=scrollRegion(el("div","bar-list"),"Topics explored");const max=topics[0]?.activeDurationMs||1;if(!topics.length)list.append(empty("No topic evidence."));topics.forEach((item)=>list.append(barRow(item.topic,duration(item.activeDurationMs),item.activeDurationMs/max)));card.append(list);return card; }
function revisitsCard(items: Json[]): HTMLElement { const card=cardShell("Revisited pages","Repeated canonical URLs in this window.");const list=scrollRegion(el("div","bar-list"),"Revisited pages");if(!items.length)list.append(empty("No repeated pages."));items.forEach((item)=>list.append(barRow(item.title||safeHostname(item.url),`${item.visits} intervals`,Math.min(1,item.visits/5))));card.append(list);return card; }
function timeOfDayCard(hours:Json[]):HTMLElement{const card=cardShell("Time-of-day pattern",`Active foreground duration by local hour (${timeZone}). Values are available as text below.`,"wide");const chart=el("div","hour-chart");const summary=el("div","chart-summary");const max=Math.max(1,...hours.map((hour)=>hour.activeDurationMs));hours.forEach((hour)=>{const bar=el("div","hour-column");const fill=el("i","");fill.style.height=`${Math.max(1,(hour.activeDurationMs/max)*100)}%`;fill.title=`${String(hour.hour).padStart(2,"0")}:00 · ${duration(hour.activeDurationMs)}`;bar.setAttribute("role","img");bar.setAttribute("aria-label",`${String(hour.hour).padStart(2,"0")}:00 · ${duration(hour.activeDurationMs)}`);bar.append(fill,el("span","",String(hour.hour).padStart(2,"0")));chart.append(bar);if(hour.activeDurationMs>0)summary.append(el("span","",`${String(hour.hour).padStart(2,"0")}:00 ${duration(hour.activeDurationMs)}`));});if(!summary.childElementCount)summary.append(el("span","","No observed foreground duration in this range."));card.append(chart,summary);return card}

async function renderSettings(): Promise<void> {
  const [settings,profiles,history,control]=await Promise.all([api("/api/settings"),api("/api/profiles"),api(`/api/history/summary?timezone=${encodeURIComponent(timeZone)}`),api("/api/control")]); const grid=el("section","settings-grid");
  const privacy=cardShell("Exclusions & redaction","Collector-enforced rules. One domain or URL pattern per line.");
  const domains=textareaField("Excluded domains",settings.privacy.excludedDomains.join("\n")); const patterns=textareaField("Excluded URL patterns",settings.privacy.excludedUrlPatterns.join("\n")); const mode=selectField("Query-string values",[["all","Redact all values"],["sensitive","Sensitive keys only"],["none","Keep non-sensitive values"]],settings.privacy.redactQueryValues);
  const incognito=checkField("Allow incognito metadata when the extension is explicitly enabled there",settings.privacy.allowIncognito); const save=el("button","primary","Save privacy rules"); save.addEventListener("click",async()=>{await api("/api/settings",{method:"PUT",body:JSON.stringify({privacy:{excludedDomains:domains.input.value.split(/\r?\n/).filter(Boolean),excludedUrlPatterns:patterns.input.value.split(/\r?\n/).filter(Boolean),redactQueryValues:mode.input.value,allowIncognito:incognito.input.checked}})});showNotice("Privacy settings saved locally.")}); privacy.append(domains.wrapper,patterns.wrapper,mode.wrapper,incognito.wrapper,save);
  const imports=cardShell("Historical import",`${history.caveat} Local-time history pattern uses ${timeZone}.`); const select=el("select","") as HTMLSelectElement; profiles.profiles.forEach((profile:Json)=>{const option=el("option","",`${profile.browser} · ${profile.profileName}`) as HTMLOptionElement;option.value=profile.profileId;select.append(option)}); const field=el("label","field");field.append(el("span","","Discovered profile"),select);const historyStatus=el("p","card-subtitle",profiles.profiles.length?`${history.visits} visits currently stored.`:"No Chrome or Brave profiles found at standard locations.");const importButton=el("button","secondary","Import safe snapshot");importButton.toggleAttribute("disabled",!profiles.profiles.length);importButton.addEventListener("click",async()=>{showNotice("Importing copied History snapshot…");const report=await api("/api/import",{method:"POST",body:JSON.stringify({profileId:select.value})});const refreshed=await api(`/api/history/summary?timezone=${encodeURIComponent(timeZone)}`);historyStatus.textContent=`${refreshed.visits} visits currently stored.`;showNotice(`Imported ${report.visitsInserted} new visits. ${report.historicalDurationCaveat}`)});imports.append(field,importButton,historyStatus);
  const git=cardShell("Local Git outputs","Collect commit metadata from one local calendar day. Only repository name, commit ID, title, time, and author are stored.");const repo=inputField("Repository path","/path/to/repository");repo.input.value=settings.connectors.git.repositoryPath||"";const localWindow=calendarDayWindow(dateInput.value,timeZone);const gitFrom=inputField("From (local day converted to UTC)","");gitFrom.input.value=localWindow.start;const gitTo=inputField("To (local day converted to UTC)","");gitTo.input.value=localWindow.end;const association=inputField("Association window (minutes)","30");association.input.type="number";association.input.min="0";association.input.max="1440";association.input.value=String(settings.connectors.git.associationWindowMinutes??30);const collect=el("button","secondary","Collect Git outputs");collect.addEventListener("click",async()=>{try{showNotice("Reading local Git commit metadata…");const result=await api("/api/connectors/git",{method:"POST",body:JSON.stringify({repositoryPath:repo.input.value,from:gitFrom.input.value,to:gitTo.input.value,associationWindowMinutes:Number(association.input.value)})});showNotice(`Collected ${result.collected} commits, stored ${result.inserted} new outputs, and linked ${result.outputLinks} to episodes.`)}catch(error){showNotice(error instanceof Error?error.message:"Could not collect Git outputs.")}});git.append(repo.wrapper,gitFrom.wrapper,gitTo.wrapper,association.wrapper,collect);
  const tracking=cardShell("Tracking control","Collector-enforced immediately; the extension mirrors this state on its next control sync.");const trackingState=el("p","control-state",control.trackingEnabled?"Tracking active":"Tracking paused");const trackingButton=el("button",control.trackingEnabled?"danger":"primary",control.trackingEnabled?"Pause tracking":"Resume tracking");trackingButton.addEventListener("click",async()=>{const next=await api("/api/control",{method:"PUT",body:JSON.stringify({trackingEnabled:!control.trackingEnabled})});control.trackingEnabled=next.trackingEnabled;trackingState.textContent=next.trackingEnabled?"Tracking active":"Tracking paused";trackingButton.textContent=next.trackingEnabled?"Pause tracking":"Resume tracking";trackingButton.className=next.trackingEnabled?"danger":"primary";showNotice(next.trackingEnabled?"Tracking resumed. The extension will synchronize shortly.":"Tracking paused at the collector. New activity batches are discarded.")});tracking.append(trackingState,trackingButton);
  const retention=cardShell("Retention","Raw and derived records remain until you delete them; automatic irreversible compaction is disabled.");retention.append(el("p","control-state",`${settings.retention.mode} · manual deletion and export controls below`));
  const controls=cardShell("Delete & export","Deletion rebuilds derived intervals and episodes. Export is explicit and stays local.");const delDomain=inputField("Delete by domain","example.com");const from=inputField("From (ISO timestamp)","");const to=inputField("To (ISO timestamp)","");const actions=el("div","actions");const deleteButton=el("button","danger","Delete matching data");deleteButton.addEventListener("click",async()=>{if(!confirm("Permanently delete matching raw and derived data?"))return;const result=await api("/api/data",{method:"DELETE",body:JSON.stringify({domain:delDomain.input.value||undefined,from:from.input.value||undefined,to:to.input.value||undefined})});showNotice(`Deleted ${result.activityEventsDeleted} events and ${result.historicalVisitsDeleted} historical visits.`)});const exportButton=el("button","secondary","Export JSON");exportButton.addEventListener("click",downloadExport);const tokenButton=el("button","secondary","Change dashboard token");tokenButton.addEventListener("click",()=>{token="";localStorage.removeItem("chromelens-token");requireToken()});actions.append(deleteButton,exportButton,tokenButton);controls.append(delDomain.wrapper,from.wrapper,to.wrapper,actions);
  const llm=analysisExportCard(settings.llm);
  grid.append(privacy,tracking,retention,imports,git,controls,llm);content.replaceChildren(grid);
}

function analysisExportCard(llmSettings: Json): HTMLElement {
  const card = cardShell("LLM analysis export", "Preview the exact, range-limited payload before sharing it with a model you choose.", "llm-export");
  const message = el("p", "analysis-guidance", llmSettings.message);
  const fields = el("div", "analysis-fields");
  const from = inputField("From", "");
  from.input.type = "date";
  from.input.value = shiftCalendarDate(dateInput.value, -6);
  const to = inputField("To", "");
  to.input.type = "date";
  to.input.value = dateInput.value;
  const privacy = selectField("Privacy profile", [
    ["aggregate", "Aggregate — domains and durations only"],
    ["contextual", "Contextual — add titles, ideas, outputs, and notes"],
    ["detailed", "Detailed — also include retained URLs"],
  ], "aggregate");
  const format = selectField("Format", [["markdown", "Markdown"], ["jsonl", "JSONL"]], "markdown");
  const budget = inputField("Approximate token budget", "50000");
  budget.input.type = "number";
  budget.input.min = "500";
  budget.input.max = "200000";
  budget.input.value = "50000";
  fields.append(from.wrapper, to.wrapper, privacy.wrapper, format.wrapper, budget.wrapper);

  const status = el("p", "analysis-status", "Aggregate mode omits titles, URL paths, idea text, output titles, and annotation notes.");
  const preview = el("textarea", "analysis-preview") as HTMLTextAreaElement;
  preview.readOnly = true;
  preview.hidden = true;
  preview.setAttribute("aria-label", "Exact LLM analysis export preview");
  const actions = el("div", "actions");
  const previewButton = el("button", "secondary", "Preview exact payload");
  previewButton.type = "button";
  const downloadButton = el("button", "primary", "Download analysis pack");
  downloadButton.type = "button";
  downloadButton.disabled = true;
  let previewedArtifact: Json | null = null;
  let previewedQuery = "";

  const query = (): string => analysisExportQuery({
    from: from.input.value,
    to: to.input.value,
    privacy: privacy.input.value,
    format: format.input.value,
    maxTokens: budget.input.value,
  });
  const invalidatePreview = (): void => {
    previewedArtifact = null;
    previewedQuery = "";
    downloadButton.disabled = true;
    preview.hidden = true;
    preview.value = "";
    status.textContent = "Options changed. Preview the exact payload before download.";
  };
  [from.input, to.input, privacy.input, format.input, budget.input].forEach((input) => {
    input.addEventListener("input", invalidatePreview);
    input.addEventListener("change", invalidatePreview);
  });
  previewButton.addEventListener("click", async () => {
    const requestedQuery = query();
    invalidatePreview();
    previewButton.disabled = true;
    previewButton.textContent = "Preparing…";
    try {
      const artifact = await api(`/api/export/preview?${requestedQuery}`);
      preview.value = artifact.content;
      preview.hidden = false;
      previewedArtifact = artifact;
      previewedQuery = requestedQuery;
      downloadButton.disabled = false;
      status.textContent = `${artifact.estimatedTokens.toLocaleString()} estimated tokens · ${artifact.includedEpisodes} of ${artifact.totalEpisodes} episodes${artifact.truncated ? " · truncated to budget" : ""}.`;
    } finally {
      previewButton.disabled = false;
      previewButton.textContent = "Preview exact payload";
    }
  });
  downloadButton.addEventListener("click", () => {
    if (!previewedArtifact || previewedQuery !== query()) return invalidatePreview();
    downloadPreviewedArtifact(previewedArtifact);
  });
  actions.append(previewButton, downloadButton);
  card.append(message, fields, status, actions, preview);
  return card;
}

async function downloadExport(): Promise<void> { const response=await fetch("/api/export?format=json",{headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw new CollectorApiError(response.status,"Export local data",null);const blob=await response.blob();const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download=`chromelens-export-${new Date().toISOString().slice(0,10)}.json`;anchor.click();URL.revokeObjectURL(url); }
function downloadPreviewedArtifact(artifact:Json):void{const blob=new Blob([artifact.content],{type:artifact.mediaType});const objectUrl=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=objectUrl;anchor.download=artifact.filename;anchor.click();URL.revokeObjectURL(objectUrl)}
function analysisExportQuery(values:{from:string;to:string;privacy:string;format:string;maxTokens:string}):string{const query=new URLSearchParams({format:`llm-${values.format}`,from:values.from,to:values.to,timezone:timeZone,privacy:values.privacy,maxTokens:values.maxTokens});return query.toString()}
async function api(path:string,init:RequestInit={}):Promise<Json>{return requestApi(path,token,init)}
function requireToken():void { if(!tokenDialog.open)tokenDialog.showModal();content.replaceChildren(el("div","empty","Enter the local collector token to view data.")); }
function periodStep():number{if(view==="day")return 1;if(view==="week")return rangeModeInput.value==="rolling_30"?30:rangeModeInput.value==="rolling_7"?7:rangeModeInput.value==="calendar_month"?1:7;return 1}
function shiftDate(days:number):void{if(view==="month"||rangeModeInput.value==="calendar_month")dateInput.value=shiftCalendarMonth(dateInput.value,days);else dateInput.value=shiftCalendarDate(dateInput.value,days);void load()}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,className="",text=""):HTMLElementTagNameMap[K]{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node} function empty(text:string){return el("div","empty",text)}
function scrollRegion<T extends HTMLElement>(node:T,label:string,size:"standard"|"tall"="standard"):T{node.classList.add("scroll-region");if(size==="tall")node.classList.add("scroll-region-tall");node.tabIndex=0;node.setAttribute("role","region");node.setAttribute("aria-label",label);return node}
function cardShell(title:string,subtitle:string,extra=""):HTMLElement{const card=el("section",`card ${extra}`.trim());card.append(el("h2","",title),el("p","card-subtitle",subtitle));return card} function metric(label:string,value:string,note:string):HTMLElement{const node=el("article","metric");node.append(el("p","",label),el("strong","",value),el("small","",note));return node} function barRow(label:string,value:string,ratio:number,note=""):HTMLElement{const row=el("div","bar-row");row.append(el("span","",label),el("strong","",value));if(note)row.append(el("small","bar-row-note",note));const bar=el("div","bar");const fill=el("i","");fill.style.width=`${Math.max(1,Math.min(100,ratio*100))}%`;bar.append(fill);row.append(bar);return row}
function duration(ms:number):string{return formatDuration(ms)} function clock(iso:string):string{return new Intl.DateTimeFormat("en-GB",{timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(new Date(iso))} function number(value:number):string{return Number(value||0).toFixed(1)} function median(values:number[]):number{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]!:(sorted[mid-1]!+sorted[mid]!)/2}
function localCalendarDate(value:Date):string{const parts=new Intl.DateTimeFormat("en-GB",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(value);const part=(type:string)=>parts.find((item)=>item.type===type)!.value;return `${part("year")}-${part("month")}-${part("day")}`}
function shiftCalendarDate(date:string,days:number):string{const [year,month,day]=date.split("-").map(Number) as [number,number,number];return new Date(Date.UTC(year,month-1,day+days)).toISOString().slice(0,10)}
function shiftCalendarMonth(date:string,months:number):string{const [year,month,day]=date.split("-").map(Number) as [number,number,number];const target=new Date(Date.UTC(year,month-1+months,1));const lastDay=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();return `${target.getUTCFullYear()}-${String(target.getUTCMonth()+1).padStart(2,"0")}-${String(Math.min(day,lastDay)).padStart(2,"0")}`}
function minuteWithinCalendarDay(iso:string,date:string,isEnd:boolean):number{const value=new Date(iso);const localDate=localCalendarDate(value);if(localDate<date)return 0;if(localDate>date)return 1440;const parts=new Intl.DateTimeFormat("en-GB",{timeZone,hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).formatToParts(value);const part=(type:string)=>Number(parts.find((item)=>item.type===type)!.value);const minute=part("hour")*60+part("minute")+part("second")/60;return isEnd&&minute===0?1440:minute}
function labelText(value:string):string{return value.split("_").map((part)=>part[0]?.toUpperCase()+part.slice(1)).join(" ")}
function safeHostname(value:string|null|undefined):string{if(!value)return "Private context";try{return new URL(value).hostname}catch{return value}}
function showNotice(text:string):void{notice.textContent=text;notice.hidden=false}
function textareaField(label:string,value:string){const wrapper=el("label","field"),input=el("textarea","") as HTMLTextAreaElement;input.value=value;wrapper.append(el("span","",label),input);return{wrapper,input}} function inputField(label:string,placeholder:string){const wrapper=el("label","field"),input=el("input","") as HTMLInputElement;input.placeholder=placeholder;wrapper.append(el("span","",label),input);return{wrapper,input}} function selectField(label:string,values:string[][],selected:string){const wrapper=el("label","field"),input=el("select","") as HTMLSelectElement;values.forEach(([value,text])=>{const option=el("option","",text) as HTMLOptionElement;option.value=value!;option.selected=value===selected;input.append(option)});wrapper.append(el("span","",label),input);return{wrapper,input}} function checkField(label:string,checked:boolean){const wrapper=el("label","check"),input=el("input","") as HTMLInputElement;input.type="checkbox";input.checked=checked;wrapper.append(input,el("span","",label));return{wrapper,input}}

void load();
