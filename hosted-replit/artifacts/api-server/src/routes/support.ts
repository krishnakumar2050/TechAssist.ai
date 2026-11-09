import { Router, type IRouter, type Request } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { rateLimit } from "express-rate-limit";
import { pool } from "@workspace/db";
import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  CreateConversationBody, UpdateConversationBody, GetConversationResponse,
  SendMessageBody, RecordOutcomeBody, IngestKnowledgeBody, GetConversationParams,
  ListConversationsQueryParams, GetSupportStatusResponse, GetAdminStatusResponse,
  ListConversationsResponse, GetHandoffResponse, IngestKnowledgeResponse,
  ValidateSupportSourceBody,
} from "@workspace/api-zod";
import { type ConversationDetail } from "../lib/rag";
import { persistChat, sendChatTurn, recordChatOutcome } from "../lib/conversation-flow";
import { configurationChecks, embeddingModel, namespace, SupportError } from "../lib/support-config";
import { ingest } from "../lib/knowledge";
import { liveReady, validationReport, runValidation } from "../lib/corpus-validation";
import { buildFilterPolicy } from "../lib/metadata-policy";
import { correlation, correlatedPayload, diagnostic, errorCode, linkTrace } from "../lib/observability";

const router: IRouter = Router();
// Dedicated connections prevent advisory-lock holders starving the data query pool.
const lockPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 });
const userId = (req: Request) => getAuth(req).userId!;
async function isAdmin(req: Request) {
  const id = getAuth(req).userId;
  if (!id) return false;
  if ((process.env.TECHASSIST_ADMIN_USER_IDS || "").split(",").map(v => v.trim()).includes(id)) return true;
  const user = await clerkClient.users.getUser(id);
  return user.publicMetadata.role === "admin";
}
async function corpusCount() {
  const result = await pool.query("SELECT count(*)::int AS documents,coalesce(sum(chunk_count),0)::int AS chunks FROM support_documents WHERE status='ready' AND namespace=$1 AND embedding_model=$2", [namespace(), embeddingModel()]);
  return result.rows[0] as { documents: number; chunks: number };
}
function detail(row: Record<string, unknown>): ConversationDetail {
  return GetConversationResponse.parse({
    id: row.id, title: row.title, status: row.status, context: row.context,
    messages: row.messages, attempts: row.attempts,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  });
}
async function load(req: Request) {
  const { id } = GetConversationParams.parse(req.params);
  const result = await pool.query("SELECT * FROM support_conversations WHERE id=$1 AND owner_id=$2", [id, userId(req)]);
  if (!result.rows[0]) throw new SupportError(404, "Conversation not found.");
  // Only attach an ID after Clerk identity AND database ownership have passed.
  linkTrace({ conversationId: String(result.rows[0].id) });
  return detail(result.rows[0]);
}
async function save(req: Request, chat: ConversationDetail) {
  return persistChat(userId(req), chat);
}
// DB advisory locks serialize mutations across instances without holding SQL transactions during inference.
async function locked<T>(req: Request, operation: () => Promise<T>): Promise<T> {
  const { id } = GetConversationParams.parse(req.params);
  const client = await lockPool.connect();
  const key = `${userId(req)}:${id}`;
  const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key]);
  if (!lock.rows[0].locked) { client.release(); throw new SupportError(409, "This conversation is still processing. Please wait and retry."); }
  try { return await operation(); }
  finally { await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]); client.release(); }
}
router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.get("/status", async (req, res) => {
  const authenticated = Boolean(getAuth(req).userId);
  const counts = await corpusCount();
  const ready = counts.chunks > 0 && await liveReady();
  res.json(GetSupportStatusResponse.parse({
    ready, authenticated, admin: authenticated ? await isAdmin(req) : false,
    message: ready ? "Knowledge-backed support is available." : "Live support is being set up. You can explore the demo or contact your IT team.",
  }));
});
router.use((req, res, next) => {
  if (!getAuth(req).userId) { res.status(401).json({ error: "Sign in to access your support conversations." }); return; }
  // Same-origin requests only for mutations; bearer/cookie session is verified by Clerk.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.get("sec-fetch-site") === "cross-site") { res.status(403).json({ error: "Cross-site request rejected." }); return; }
    const origin = req.get("origin");
    const host = req.get("x-forwarded-host") || req.get("host");
    if (origin && new URL(origin).host !== host) { res.status(403).json({ error: "Cross-site request rejected." }); return; }
  }
  next();
});
router.use(rateLimit({ windowMs: 60000, limit: 60, keyGenerator: req => userId(req), standardHeaders: "draft-8", legacyHeaders: false }));
router.get("/conversations", async (req, res) => {
  const { search = "" } = ListConversationsQueryParams.parse(req.query);
  const { rows } = await pool.query("SELECT * FROM support_conversations WHERE owner_id=$1 AND (title ILIKE $2 OR messages::text ILIKE $2) ORDER BY updated_at DESC LIMIT 100", [userId(req), `%${search.slice(0, 200)}%`]);
  res.json(ListConversationsResponse.parse(rows.map(detail)));
});
router.post("/conversations", async (req, res) => {
  const input = CreateConversationBody.extend({ context: UpdateConversationBody.strict() }).parse(req.body);
  buildFilterPolicy(input.context);
  const { rows } = await pool.query("INSERT INTO support_conversations(id,owner_id,title,context) VALUES($1,$2,$3,$4) RETURNING *",
    [randomUUID(), userId(req), input.title, JSON.stringify(input.context)]);
  linkTrace({ conversationId: rows[0].id });
  res.status(201).json(detail(rows[0]));
});
router.get("/conversations/:id", async (req, res) => { res.json(await load(req)); });
router.patch("/conversations/:id", async (req, res) => {
  const context = UpdateConversationBody.strict().parse(req.body);
  buildFilterPolicy(context);
  const result = await locked(req, async () => {
    const chat = await load(req); chat.context = context; return save(req, chat);
  });
  res.json(result);
});
router.delete("/conversations/:id", async (req, res) => {
  await locked(req, async () => {
    const chat = await load(req);
    await pool.query("DELETE FROM support_conversations WHERE id=$1 AND owner_id=$2", [chat.id, userId(req)]);
  });
  res.status(204).end();
});
router.post("/conversations/:id/messages",
  rateLimit({ windowMs: 60000, limit: 8, keyGenerator: req => userId(req), standardHeaders: "draft-8", legacyHeaders: false }),
  async (req, res) => {
    const { text } = SendMessageBody.parse(req.body);
    const streaming = req.get("accept")?.includes("text/event-stream");
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const emit = (event: string, data: unknown) => {
      if (streaming && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const result = await locked(req, async () => {
        const chat = await load(req);
        if (chat.messages.length >= 200) throw new SupportError(400, "Please start a new chat; this conversation has reached its limit.");
        const counts = await corpusCount();
        if (!counts.chunks || !await liveReady()) throw new SupportError(503, "Live support is awaiting provider validation and corpus synchronization. Please contact your IT team.");
        if (streaming) {
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("X-Accel-Buffering", "no");
          res.flushHeaders();
          heartbeat = setInterval(() => { if (!res.destroyed) res.write(": keep-alive\n\n"); }, 15000);
        }
        const saved = await sendChatTurn(userId(req), chat, text, stage => emit("progress", correlatedPayload({ stage })));
        const reply = saved.messages.at(-1)!;
        // Only stream validated, source-grounded content, never raw unvalidated model output.
        for (const part of reply.text.match(/.{1,32}/gs) || []) emit("token", { text: part });
        return saved;
      });
      if (streaming) { emit("done", correlatedPayload(result)); res.end(); } else res.json(result);
    } catch (error) {
      const status = error instanceof SupportError ? error.status : 502;
      const message = error instanceof SupportError && error.status !== 502 ? error.message : "The support service couldn't complete this response. Please retry or prepare an IT handoff.";
      diagnostic({ event: "chat_request_error", statusCode: status, errorCode: errorCode(error) });
      if (res.headersSent) { emit("error", correlatedPayload({ error: message })); res.end(); }
      else res.status(status).json({ error: message, correlation: correlation() });
    } finally { if (heartbeat) clearInterval(heartbeat); }
  });
router.post("/conversations/:id/outcome", async (req, res) => {
  const input = RecordOutcomeBody.parse(req.body);
  res.json(await locked(req, async () => {
    const chat = await load(req);
    const saved = await recordChatOutcome(userId(req), chat, input.messageId, input.outcome);
    linkTrace({ assistantMessageId: input.messageId });
    return saved;
  }));
});
router.get("/conversations/:id/handoff", async (req, res) => {
  const chat = await load(req);
  const summary = [
    "TechAssist.ai — IT handoff (not submitted)", `Issue: ${chat.title}`, `Conversation: ${chat.id}`,
    `Status: ${chat.status === "resolved" ? "Employee confirmed resolved" : "Not confirmed resolved"}`,
    `OS: ${chat.context.os || "Not provided"}`, `Laptop: ${chat.context.model || "Not provided"}`, `Application: ${chat.context.application || "Not provided"}`,
    `Device type: ${chat.context.deviceType || "Not confirmed"}`, `Manufacturer: ${chat.context.vendor || "Not confirmed"}`,
    "", "Attempted steps:", ...chat.attempts.map(a => `- ${a.step}: ${a.outcome}`),
    "", "Conversation:", ...chat.messages.map(m => `${m.role}: ${[m.text, m.explanation, m.navigation, m.expectedResult].filter(Boolean).join("\n")}`),
    "", "Evidence:", ...chat.messages.flatMap(m => m.citations.map(c => `- ${c.title} (${c.id}) ${c.url || ""}`)),
  ].join("\n");
  res.json(GetHandoffResponse.parse({ summary }));
});
router.use("/admin", async (req, res, next) => {
  if (!await isAdmin(req)) { res.status(403).json({ error: "Administrator access is required." }); return; }
  next();
});
router.get("/admin/status", async (_req, res) => {
  res.json(GetAdminStatusResponse.parse({ checks: configurationChecks(), ...await corpusCount(), validation: await validationReport() }));
});
router.post("/admin/validate", rateLimit({ windowMs: 60000, limit: 30, keyGenerator: req => userId(req) }), async (req, res) => {
  const { action } = ValidateSupportSourceBody.parse(req.body);
  res.json(await runValidation(action, userId(req)));
});
router.post("/admin/ingest", rateLimit({ windowMs: 60000, limit: 3, keyGenerator: req => userId(req) }), async (req, res) => {
  if (!configurationChecks().every(c => c.configured)) throw new SupportError(503, "Add the required Replit Secrets and configuration before ingesting knowledge.");
  const input = IngestKnowledgeBody.parse(req.body);
  res.json(IngestKnowledgeResponse.parse(await ingest(input)));
});
export default router;
