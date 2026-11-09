# RAG-Fusion retrieval

## Actual hosted implementation

TypeScript/Express orchestrates Pinecone Documents API dense search and
PostgreSQL English full-text search. Pinecone `llama-text-embed-v2` produces
1,024-dimensional query embeddings; `bge-reranker-v2-m3` reranks the final
applicable shortlist. The configured Nebius generation model (default
`Qwen/Qwen3-30B-A3B-Instruct-2507`) now also generates search hints.

1. Run existing OS/symptom triage first. Clarification turns make **no retrieval
   or generation calls**. Confirmed context, original issue and attempted steps
   remain in the existing owner-scoped conversation storage.
2. Construct a canonical original query from the employee's original issue,
   confirmed device values and confirmed symptom. Omit unknown placeholders.
3. When enabled, ask Nebius for strict JSON containing at most three search
   phrasings, at most 700 characters each, with a 600-output-token ceiling.
   Reject extra fields, malformed/oversized output, unknown placeholders,
   unapproved vocabulary and changed negations. The vocabulary consists of the
   original/enhanced terms, generic search words and narrowly controlled topical
   synonyms. Every accepted hint is appended to the complete canonical anchor.
   Hints are **search inputs only**, not new employee facts or procedures.
4. Trim and case/whitespace-deduplicate hints and complete queries, including
   the original. Always retain the canonical original in multi-query mode.
   Generation timeout, provider/validation failure or duplicates-only output
   falls back to original plus deterministic enhancement, deduplicated and
   bounded by the same maximum. They may be identical, leaving one query.
5. Apply the shared [metadata policy](metadata-filtering.md) to every branch.
   The verified Documents API predicate and pre-limit SQL eligible-ID predicate
   preserve confirmed scope before branch/fusion budgets. For each distinct
   query, run dense and lexical branches independently.
   Each dense branch embeds one query, requests a bounded filtered catalog
   oversample (at most 512), then retains at most **40** eligible matches.
   Each lexical branch retrieves at most **40** rows ordered by
   PostgreSQL full-text relevance and stable ID. Lexical terms are bounded
   OR-connected keywords, with the existing Wi-Fi/wireless anchor for Wi-Fi.
   At most two query workers run concurrently (up to four channel operations).
6. Fuse **all successful query/channel ranking lists** by stable chunk ID:
   `RRF(chunk) = sum(1 / (60 + one_based_rank))`.
   A duplicate hit contributes only once within its list and does not advance
   subsequent distinct ranks. Duplicate query variants produce no extra lists.
   Never add raw dense, lexical or neural score scales. Equal fused scores use
   ascending stable ID as a deterministic tie-break.
7. Bound the combined fused shortlist to **24 IDs**, then load canonical text,
   platform and citation metadata once from synchronized PostgreSQL records.
   Missing mapped IDs are a synchronization/service error, not a corpus gap.
   Apply existing topic/platform/symptom filters after shortlisting.
8. Rerank applicable candidates against the **canonical original query**, never
   a generated hint. Validate returned evidence indexes and uniqueness. Select
   at most **five** chunks satisfying the unchanged **0.1** default relevance
   threshold. Fewer chunks are valid; never pad with unrelated evidence.
9. Preserve source-action grounding, citations, failed-step exclusions and
   honest escalation. Wi-Fi source-action selection remains restricted to
   numbered approved actions. True coverage gaps still hand off.

### Failure behavior

Failed alternative branches do not discard successful original/other-query
results. An empty successful result list is different from a failed call.
If every branch fails, or no evidence is returned while some branches failed,
return **503 service failure**, not a corpus-gap handoff. Reranker unavailability
also returns 503. Never expose provider bodies or raw upstream errors.

The single-query switch retains the prior deterministic enhanced search input,
but reranking still uses the canonical factual anchor. Multi-query may safely
degrade to one query when enhancement and original are identical.

## Server-only configuration

