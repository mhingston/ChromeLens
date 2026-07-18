type Json = Record<string, any>;

const content = document.querySelector<HTMLElement>("#content")!;
const dateInput = document.querySelector<HTMLInputElement>("#date")!;
const tokenDialog = document.querySelector<HTMLDialogElement>("#token-dialog")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
let token = localStorage.getItem("chromelens-token") ?? "";
let view = "day";
dateInput.value = new Date().toISOString().slice(0, 10);

document.querySelectorAll<HTMLButtonElement>(".nav-button").forEach((button) => button.addEventListener("click", () => {
  view = button.dataset.view ?? "day";
  document.querySelectorAll(".nav-button").forEach((item) => item.classList.toggle("active", item === button));
  void load();
}));
document.querySelector("#previous-date")!.addEventListener("click", () => shiftDate(-periodDays()));
document.querySelector("#next-date")!.addEventListener("click", () => shiftDate(periodDays()));
dateInput.addEventListener("change", () => void load());
document.querySelector<HTMLFormElement>("#token-form")!.addEventListener("submit", () => {
  token = document.querySelector<HTMLInputElement>("#dashboard-token")!.value.trim();
  localStorage.setItem("chromelens-token", token);
  window.setTimeout(() => void load(), 0);
});

async function load(): Promise<void> {
  const titles: Record<string, [string,string]> = {
    day:["DAILY LENS","A day in context."], week:["WEEKLY PATTERNS","Seven days, observed."],
    month:["MONTHLY PATTERNS","A wider field of view."], settings:["LOCAL CONTROLS","Privacy & data."],
  };
  document.querySelector("#view-kicker")!.textContent = titles[view]![0];
  document.querySelector("#view-title")!.textContent = titles[view]![1];
  document.querySelector<HTMLElement>("#date-controls")!.hidden = view === "settings";
  content.replaceChildren(el("div", "loading", "Focusing the lens…"));
  notice.hidden = true;
  try {
    if (!token) return requireToken();
    if (view === "day") renderDay(await api(`/api/summary/daily?date=${dateInput.value}`));
    else if (view === "week" || view === "month") renderRange(await api(`/api/summary/range?from=${dateInput.value}&days=${periodDays()}`));
    else await renderSettings();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) return requireToken();
    content.replaceChildren(el("div", "empty", error instanceof Error ? error.message : "Could not load local data."));
  }
}

function renderDay(data: Json): void {
  const metrics = el("section", "metric-grid");
  metrics.append(
    metric("Active foreground", duration(data.metrics.activeDurationMs), "Observed, not scored"),
    metric("Median focus", duration(median(data.focusPeriods.map((item: Json) => item.durationMs))), `${data.focusPeriods.length} focus periods`),
    metric("Tab switches", String(data.metrics.tabSwitchCount), "Observed transitions"),
    metric("Domain switches", String(data.metrics.domainSwitchCount), `${number(data.metrics.contextSwitchesPerActiveHour)} / active hour`),
    metric("Linked outputs", String(data.metrics.outputCount), "Local connector evidence"),
  );
  const grid = el("section", "grid");
  grid.append(timelineCard(data), focusCard(data.focusPeriods), boundariesCard(data.boundaries), domainsCard(data.topDomains), episodesCard(data.episodes,data.outputs,data.annotations,data.intervals), ideasCard(data.ideas), outputsCard(data.outputs));
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
    const start = new Date(interval.startedAt); const end = new Date(interval.endedAt);
    const startMinute = start.getUTCHours()*60+start.getUTCMinutes()+start.getUTCSeconds()/60;
    const endMinute = end.getUTCHours()*60+end.getUTCMinutes()+end.getUTCSeconds()/60;
    let lane = lanes.findIndex((last) => last <= startMinute); if (lane < 0) lane = lanes.length; lanes[lane] = endMinute;
    const item = el("button", "time-row", interval.title || interval.domain || "Untitled page");
    item.style.left = `${(startMinute/1440)*100}%`; item.style.width = `${Math.max(.55,((endMinute-startMinute)/1440)*100)}%`; item.style.top = `${lane*39+10}px`; item.style.setProperty("--domain-color", colors[index%colors.length]!);
    item.title = `${clock(interval.startedAt)}–${clock(interval.endedAt)} · ${interval.domain ?? "private"} · ${duration(interval.durationMs)}`;
    track.append(item);
  });
  const labels = el("div", "hour-labels"); ["00","04","08","12","16","20","24"].forEach((hour) => labels.append(el("span", "", hour)));
  card.append(track, labels); return card;
}

