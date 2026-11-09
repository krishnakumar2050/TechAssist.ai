# TechAssist employee support application

React + TypeScript frontend, FastAPI orchestration, persistent conversation memory, Pinecone retrieval and reranking, and an optional local Ollama planning model. The supported local deployment serves the frontend and API from the same origin at http://127.0.0.1:8000.

## Start

```bash
source .venv/bin/activate
python scripts/start_services.py
python scripts/run_app.py --build --mode ollama
```

`start_services.py` creates project-owned Docker containers for PostgreSQL 16 and Ollama, downloads a Qwen model sized for Docker memory (`qwen2.5:1.5b` below 4 GB, otherwise `qwen2.5:3b`), and stores the generated database credential using the same authenticated encrypted-file / OS-keyring pattern as Pinecone. Ports 54329 and 11434 are bound to loopback only. Data and model weights persist in project-specific Docker volumes. The service script reuses its own existing containers; it does not replace unrelated containers or remove volumes.

The model download can take several minutes. On Docker 20.10 versions before 20.10.10, the service helper builds a CPU-only container from current official Ollama binaries on the AlmaLinux 8 baseline used by the upstream build. This avoids the newer-libc thread creation incompatibility while retaining Docker’s normal security profile. This Mac runs macOS 13, so Ollama runs inside Docker rather than through the current native macOS application. Inference is CPU-only on this setup and may be slow.

To use the application without a generation model:

```bash
python scripts/run_app.py --build --mode guided
```

Guided mode is a deterministic, evidence-backed troubleshooting workflow. Ollama mode uses an LLM to choose validated workflow actions and tailor the conversational introduction. The UI labels the active mode. It never substitutes guided output while claiming a model generated it. Neither mode needs an OpenAI API key for retrieval.

If project Docker services have been provisioned, the application automatically uses PostgreSQL. Otherwise it uses a local SQLite database under `.app/` for development. Set `DATABASE_URL` explicitly to override this. A PostgreSQL URL containing `{password}` is resolved from `.secrets/database.enc`, so its password need not appear in configuration files.

Node.js 20+ and pnpm are required for frontend installation. This workspace can also use the bundled Codex Node runtime, detected by `run_app.py` when `node` is absent from PATH. For a fresh checkout:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --only-binary=cryptography -e '.[dev]'
cd frontend
pnpm install
cd ..
python scripts/run_app.py --build --mode guided
```

Provision the encrypted Pinecone credential first with `techassist secrets-store pinecone` if it is not already present. Ciphertext cannot be moved to another machine and decrypted without the original OS-keyring wrapping key. Existing ingestion and retrieval commands are documented in `README.md`.

## Employee experience

- Start from one of four issue categories or describe a problem in the chat composer.
- Optionally supply operating system, laptop model, affected application and whether admin access is available. Context is included with the next message.
- Answer clarification questions. The agent saves the original problem and employee-confirmed details.
- Follow one source-backed step at a time. Select **That solved it**, **Still not working**, or **I can't do this**.
- Previous checks and outcomes remain visible in the progress panel. Refreshing or reopening a sidebar conversation resumes it.
- If evidence is weak, provide more detail or prepare an IT handoff. Copying the handoff does not create or send a ticket.
- A new conversation starts a separate issue. Cmd/Ctrl+K opens a fresh conversation.

Battery swelling, smoke and burning-smell signals bypass normal model planning and retrieval, and show stop-use guidance. The assistant never executes commands on employee laptops, asks for passwords, or automatically changes device settings.

## Agent and memory

The backend implements an explicit state machine:

```text
collecting_context → awaiting_step_result → resolved
         ↑                    |
         └──── follow-up ─────┘
                   |
                escalated
```

Conversation memory includes the original issue, a rolling summary, recent employee messages, explicitly supplied device context, attempted step IDs and outcomes, previously asked questions and the current pending step. Facts are not invented by the model. The database retains complete message history; only bounded recent history is sent to the planning model.

Retrieval embeds the contextualized query, runs dense and BM25 searches in Pinecone, merges their ranks, and reranks the top 20 candidates to keep the top five. Category is a routing hint; known incompatible OS sources are excluded. An initial reranking threshold of 0.03 gates evidence. This is a configurable development value, not a calibrated confidence guarantee; evaluate it on real employee questions before production.

In Ollama mode, each request can make at most three planning decisions. The model can ask a necessary clarification, select an eligible source step or recommend escalation. Invalid source IDs and step numbers are rejected. The executed instruction is copied from the retrieved resolution, rather than generated freely. The model can refine the retrieval query once per turn. Refined results pass the same relevance, compatibility and permission gates; redundant retrieval requests cannot cause an unbounded loop. The server also limits a conversation to six attempted checks or 30 turns before handoff. It persists state and waits for the employee after every question or proposed step.

The UI receives SSE progress events and a validated structured final response. Provider calls run outside the FastAPI event loop. One database processing lease serializes turns per conversation. Client request IDs make completed turn retries idempotent. A disconnected browser can reload saved history after the background turn finishes. Failed provider calls preserve the previous committed state and release the processing lease.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/session` | Establish local session or read authenticated employee session; obtain CSRF token |
| `GET /api/conversations` | List this session/employee's conversations |
| `POST /api/conversations` | Start a new conversation |
| `GET /api/conversations/{id}` | Load owned messages and workflow state |
| `POST /api/conversations/{id}/messages` | Run one bounded agent turn and stream progress/final output |
| `POST /api/logout` | Revoke the current session |
| `GET /api/auth/login` | Begin configured employee OIDC login |
| `GET /api/health` | Application liveness |