No new secrets, database columns, client settings or auth changes are required.
Existing Pinecone/Nebius Replit Secrets are reused. Defaults apply in both
development and production on republish; these optional server environment
variables override them:

| Variable | Default | Allowed values |
|---|---:|---|
| `RAG_FUSION_ENABLED` | `true` | `true` / `false` |
| `RAG_FUSION_MAX_QUERIES` | 4 | 1–4, **including original** |
| `RAG_FUSION_CONCURRENCY` | 2 | 1–2 query workers |
| `RAG_FUSION_GENERATION_TIMEOUT_MS` | 5000 | 100–8000 |
| `RAG_FUSION_BRANCH_TIMEOUT_MS` | 10000 | 100–15000 |
| `RAG_FUSION_TOTAL_TIMEOUT_MS` | 35000 | 1000–45000 |
| `RAG_TURN_TIMEOUT_MS` | 60000 | 1000–90000 |

Invalid configuration fails explicitly. Maximum-query-count 1 bypasses hint
generation. A branch budget covers embedding plus dense search, or lexical
retrieval, respectively. The retrieval budget covers hint generation, branch
work, metadata mapping and reranking. The whole-turn budget also covers answer
generation and semantic failed-action checks. HTTP receives abort signals;
PostgreSQL retrieval uses read-only transactions, five-second server statement
timeouts and destroys checked-out retrieval connections on overall cancellation.
Late pool acquisitions are released. No retries multiply the request count.

Extra multi-query cost is bounded to one hint-generation request, up to four
query-embedding requests, four dense searches, four lexical searches and one
final neural rerank. Existing answer/failed-step calls still run under the
whole-turn deadline. Repeated turns regenerate hints; there is no query cache.
This is a call/token/latency bound, not a guaranteed monetary cost.

## Sanitized observability

`rag_fusion` events record mode, generation accepted/fallback/disabled, query
count, successful/failed channel branches, successful original branches,
aggregate candidate counts, unique fused/shortlist counts, and timings.
`rag_retrieval` retains applicability/relevance rejections, numeric rerank
scores and adds rerank/total-retrieval timings. Candidate totals can exceed
corpus size because they sum lists; fused counts are unique chunk IDs.

Never log query/variant text, source text/IDs, employee identifiers, raw device
values, provider response bodies, credentials or error objects. The separate
local evaluation helper outputs only explicitly synthetic test content.

## Verification and limits

- `rag-fusion.test.mjs`: 16 synthetic regression tests covering cross-query RRF,
  duplicate hits/queries, stable ties, bounded structured generation, invalid
  facts/negations/OS, generation fallback/timeouts, partial/all retrieval
  failures, concurrency, original rerank target, canonical metadata,
  unrelated-evidence exclusion, diagnostics and configuration.
- `wifi-triage.test.mjs`: nine existing triage/grounding/persistence tests.
- `corpus-validation.test.mjs`: 13 existing corpus/provider tests.
- The original **38** automated tests plus **16** metadata tests pass (54 total).
  Full type-check and API/frontend
  production builds passed, with existing nonblocking Vite warnings.
- See [measured synthetic comparison](rag-fusion-evaluation.md).

Run the test bundles with esbuild (externalize pg, pg-native, drizzle-orm,
drizzle-orm/*, zod and pino) then `node --test` as with the other server suites.
`rag-fusion.live.mjs` runs both modes against real providers and read-only
development corpus records. Its six checks per mode include the two
clarifications and four retrieval turns. It writes **no conversations**,
changes **no roles**, reads **no employee histories** and writes **no vectors**.
It is not authenticated endpoint/browser verification. Existing owner-scoped
persistence is regression-tested with fixtures; signed-in acceptance remains a
separate check requiring an authorized test session.

The source remains 33 approved records; multi-query generation cannot create a
missing procedure. Confirmed intermittent Wi-Fi disconnections remain a coverage
gap. A broader labeled evaluation is needed before claiming a quality gain.