function domainsCard(domains: Json[]): HTMLElement {
  const card = cardShell("Top domains", "Ranked by observed foreground duration.");
  if (!domains.length) { card.append(empty("No domains recorded.")); return card; }
  const list = el("div", "bar-list"); const maximum = domains[0]!.activeDurationMs || 1;
  domains.slice(0,8).forEach((item) => list.append(barRow(item.domain, duration(item.activeDurationMs), item.activeDurationMs/maximum)));
  card.append(list); return card;
}

function episodesCard(episodes: Json[],outputs:Json[],annotations:Json[],intervals:Json[]): HTMLElement {
  const card = cardShell("Research episodes", "Deterministic groupings, output associations, and your annotations.");
  const list = el("div", "episode-list");
  if (!episodes.length) list.append(empty("No episode evidence for this day."));
  episodes.forEach((episode) => {
    const item = el("article", "episode"); const head = el("div", "episode-header");
    head.append(el("h3", "", episode.topicLabel), el("time", "", `${clock(episode.startedAt)}–${clock(episode.endedAt)}`));
    const meta = el("div", "episode-meta"); meta.append(el("span","",duration(episode.activeDurationMs)),el("span","",`${episode.uniqueDomains} domains`),el("span","",`${episode.tabSwitchCount} tab switches`),el("span","",`${episode.ideaCount} ideas`),el("span","",`${episode.outputCount} outputs`));
    const evidence = el("ul", "evidence"); episode.evidence.forEach((value: string) => evidence.append(el("li","",value)));
    const pages=el("ol","episode-pages");episode.intervalIds.map((id:string)=>intervals.find((interval)=>interval.intervalId===id)).filter(Boolean).forEach((interval:Json)=>pages.append(el("li","",`${clock(interval.startedAt)} ${interval.title||interval.domain||"Private context"} · ${interval.domain||"excluded"}`)));
    const details:HTMLElement[]=[];const linked=outputs.filter((output)=>output.episodeId===episode.episodeId);if(linked.length){const outputList=el("div","episode-links");linked.forEach((output)=>outputList.append(el("p","",`↗ ${output.title||output.reference||"Local output"} · ${output.associationReason}`)));details.push(outputList)}
    const existing=annotations.filter((annotation)=>annotation.episodeId===episode.episodeId);if(existing.length){const values=el("div","annotation-list");existing.forEach((annotation)=>values.append(el("p","",`${labelText(annotation.label)}${annotation.note?` — ${annotation.note}`:""}`)));details.push(values)}
    const editor=el("div","annotation-editor");const label=el("select","") as HTMLSelectElement;["useful","unproductive","exploratory","deep_work","administrative","learning","idea_generating","interrupted","misclassified","private_or_excluded"].forEach((value)=>{const option=el("option","",labelText(value)) as HTMLOptionElement;option.value=value;label.append(option)});const note=el("input","") as HTMLInputElement;note.placeholder="Optional note";const save=el("button","secondary","Annotate");save.addEventListener("click",async()=>{await api(`/api/episodes/${encodeURIComponent(episode.episodeId)}/annotations`,{method:"POST",body:JSON.stringify({label:label.value,note:note.value})});await load();showNotice("Episode annotation saved locally.")});editor.append(label,note,save);
    item.append(head,meta,evidence,pages,...details,editor); list.append(item);
  });
  card.append(list); return card;
}

