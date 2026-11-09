# TechAssist operations

## Approved existing source

The authoritative source is the user's existing Pinecone corpus. This hosted app
must not re-embed, rewrite, delete or append to its original vectors.

| Setting | Value |
| --- | --- |
| `PINECONE_INDEX_NAME` | `techassist-laptops-hybrid` |
| `PINECONE_INDEX_HOST` | `https://techassist-laptops-hybrid-4rxtk29.svc.aped-4627-b74a.pinecone.io` |
| `PINECONE_NAMESPACE` | `laptop-corpus-recursive-v2` |
| Embedding | Pinecone `llama-text-embed-v2`, 1024 dimensions, query input type |
| Index metric | cosine |
| Reranking | Pinecone `bge-reranker-v2-m3` |
| `NEBIUS_MODEL` | `Qwen/Qwen3-30B-A3B-Instruct-2507` |

These values are server defaults as well as the intended workspace configuration.
The existing index has a **document schema**. Describe it with Pinecone API
`2026-07`, inspect the `embedding` field, and use the Documents API for list,
fetch and dense-vector search. Legacy vector-read endpoints return HTTP 400 on
this source. Original citation URLs are arrays in `source_urls`; synchronize
and validate every entry and retain all links in step citations.
Old `NEBIUS_EMBEDDING_MODEL` and `NEBIUS_RERANK_MODEL` settings are not used.
Generation and optional structured multi-query search hints use Nebius; the
original factual query and deterministic fallback are server-constructed.
Embeddings and neural reranking use Pinecone. Hybrid retrieval combines
Pinecone dense search with PostgreSQL English full-text search per distinct
query, cross-query/channel reciprocal-rank fusion (constant 60), and neural
reranking of up to 24 fused candidates to at most five evidence chunks.
Reranking always uses the original issue and confirmed context, never a
generated hint. `RAG_MIN_RELEVANCE` defaults to `0.1`.
See [RAG-Fusion configuration and safeguards](rag-fusion.md) and
[measured comparison](rag-fusion-evaluation.md).
The shared [metadata filter policy](metadata-filtering.md) now pushes verified
Documents API predicates and pre-limit SQL scope constraints across all query
variants. Optional server-only `RAG_METADATA_FILTERS` defaults to `{}`.

## Credentials and production

- Required secrets: `NEBIUS_API_KEY`, `PINECONE_API_KEY`.
- `DATABASE_URL` is runtime-managed. Do not paste or replace it manually.
- Keys must be entered only in Replit's secure Secrets form/tool, never chat,
  source code, an app form, uploaded documents, or command-line arguments.
- The agent's secure Secrets callback does not accept a production environment
  selector. Confirm the published application's keys in Publishing → Adjust
  settings → Production app secrets using Replit's secure fields, then republish.
  Do not assume a successful workspace check proves production configuration.
- The Pinecone key needs index describe/statistics, list/fetch/query and hosted
  inference access. This app does not need vector mutation permissions.
- This environment cannot retrieve macOS Keychain wrapping keys or encrypted
  local credentials. Retrieve the API keys privately on the user's own machine.
- Provider response bodies and authorization headers are never sent to employees
  or logs. Admin checks report sanitized provider path and HTTP status on failure.

## Explicit administrator authorization

`/admin` shows a dedicated sign-in explanation when signed out, not the demo.
After sign-in, non-admin users see an access-denied explanation and their own
Clerk user ID. A project owner must explicitly place the intended account ID in
server-only `TECHASSIST_ADMIN_USER_IDS` (comma-separated if multiple) in the
correct environment. Existing Clerk `publicMetadata.role = "admin"` also works.
Never promote the first signup or infer authorization from registration.
Development and production Clerk identities differ; authorize the actual
production identity separately and republish environment changes.

Both the status details and all validation/ingestion actions require authenticated
administrator access at the server, not just a hidden UI link.

## Validation and synchronization

Run the three controls on `/admin` in order:

1. **Validate providers and index.** Describe the actual Pinecone index and check
   name, host, ready state, 1024 dimensions and cosine in the actual index schema.
   Generate an actual 1024-dimensional query embedding, call
   Pinecone reranking, generate through Nebius, and check namespace statistics.
2. **Synchronize existing corpus.** Enumerate all vector IDs with pagination and
   fetch every vector and its metadata. Validate dimensions, finite values, text,
   source URL, document ID, platform, category and embedding provenance. Mirror
   the original IDs, source text and full original metadata into PostgreSQL for
   lexical search and citations. No Pinecone vector mutation is performed.
   One page per request supports resumable synchronization. The browser continues
   pages automatically, and refresh/retry can resume a saved page boundary.
