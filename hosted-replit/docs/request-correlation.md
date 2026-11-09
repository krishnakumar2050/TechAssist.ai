# Support request and retrieval correlation

## Scope and identity

This is observability, not idempotency. Every HTTP attempt receives a fresh
server UUID in `X-Request-ID`; caller headers do not select it. Pino HTTP
children inherit the async-local correlation mixin. Structured RAG diagnostics
also attach the current correlation explicitly.

`conversationId` is attached only after the authenticated owner-scoped database
lookup (or owner-assigned conversation creation) succeeds. Existing persisted
user/assistant message UUIDs are attached when available. No employee identity,
email, query text, generated phrasing, evidence text, credentials or raw provider
exception bodies are included in these diagnostics.

Each post-clarification RAG invocation receives a fresh `retrievalId`. Within
that invocation `v0`, `v1`, etc. are deterministic ordinals of distinct planned
queries. Each has `dense` and `lexical` branches. Separate async-local stores
isolate concurrent HTTP requests. A retrieval child scope shares its IDs with
nested operations, then returns its completed retrieval/assistant linkage to
its own parent request only.

No new tables, persisted turn IDs, credentials or migrations are required.
Existing advisory locking, rate limits, message persistence and retry behavior
are unchanged. A trailing identical pending user message can be reused, but
retrying a completed response can still create another turn. This is **not an
exactly-once guarantee**.

## Event contract

- `http_request_terminal`: one terminal event on response finish or disconnect,
  with status, HTTP status code and elapsed time.
- `http_request_error`, `chat_request_error`: bounded status/error codes and
  correlation, never exception payloads.
- `chat_turn_start`, `chat_turn_terminal`: application-turn lifecycle and
  available persisted message linkage, including clarification turns.
- `rag_retrieval_start`, `rag_retrieval_terminal`: one invocation lifecycle,
  including failures, timeouts and cancellation. Terminal metrics include
  generation/fallback state, retained generated-variant count, total planned
  query count, catalog/eligible/rejection counts, fusion/branch counts, reranking
  and selected evidence counts, and total invocation duration. Unknown catalog
  counts remain null until read; stages not reached retain zero counts.
- `rag_metadata`: validated normalized scope, catalog eligibility, rejection
  reasons and policy fingerprint.
- `rag_branch_start`, `rag_branch_terminal`: invocation + variant ordinal +
  channel, fingerprint/scope, bounded status/error code, duration and candidate
  count. Each started branch has one terminal event.
- `rag_fusion`: generation state, query/branch counts, aggregate candidates,
  fused/shortlist sizes, timing and policy identity.
- `rag_retrieval`: final mapping/applicability exclusions, reranking scores,
  threshold, selected evidence count and timing, with policy identity.

`generatedVariantCount` means validated complementary hints retained for search,
not raw/invalid/duplicate model output. `queryCount` includes the factual anchor
and/or existing deterministic fallback according to the unchanged query plan.
Successful empty lists count as successful branches; they are not provider errors.

The SHA-256 `filterFingerprint` is over sorted keys and canonicalized sets of the
**validated filter policy**, namespace, ready restriction and embedding
provider/model/dimensions. It does not hash employee queries. Scope fields are
allowlisted OS family/version, manufacturer/device/category/subcategory/language
enums and a freshness-configured flag. The same immutable policy identity is
passed to every branch. The fingerprint identifies policy, not a corpus revision
or a hash of the concrete provider predicate.

HTTP disconnection is observable but does not introduce a new inference-cancellation
or persistence policy. Existing backend work may finish after a client disconnects;
its turn/retrieval terminal events retain the original request ID.

## Streaming and employee errors

SSE remains `progress`, `token`, `done`, `error`, with existing heartbeat comments.
An additive `correlation` object appears on progress/done/error payloads. `done`
keeps the original conversation fields at the top level; JSON success responses
are unchanged. There is no SSE replay or event-resume protocol.

The frontend retains a UUID-validated `X-Request-ID` on SSE/JSON/early-close
service errors and offers **Copy support reference** in the error controls,
without adding implementation details to ordinary assistant prose.

## Verification (2026-11-09)

- 65 automated checks: 13 corpus/provider, 9 Wi-Fi, 16 fusion, 16 metadata and
  11 correlation checks.
- Correlation checks cover parallel isolation, nested scope and variant/channel
  linkage, canonical fingerprints, message linkage, fresh retry/header UUIDs,
  bounded error redaction, timeout/cancellation terminals and SSE compatibility.
- Six real-provider synthetic orchestration checks passed: missing-OS
  clarification, Windows symptom clarification, cited Wi-Fi action, distinct
  failed-step follow-up, cited camera guidance and unsupported-issue handoff.
  These use **memory-only synthetic conversations**, not employee histories or
  authenticated HTTP sessions. They do not write Pinecone or conversation data.
- First cited Wi-Fi synthetic request:
  `8de1f12c-1920-4d66-a3e7-502fcd5302fd`, retrieval
  `05e6e0f9-010d-424c-878c-0898389d4a1d`.
- Failed-step follow-up request:
  `a56bb6d5-43d6-46f7-809e-6cfb4042b34b`, retrieval
  `b1a9b822-73a1-45e8-b1aa-3be601974ef6`.
- Both retrieved with normalized `windows` / `11`, 22 eligible records, three
  retained hints + anchor, eight successful branches, zero failed branches,
  and one selected evidence chunk. All `v0`–`v3` dense branches returned 22
  candidates and lexical branches three, sharing fingerprint
  `9f6d73d70c7c03e21f2a98d59394ced85ed623da5bd7d2d7cb8127a3b5fcdc7f`.
  Both cited `TA-LAP-007-01`; the follow-up retained one failed attempt and
  returned a different step.

Signed-in HTTP/SSE and browser acceptance requires the user's existing authorized
session. Unit/fixture HTTP/SSE checks are not a substitute for that production
acceptance. Authentication/admin roles and evidence filters were not bypassed.