function outputsCard(outputs:Json[]):HTMLElement{const card=cardShell("Linked outputs","Local Git commits associated by time; proximity is evidence, not causation.");const list=el("div","output-list");if(!outputs.length)list.append(empty("No local outputs collected for this day."));outputs.forEach((output)=>{const item=el("article","output");item.append(el("strong","",output.title||"Untitled output"),el("small","",`${clock(output.occurredAt)} · ${output.repository||output.sourceConnector}${output.reference?` · ${String(output.reference).slice(0,8)}`:""}`),el("p","",output.associationReason||"Not linked to an episode"));list.append(item)});card.append(list);return card}

function focusCard(periods:Json[]):HTMLElement{const card=cardShell("Focus-period distribution","Continuous topic/domain periods; shorter is descriptive, not worse.");const list=el("div","bar-list");const max=Math.max(1,...periods.map((period)=>period.durationMs));if(!periods.length)list.append(empty("No focus periods derived."));periods.slice(0,10).forEach((period)=>list.append(barRow(period.domain||"Mixed context",duration(period.durationMs),period.durationMs/max)));card.append(list);return card}

function boundariesCard(boundaries:Json[]):HTMLElement{const card=cardShell("State boundaries","Idle, browser-focus, and tracking transitions that start or stop active time.");const list=el("div","boundary-list");if(!boundaries.length)list.append(empty("No state boundaries recorded."));boundaries.forEach((boundary)=>{const row=el("p","");row.append(el("time","",clock(boundary.occurredAt)),el("span","",labelText(boundary.eventType)));list.append(row)});card.append(list);return card}

function ideasCard(ideas: Json[]): HTMLElement {
  const card = cardShell("Captured ideas", "Explicit thoughts, linked to their browsing context."); const list = el("div","idea-list");
  if (!ideas.length) list.append(empty("No ideas captured on this day."));
  ideas.forEach((idea) => { const item=el("article","idea"); item.append(el("p","",idea.text),el("small","",`${clock(idea.capturedAt)}${idea.episodeId?" · linked to episode":""}`)); const tags=el("div",""); idea.tags.forEach((tag:string)=>tags.append(el("span","tag",tag))); item.append(tags); list.append(item); });
  card.append(list); return card;
}

function renderRange(data: Json): void {
  const metrics=el("section","metric-grid"); metrics.append(metric("Active foreground",duration(data.metrics.activeDurationMs),`${data.days} day window`),metric("Median focus",duration(data.metrics.medianFocusDurationMs),"Derived, version 1"),metric("Context switches",String(data.metrics.tabSwitchCount+data.metrics.domainSwitchCount),`${number(data.metrics.contextSwitchesPerActiveHour)} / active hour`),metric("Ideas captured",String(data.metrics.ideaCount),"Explicit observations"),metric("Linked outputs",String(data.metrics.outputCount),`${data.metrics.outputLinkedEpisodeCount} linked episodes`));
  const grid=el("section","grid"); const chart=cardShell("Activity by day","Observed foreground duration; height is not a productivity score.","wide"); const bars=el("div","range-chart"); const max=Math.max(1,...data.daily.map((day:Json)=>day.activeDurationMs)); data.daily.forEach((day:Json)=>{const wrapper=el("div","day-bar");const bar=el("i","");bar.style.height=`${Math.max(1,(day.activeDurationMs/max)*100)}%`;bar.title=`${day.date}: ${duration(day.activeDurationMs)}`;wrapper.append(bar,el("span","",day.date.slice(5)));bars.append(wrapper)});chart.append(bars);grid.append(chart,timeOfDayCard(data.activityByHour),domainsCard(data.topDomains),topicsCard(data.topics),revisitsCard(data.revisitedPages));content.replaceChildren(metrics,grid);
}

