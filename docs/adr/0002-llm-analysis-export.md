# ADR 0002: LLM analysis export before model integration

Status: accepted — 2026-07-18

## Context

The archival JSON export contains raw and derived records, is unbounded, repeats evidence at several levels, and may include sensitive retained URLs or titles. Sending that export directly to a model would weaken ChromeLens's local-first privacy posture and make evidence attribution difficult. At the same time, daily summaries, deterministic episodes, explicit ideas, output links, and annotations form a useful structured reflection dataset.

## Decision

- Add a pure `analysis-pack` module that accepts selected daily evidence through one interface.
- Require an inclusive local calendar date range, IANA time zone, privacy profile, output format, and approximate token budget.
- Keep raw archival export separate.
- Provide aggregate, contextual, and detailed privacy profiles; aggregate is the default and full retained URLs require detailed opt-in.
- Render two adapters: human/LLM-friendly Markdown and programmatic JSONL.
- Include a manifest, daily records, self-contained episode records, evidence references, a SHA-256 record-payload hash, derivation versions, user-authored episode corrections, caveats, and an analysis guide.
- Treat browser-derived and user-authored strings as untrusted observations, never instructions.
- Preview the exact payload locally before download.
- Do not add a model client or automatic transmission path.

## Consequences

Users can analyze deliberately selected evidence with a model of their choice without coupling ChromeLens to a provider. The file remains sensitive and can leave the local-first trust boundary after download. Approximate token budgeting is intentionally provider-neutral and may differ from a particular model tokenizer. A future model adapter must preserve evidence references, record provider/model/prompt/input provenance, validate structured results, and store model-generated interpretation separately from observations and deterministic derivations.
