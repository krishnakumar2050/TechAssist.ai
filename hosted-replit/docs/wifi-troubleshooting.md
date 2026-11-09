# Wi-Fi clarification and grounded troubleshooting

The built-in office Wi-Fi prompt is ambiguous. For Wi-Fi issues the server asks
one question per turn: operating system first, then complete Wi-Fi disconnection
versus remaining connected without internet, unless already explicitly supplied.
It does not infer Windows or infer a disconnection from the word “dropping”.

Each assistant message stores a structured triage snapshot alongside the existing
message JSON. This retains the original issue, pending question and confirmed
symptom. The confirmed OS also updates device context. Existing owner-scoped
conversation persistence saves and reloads these fields; no new SQL columns or
production schema migration are needed.

The factual query and fallback enhancement are deterministic, using the original
issue, known device values and controlled Wi-Fi synonyms/confirmed symptom.
Optional Nebius multi-query hints are vocabulary-validated search inputs, never
new user facts; the complete factual anchor is retained. See
[`rag-fusion.md`](rag-fusion.md). Lexical search uses bounded, sanitized OR terms,
ranked by PostgreSQL full-text relevance, with a mandatory Wi-Fi/wireless anchor
for Wi-Fi queries. Dense search and reciprocal-rank fusion remain in place.

Before neural reranking, exclude wrong-topic, incompatible-platform and
incompatible-symptom evidence. Preserve the relevance threshold (default 0.1)
and at most five evidence chunks. For Wi-Fi procedures, extract numbered actions
from the cited Resolution section. Nebius selects only a supplied action ID;
server code supplies the exact source action, source verification goal and
citations. It never accepts model-written resets, enterprise procedures or
settings navigation absent from the source. Failed/blocked actions are excluded
by exact and semantic comparisons. Exhausted or absent supported procedures
produce a clear IT handoff, not a repeated or fabricated check.

Retrieval diagnostics log only counts, query/branch totals, timings,
topic/platform families, numeric scores, threshold and rejection totals.
Never add query text, full device context,
source excerpts/IDs, conversation/user identifiers or provider bodies to logs.

## Verification

`wifi-triage.test.mjs` uses synthetic credentials, provider fixtures and an
owner-scoped persistence fixture. It covers OS/symptom clarifications, reloads,
citations, failed-step follow-ups, excluded evidence, coverage gaps, exhausted
actions, invalid action IDs and sanitized diagnostics. The existing corpus
validation suite remains relevant.

Live backend checks can use memory-only synthetic conversations with real
providers and read-only corpus retrieval. These do not constitute a signed-in
browser test or prove production acceptance. Never disable authentication,
create an administrator implicitly, or expose a testing route to obtain one.

After publishing, use an authorized signed-in employee or administrator to
verify the composer flow, restored conversation and device panel. Existing
Pinecone vectors must remain unchanged.