function topicsCard(topics: Json[]): HTMLElement { const card=cardShell("Topics explored","Deterministic labels inferred from titles and URLs.");const list=el("div","bar-list");const max=topics[0]?.activeDurationMs||1;if(!topics.length)list.append(empty("No topic evidence."));topics.forEach((item)=>list.append(barRow(item.topic,duration(item.activeDurationMs),item.activeDurationMs/max)));card.append(list);return card; }
function revisitsCard(items: Json[]): HTMLElement { const card=cardShell("Revisited pages","Repeated canonical URLs in this window.");const list=el("div","bar-list");if(!items.length)list.append(empty("No repeated pages."));items.forEach((item)=>list.append(barRow(item.title||new URL(item.url).hostname,`${item.visits} intervals`,Math.min(1,item.visits/5))));card.append(list);return card; }
function timeOfDayCard(hours:Json[]):HTMLElement{const card=cardShell("Time-of-day pattern","Active foreground duration by UTC hour.","wide");const chart=el("div","hour-chart");const max=Math.max(1,...hours.map((hour)=>hour.activeDurationMs));hours.forEach((hour)=>{const bar=el("div","hour-column");const fill=el("i","");fill.style.height=`${Math.max(1,(hour.activeDurationMs/max)*100)}%`;fill.title=`${String(hour.hour).padStart(2,"0")}:00 · ${duration(hour.activeDurationMs)}`;bar.append(fill,el("span","",String(hour.hour).padStart(2,"0")));chart.append(bar)});card.append(chart);return card}

