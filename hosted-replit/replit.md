# TechAssist.ai

Employee IT support with device-aware troubleshooting, evidence-grounded answers, and copyable IT handoff summaries.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages; direct shell builds require `PORT` and `BASE_PATH` (managed artifact builds inject these).
- Product-only shell builds: `PORT=26121 BASE_PATH=/ NODE_ENV=production pnpm --filter @workspace/techassist run build` and `pnpm --filter @workspace/api-server run build`.
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Web: managed workflow `artifacts/techassist: web`, served at `/`.
- API: managed workflow `artifacts/api-server: API Server`, served at `/api`.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/techassist` — employee UI, branded Clerk sign-in, explicit guest demo, administrator knowledge setup.
- `artifacts/api-server/src/lib/{rag,knowledge,support-config}.ts` — retrieval, ingestion and server-only providers.
- `artifacts/api-server/src/routes/support.ts` — owner-scoped authenticated conversation API and admin authorization.
- `lib/db/src/schema/support.ts` — persistent conversations and extracted knowledge chunks.
- `lib/api-spec/openapi.yaml` — API source of truth.
- `docs/techassist-operations.md` — credential setup, administrator bootstrap, corpus import, deployment checklist and verification limits.

## Architecture decisions

- Local source, local corpus and Keychain secrets were not supplied. This reimplements orchestration rather than claiming to port unseen FastAPI code.
- Live answers fail closed without credentials or evidence. Demo is opt-in, explicitly illustrative, session-only, and never stored as employee history.
- The user's existing Pinecone laptop corpus is authoritative and read-only here. Synchronize original IDs/text/metadata for lexical retrieval and citations; never rewrite, delete, or re-embed original vectors.
- Hybrid retrieval uses Pinecone llama-text-embed-v2 (1024/cosine) plus PostgreSQL lexical search. Reranking is reciprocal-rank fusion then Pinecone bge-reranker-v2-m3; generation is Nebius Qwen/Qwen3-30B-A3B-Instruct-2507.
- Source readiness requires actual provider/index checks and a complete, ready persistent corpus matching the validated record count. Synthetic regression status is separate. Why: database setup must not require fabricating a signed-in employee session; authenticated acceptance tests must remain honest and access-controlled.
- Authorized operator/startup maintenance can mirror the approved corpus but cannot run conversation regression without an authenticated administrator owner. Regression uses the same persisted turn/outcome flow as employee chat, with clearly synthetic owner-scoped histories.
- Replit Publish owns production schema changes. Opt-in production startup synchronizes data only after that schema exists; it never performs DDL or blocks frontend health checks.
- SSE exposes retrieval stages immediately but answer text only after structured grounding/citation checks.
- Wi-Fi triage asks for missing OS and ambiguous symptoms, retaining the original issue in persisted message snapshots. See `docs/wifi-troubleshooting.md` for source-action grounding and verification boundaries.
- RAG-Fusion generates bounded Nebius search hints, fuses per-query dense/lexical rankings, and reranks against original confirmed facts. Controls and measured limitations: `docs/rag-fusion.md`.
- Evidence metadata scope is shared across every variant/channel, with verified Documents API predicates and pre-limit SQL filtering. Strict legacy/vendor behavior and 512-record bound: `docs/metadata-filtering.md`.
- Request/retrieval correlation, privacy allowlists, SSE metadata and retry limitations: `docs/request-correlation.md`.

## Product

Searchable private support conversations, persistent device context, employee-confirmed outcomes, attempted-step tracking, source citations, and copyable (not automatically submitted) IT handoffs. Administrators configure providers through Replit Secrets and synchronize the existing approved Pinecone corpus. New ingestion into that protected source is disabled.

## User preferences

Keep provider configuration out of ordinary employee chat screens. Never expose credentials, fabricate corpus access, or mark an issue resolved without employee confirmation.

## Gotchas

- Set the intended administrator via server-only `TECHASSIST_ADMIN_USER_IDS` or Clerk `publicMetadata.role=admin`; never promote the first signup.
- Development and production identities/databases are separate; authorize the production administrator and synchronize/validate production after publishing.
- See operations guide for required Nebius model and compatible Pinecone index dimensions.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