3. **Test camera query and failed follow-up.** Run an actual Windows 11 camera in
   Microsoft Teams query through the full retrieval/generation path, record the
   first attempted step as failed, and request a different supported step with
   the same context and history. Both answers require citations and a technical
   step rather than handoff. The report shows both steps and the last pass time.
   The synthetic regression starts with: “My Windows 11 camera works in the
   Camera app but the preview is black in Microsoft Teams”.
   It requires the current authenticated administrator identity and creates an
   owner-scoped “[SYNTHETIC TEST]” conversation using the same persisted turn and
   outcome functions as employee chat. It records “failed”, reloads the attempt
   and device context from PostgreSQL, then generates the follow-up. Full
   responses and citations remain in that administrator's private chat history.

Metadata field aliases are explicit in `normalizeRecord`. Unknown formats,
incompatible provenance, missing records, non-advancing cursors, stale local
records, and changed namespace counts stop validation rather than silently
skipping content or editing the source. Report the field mismatch to the operator
and adapt mappings after inspecting actual metadata; never invent missing data.

Citation validation checks absolute HTTP(S) URL syntax and rejects URL credentials.
It does not crawl destinations, verify intranet accessibility, or prove every
source is factually correct. Source excerpts are preserved. No unrestricted
server-side URL crawling is implemented.

Source readiness requires successful provider checks and a complete synchronization
report (`synced` or `ready`) for the current configuration/credential fingerprint,
with the exact recorded number of ready persistent chunks. Authenticated
query/follow-up pass flags remain separate; maintenance alone never marks these
tests passed. Changing
keys or retrieval configuration invalidates previous checks. Failures clear
readiness. Presence checks alone never enable chat. Reports are environment-local;
development validation does not authorize production readiness. External corpus
changes are not monitored continuously: rerun validation after approved changes.

Source synchronization is read-only in Pinecone. New text/JSON ingestion into
this protected namespace is intentionally disabled, including its server endpoint.
Have the source owner approve and index additions, then synchronize again.
Recursive JSON/text splitting helpers remain for a future separate writable
corpus, not as a way to change this protected source.

## Operator command

For authorized workspace operations after secure key entry:

```sh
pnpm --filter @workspace/api-server exec esbuild src/scripts/validate-source.ts \
  --bundle --platform=node --format=esm \
  --external:pg --external:pg-native --external:drizzle-orm \
  '--external:drizzle-orm/*' --external:zod \
  --outfile=node_modules/.cache/validate-source.mjs
node artifacts/api-server/node_modules/.cache/validate-source.mjs
```

This performs provider checks and database synchronization only. It prints sanitized
results and exits nonzero on failure. Original IDs upsert existing rows, pages are
transactional, and advisory locks prevent concurrent maintenance. It does not grant
roles, run employee chat tests, or bypass authentication on public routes.

## Production startup synchronization

Production is configured with `TECHASSIST_SYNC_ON_STARTUP=true`. After **Publish**
applies the development-to-production schema diff, startup runs the approved
read-only-source mirror in the background. No startup/build DDL is performed.
Missing schema or provider failures leave retrieval unready while the frontend
and health endpoint continue serving. Startup never impersonates an employee or
marks synthetic query/follow-up tests passed.

The startup path resumes incomplete page boundaries, skips an already validated
complete corpus, and uses a cross-instance advisory lock. A failed run can be
retried by restarting the service or using the authorized production `/admin`
provider and synchronization controls. Do not select Publish's overwrite-data
option: this is an additive schema change plus idempotent corpus data sync.
Do not use this operator command as a substitute when a verification request
explicitly requires authenticated employee/admin workflows. Use authorized test
identities and the protected API routes instead; never fabricate successful
signed-in tests from direct function calls.

## Verification and republishing

- Run `pnpm run typecheck`.
- Run mocked tests (these are not live-provider verification):

```sh
pnpm --filter @workspace/api-server exec esbuild src/lib/corpus-validation.test.mjs \
  --bundle --platform=node --format=esm \
  --external:pg --external:pg-native --external:drizzle-orm \
  '--external:drizzle-orm/*' --external:zod \
  --outfile=node_modules/.cache/corpus-validation.test.mjs
node --test artifacts/api-server/node_modules/.cache/corpus-validation.test.mjs
```

- Apply development database schema through the normal Drizzle push. Publishing
  must apply the new validation table and chunk metadata column to production;
  do not run startup schema DDL.
- Confirm production credentials and administrator identity, then publish through
  Replit. Run the three checks in the production `/admin` page; local validation
  is not copied into production.
- Verify a signed-in employee query, persisted history after reload, failed-step
  outcome, different follow-up, citations and copyable handoff. Semantic-repeat
  rejection is model-assisted and fails closed; it is not a deterministic proof.
- SSE reports retrieval progress and keep-alives. Answer tokens are sent only
  after structured output/citation validation.
- Only “That solved it” records employee-confirmed resolution. Handoffs are copied
  summaries, not submitted service-desk tickets.
- All employees share this single-organization corpus; no per-document department
  authorization exists. Review approved access, retention and provider data terms.

No live connectivity, full-corpus validation, or real-query pass should be claimed
until the actual credentials and source have completed those checks.