async function renderSettings(): Promise<void> {
  const [settings,profiles,history,control]=await Promise.all([api("/api/settings"),api("/api/profiles"),api("/api/history/summary"),api("/api/control")]); const grid=el("section","settings-grid");
  const privacy=cardShell("Exclusions & redaction","Collector-enforced rules. One domain or URL pattern per line.");
  const domains=textareaField("Excluded domains",settings.privacy.excludedDomains.join("\n")); const patterns=textareaField("Excluded URL patterns",settings.privacy.excludedUrlPatterns.join("\n")); const mode=selectField("Query-string values",[["all","Redact all values"],["sensitive","Sensitive keys only"],["none","Keep non-sensitive values"]],settings.privacy.redactQueryValues);
  const incognito=checkField("Allow incognito metadata when the extension is explicitly enabled there",settings.privacy.allowIncognito); const save=el("button","primary","Save privacy rules"); save.addEventListener("click",async()=>{await api("/api/settings",{method:"PUT",body:JSON.stringify({privacy:{excludedDomains:domains.input.value.split(/\r?\n/).filter(Boolean),excludedUrlPatterns:patterns.input.value.split(/\r?\n/).filter(Boolean),redactQueryValues:mode.input.value,allowIncognito:incognito.input.checked}})});showNotice("Privacy settings saved locally.")}); privacy.append(domains.wrapper,patterns.wrapper,mode.wrapper,incognito.wrapper,save);
  const imports=cardShell("Historical import",history.caveat); const select=el("select","") as HTMLSelectElement; profiles.profiles.forEach((profile:Json)=>{const option=el("option","",`${profile.browser} · ${profile.profileName}`) as HTMLOptionElement;option.value=profile.profileId;select.append(option)}); const field=el("label","field");field.append(el("span","","Discovered profile"),select);const historyStatus=el("p","card-subtitle",profiles.profiles.length?`${history.visits} visits currently stored.`:"No Chrome or Brave profiles found at standard locations.");const importButton=el("button","secondary","Import safe snapshot");importButton.toggleAttribute("disabled",!profiles.profiles.length);importButton.addEventListener("click",async()=>{showNotice("Importing copied History snapshot…");const report=await api("/api/import",{method:"POST",body:JSON.stringify({profileId:select.value})});const refreshed=await api("/api/history/summary");historyStatus.textContent=`${refreshed.visits} visits currently stored.`;showNotice(`Imported ${report.visitsInserted} new visits. ${report.historicalDurationCaveat}`)});imports.append(field,importButton,historyStatus);
  const git=cardShell("Local Git outputs","Collect commit metadata from one local repository. Only repository name, commit ID, title, time, and author are stored.");const repo=inputField("Repository path","/path/to/repository");repo.input.value=settings.connectors.git.repositoryPath||"";const gitFrom=inputField("From (ISO timestamp)","");gitFrom.input.value=`${dateInput.value}T00:00:00.000Z`;const gitTo=inputField("To (ISO timestamp)","");gitTo.input.value=new Date(Date.parse(gitFrom.input.value)+86_400_000).toISOString();const association=inputField("Association window (minutes)","30");association.input.type="number";association.input.min="0";association.input.max="1440";association.input.value=String(settings.connectors.git.associationWindowMinutes??30);const collect=el("button","secondary","Collect Git outputs");collect.addEventListener("click",async()=>{showNotice("Reading local Git commit metadata…");const result=await api("/api/connectors/git",{method:"POST",body:JSON.stringify({repositoryPath:repo.input.value,from:gitFrom.input.value,to:gitTo.input.value,associationWindowMinutes:Number(association.input.value)})});showNotice(`Collected ${result.collected} commits, stored ${result.inserted} new outputs, and linked ${result.outputLinks} to episodes.`)});git.append(repo.wrapper,gitFrom.wrapper,gitTo.wrapper,association.wrapper,collect);
  const tracking=cardShell("Tracking control","Collector-enforced immediately; the extension mirrors this state on its next control sync.");const trackingState=el("p","control-state",control.trackingEnabled?"Tracking active":"Tracking paused");const trackingButton=el("button",control.trackingEnabled?"danger":"primary",control.trackingEnabled?"Pause tracking":"Resume tracking");trackingButton.addEventListener("click",async()=>{const next=await api("/api/control",{method:"PUT",body:JSON.stringify({trackingEnabled:!control.trackingEnabled})});control.trackingEnabled=next.trackingEnabled;trackingState.textContent=next.trackingEnabled?"Tracking active":"Tracking paused";trackingButton.textContent=next.trackingEnabled?"Pause tracking":"Resume tracking";trackingButton.className=next.trackingEnabled?"danger":"primary";showNotice(next.trackingEnabled?"Tracking resumed. The extension will synchronize shortly.":"Tracking paused at the collector. New activity batches are discarded.")});tracking.append(trackingState,trackingButton);
  const retention=cardShell("Retention","Raw and derived records remain until you delete them; automatic irreversible compaction is disabled.");retention.append(el("p","control-state",`${settings.retention.mode} · manual deletion and export controls below`));
  const controls=cardShell("Delete & export","Deletion rebuilds derived intervals and episodes. Export is explicit and stays local.");const delDomain=inputField("Delete by domain","example.com");const from=inputField("From (ISO timestamp)","");const to=inputField("To (ISO timestamp)","");const actions=el("div","actions");const deleteButton=el("button","danger","Delete matching data");deleteButton.addEventListener("click",async()=>{if(!confirm("Permanently delete matching raw and derived data?"))return;const result=await api("/api/data",{method:"DELETE",body:JSON.stringify({domain:delDomain.input.value||undefined,from:from.input.value||undefined,to:to.input.value||undefined})});showNotice(`Deleted ${result.activityEventsDeleted} events and ${result.historicalVisitsDeleted} historical visits.`)});const exportButton=el("button","secondary","Export JSON");exportButton.addEventListener("click",downloadExport);const tokenButton=el("button","secondary","Change dashboard token");tokenButton.addEventListener("click",()=>{token="";localStorage.removeItem("chromelens-token");requireToken()});actions.append(deleteButton,exportButton,tokenButton);controls.append(delDomain.wrapper,from.wrapper,to.wrapper,actions);
  const llm=cardShell("Optional LLM reflection","Interpretation remains separate from observed evidence.");const off=el("div","llm-off");off.append(el("i",""),el("span","",settings.llm.message));llm.append(off);
  grid.append(privacy,tracking,retention,imports,git,controls,llm);content.replaceChildren(grid);
}

