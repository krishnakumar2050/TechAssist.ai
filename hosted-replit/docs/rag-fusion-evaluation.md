# Synthetic single-query versus RAG-Fusion comparison

Run against the development corpus and real configured Pinecone/Nebius
providers on 2026-11-09. The corpus had **33 ready documents / 33 chunks**.
Only synthetic questions and memory-only conversations were used. No employee
history, identity/role changes, persistent chat writes or Pinecone writes.

Both modes passed **six checks each** (12 total):

| Check | Single-query | Multi-query |
|---|---|---|
| “My laptop keeps dropping the office Wi-Fi” | Asks OS | Asks OS |
| Answer “Windows 11” | Asks disconnect vs connected/no internet | Same |
| “It stays connected to Wi-Fi but internet stops” | “Check connection status” | Same |
| Record failed outcome, then “Still not working” | “Compare another device on the same network” | Same |
| Windows 11 Camera app works, Teams preview black | “Check Windows camera access permissions for Microsoft Teams” | Same |
| Failing quantum entanglement stabilizer | Honest unsupported-issue handoff, no citations | Same |

Both Wi-Fi actions cite **TA-LAP-007-01**:
https://support.microsoft.com/en-us/windows/experience/connectivity-networking/fix-wi-fi-connection-issues-in-windows

Both camera answers cite **TA-LAP-008-01**:
https://support.microsoft.com/en-us/windows/hardware/camera/camera-doesn-t-work-in-windows

Both modes retained the original Wi-Fi issue, Windows 11 context, confirmed
connected/no-internet symptom and the failed first step across the follow-up.
This memory was in the synthetic conversation object, not a live signed-in
database conversation. Database save/reload and owner isolation were checked
by the automated fixture suite.

## Retrieval comparison

| Retrieval turn | Multi-query count / generation | Final evidence scores in both modes |
|---|---|---|
| Wi-Fi first step | 4 / accepted | 0.9403531 |
| Wi-Fi failed-step follow-up | 4 / accepted | 0.9403531 |
| Camera | 1 / safe fallback | 0.98087597, 0.96405166 |
| Unsupported issue | 4 / accepted | All five below 0.1; highest 0.012920474 |

Every retrieval turn in both modes fused **33 unique candidates**, shortlisted
24, and successfully mapped their canonical records. No retrieval branches
failed. Camera safely fell back to one query because no valid complementary
set survived generation validation/deduplication; original and deterministic
enhancement were identical. Production diagnostics intentionally do not retain
the generated text or provider response.

Wi-Fi applicability filtering in both modes excluded 20 wrong-topic chunks,
two incompatible-platform chunks and one wrong-symptom chunk, leaving the
single approved connected/no-internet chunk. Camera selected two applicable
chunks. Unsupported evidence remained below threshold; no threshold was lowered.

## Measured additional calls and latency

Totals across the **four retrieval turns per mode**; clarification turns used
zero provider calls:

| Operation | Single-query | Multi-query |
|---|---:|---:|
| Pinecone embedding requests | 4 | 13 |
| Pinecone dense searches | 4 | 13 |
| PostgreSQL lexical searches | 4 | 13 |
| Pinecone neural reranks | 4 | 4 |
| Nebius requests, including answer/action/failed-step checks | 5 | 9 |
| Mean retrieval-to-evidence latency | 637 ms | 3186 ms |
| Mean entire answer-turn latency | 2894 ms | 5249 ms |

The first single-query request also performed one cold index-description call;
subsequent requests reused the existing source-profile cache.

**No quality improvement was measured on these questions.** Answers, supported
citations and relevance decisions matched. Multi-query incurred nine extra
embedding calls, nine extra dense searches, nine extra lexical searches and
four extra Nebius calls. These are single-run, sequential, small-corpus
measurements—not a statistically controlled benchmark, token-billing estimate
or production latency guarantee. Provider latency and generation vary.

Signed-in browser/API acceptance was not performed: no authorized synthetic
employee session was available, and authentication was not bypassed. The version
is prepared for republishing; this report does not assert it is already deployed.