Write requests require `X-CSRF-Token`. The server owns the employee/session identity; the browser cannot submit another employee's user ID. Conversation IDs alone grant no access. Cookies are HttpOnly and SameSite. State and messages are not included in the sidebar listing payload. Provider exceptions are logged by exception type and request ID, without secrets or request contents.

Local mode intentionally creates an anonymous browser workspace on loopback. Clearing its cookie loses browser access to that workspace; use OIDC for stable employee identity. There is no browser credential-sharing or cross-employee conversation access.

## Configuration and deployment

See `.env.example` for non-secret settings. Main application settings:

| Setting | Purpose |
|---|---|
| `RESPONSE_MODE` | `guided` or `ollama` |
| `OLLAMA_URL` | Ollama API origin; defaults to loopback port 11434 |
| `OLLAMA_MODEL` | Local model name, defaults to the model selected by service provisioning, otherwise `qwen2.5:3b` |
| `DATABASE_URL` | SQLAlchemy SQLite or PostgreSQL connection URL |
| `AUTH_MODE` | `local` for loopback, `oidc` for employee sign-in |
| `APP_ORIGIN` | Canonical browser origin; used for write origin checks and OIDC redirects |
| `COOKIE_SECURE` | Must be true with employee OIDC / HTTPS |
| `RELEVANCE_THRESHOLD` | Minimum rerank relevance for an eligible source |

For enterprise deployment, configure HTTPS and `AUTH_MODE=oidc`, `OIDC_METADATA_URL`, `OIDC_CLIENT_ID` and the process-environment secret `OIDC_CLIENT_SECRET`. The callback URL is `<APP_ORIGIN>/api/auth/callback`. OIDC uses provider metadata, token validation, state and nonce through Authlib. A stable `OIDC_STATE_SECRET` supplied through the process environment is also required for employee OIDC state cookies. Register the application with your identity provider; no real employee IdP credentials were supplied or configured in this project.

Use PostgreSQL in a shared deployment, add a migration strategy before changing the initial schema, configure database backups and retention, apply gateway rate limits, and validate authorization with your actual identity provider. The initial database tables are created automatically; this project does not contain an existing production-schema migration. Keep the approved OS secret backend available on the application host; containerizing the Python backend requires a properly provisioned secure secret backend rather than copying a macOS Keychain master key into the image.

The application is a local deliverable because the defined architecture requires Python/FastAPI and host-managed secrets. It is not published to Sites hosting, which runs a different backend runtime.

## Development and verification

```bash
python -m pytest -p no:capture -p no:debugging -q
cd frontend
pnpm test
pnpm build
```

The pytest plugin flags avoid the native Anaconda `readline` crash observed on this Mac. Frontend tests use a simulated DOM and API responses. Backend tests cover ownership, CSRF, persistent memory, step progression, idempotence, stale outcomes, weak evidence, safety escalation, bounded model actions and provider failure recovery. Real Pinecone and local Ollama checks are separate from the offline suite.

For UI development, run FastAPI on port 8000 and `pnpm dev` in `frontend/`; Vite proxies `/api` to FastAPI. Local write origin checks also allow loopback Vite origins on port 5173. The production frontend build is served by FastAPI with a content security policy and no external script dependencies.

For ingestion, use the existing `techassist ingest --wait` command in a separate process. Ingestion is not exposed as an employee API endpoint and cannot block the conversation event loop. The worker uses the same encrypted Pinecone credential and versioned namespace as retrieval.

Live verification artifacts are written to `reports/application_smoke_guided.json`, `reports/application_smoke_ollama.json` and `reports/local_model_smoke.json` when the corresponding checks are run. The first guided check is also retained as `reports/application_smoke.json`.

## Verified local build

The local model structured-action check and the complete Ollama-mode API smoke test passed. The live test covers source-backed retrieval, a failed step advancing to a different check, resolution persistence and ownership isolation. The final offline suite contains 59 Python tests and five React/SSE tests; TypeScript and the production frontend build pass.

## Nebius Token Factory generation

Store your API key with `techassist secrets-store nebius` using the hidden prompt,
or supply `NEBIUS_API_KEY` through the process environment. Then start the web app
with `python scripts/run_app.py --build --mode nebius`. Set `NEBIUS_MODEL` if your
Token Factory project uses a different model. The default is `Qwen/Qwen3-30B-A3B-Instruct-2507`
served by Nebius.

In Nebius mode, the app sends the employee's issue, relevant conversation
context, and retrieved evidence to Token Factory for planning. FastAPI validates
the returned plan and presents one source-backed step with an expected result.