async function downloadExport(): Promise<void> { const response=await fetch("/api/export?format=json",{headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw new HttpError(response.status);const blob=await response.blob();const url=URL.createObjectURL(blob);const anchor=document.createElement("a");anchor.href=url;anchor.download=`chromelens-export-${new Date().toISOString().slice(0,10)}.json`;anchor.click();URL.revokeObjectURL(url); }
async function api(path:string,init:RequestInit={}):Promise<Json>{const response=await fetch(path,{...init,headers:{"content-type":"application/json",authorization:`Bearer ${token}`,...init.headers}});if(!response.ok)throw new HttpError(response.status);return response.json() as Promise<Json>}
class HttpError extends Error { constructor(readonly status:number){super(`Collector returned ${status}`)} }
function requireToken():void { if(!tokenDialog.open)tokenDialog.showModal();content.replaceChildren(el("div","empty","Enter the local collector token to view data.")); }
function periodDays():number{return view==="month"?30:view==="week"?7:1} function shiftDate(days:number):void{dateInput.value=new Date(Date.parse(`${dateInput.value}T00:00:00Z`)+days*86400000).toISOString().slice(0,10);void load()}
function el<K extends keyof HTMLElementTagNameMap>(tag:K,className="",text=""):HTMLElementTagNameMap[K]{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node} function empty(text:string){return el("div","empty",text)}
function cardShell(title:string,subtitle:string,extra=""):HTMLElement{const card=el("section",`card ${extra}`.trim());card.append(el("h2","",title),el("p","card-subtitle",subtitle));return card} function metric(label:string,value:string,note:string):HTMLElement{const node=el("article","metric");node.append(el("p","",label),el("strong","",value),el("small","",note));return node} function barRow(label:string,value:string,ratio:number):HTMLElement{const row=el("div","bar-row");row.append(el("span","",label),el("strong","",value));const bar=el("div","bar");const fill=el("i","");fill.style.width=`${Math.max(1,Math.min(100,ratio*100))}%`;bar.append(fill);row.append(bar);return row}
function duration(ms:number):string{if(!ms)return "0m";const hours=Math.floor(ms/3600000);const minutes=Math.round((ms%3600000)/60000);return hours?`${hours}h ${minutes}m`:`${minutes}m`} function clock(iso:string):string{return new Date(iso).toISOString().slice(11,16)} function number(value:number):string{return Number(value||0).toFixed(1)} function median(values:number[]):number{if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);return sorted.length%2?sorted[mid]!:(sorted[mid-1]!+sorted[mid]!)/2}
function labelText(value:string):string{return value.split("_").map((part)=>part[0]?.toUpperCase()+part.slice(1)).join(" ")}
function showNotice(text:string):void{notice.textContent=text;notice.hidden=false}
function textareaField(label:string,value:string){const wrapper=el("label","field"),input=el("textarea","") as HTMLTextAreaElement;input.value=value;wrapper.append(el("span","",label),input);return{wrapper,input}} function inputField(label:string,placeholder:string){const wrapper=el("label","field"),input=el("input","") as HTMLInputElement;input.placeholder=placeholder;wrapper.append(el("span","",label),input);return{wrapper,input}} function selectField(label:string,values:string[][],selected:string){const wrapper=el("label","field"),input=el("select","") as HTMLSelectElement;values.forEach(([value,text])=>{const option=el("option","",text) as HTMLOptionElement;option.value=value!;option.selected=value===selected;input.append(option)});wrapper.append(el("span","",label),input);return{wrapper,input}} function checkField(label:string,checked:boolean){const wrapper=el("label","check"),input=el("input","") as HTMLInputElement;input.type="checkbox";input.checked=checked;wrapper.append(input,el("span","",label));return{wrapper,input}}

void load();
