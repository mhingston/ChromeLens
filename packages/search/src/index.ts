export type SearchDocumentType = "interval" | "episode" | "idea" | "annotation" | "output" | "historical_page" | "historical_search";

export interface SearchDocument {
  type: SearchDocumentType;
  id: string;
  title: string;
  body: string;
  date: string | null;
  basis: "observed" | "derived" | "user_authored" | "association";
  target: string;
  profileId?: string;
}

export interface SearchResult extends SearchDocument {
  resultId: string;
  snippet: string;
  score: number;
}

export function searchDocuments(documents: readonly SearchDocument[], query: string, limit = 50): SearchResult[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  return documents.flatMap((document) => {
    const title = document.title.toLowerCase();
    const body = document.body.toLowerCase();
    const haystack = `${title} ${body}`;
    if (!terms.every((term) => haystack.includes(term))) return [];
    const score = terms.reduce((total, term) => total + (title.includes(term) ? 5 : 0) + (body.includes(term) ? 1 : 0), 0) + (haystack.includes(terms.join(" ")) ? 3 : 0);
    return [{ ...document, resultId: `search_${stableHash(`${document.type}:${document.id}`)}`, snippet: snippet(`${document.title} — ${document.body}`, terms), score }];
  }).sort((left, right) => right.score - left.score || (right.date ?? "").localeCompare(left.date ?? "") || left.title.localeCompare(right.title) || left.resultId.localeCompare(right.resultId)).slice(0, Math.max(1, Math.min(limit, 100)));
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 2))];
}

function snippet(value: string, terms: string[]): string {
  const compact = value.replace(/\s+/g, " ").trim();
  const index = Math.max(0, terms.map((term) => compact.toLowerCase().indexOf(term)).filter((candidate) => candidate >= 0).sort((left, right) => left - right)[0] ?? 0);
  const start = Math.max(0, index - 60);
  return `${start ? "…" : ""}${compact.slice(start, start + 220)}${start + 220 < compact.length ? "…" : ""}`;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
