import { createHash, randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { z } from "zod";
import { readChat, sendChatTurn, recordChatOutcome } from "./conversation-flow";
import { configurationChecks, completion, embed, embeddingModel, generationModel, indexName, namespace, pineconeHost, providerJson, rerank, SupportError } from "./support-config";
import { sourceProfile, listSource, fetchSource } from "./pinecone-source";

export type ValidationReport = {
  stage: "pending" | "providers" | "syncing" | "synced" | "ready" | "failed";
  message: string; records: number; checkedAt: string | null;
  cursor?: string; expected?: number; queryPassed: boolean; followupPassed: boolean;
  firstStep?: string; followupStep?: string;
  testConversationId?: string;
};
const empty = (): ValidationReport => ({
  stage: "pending", message: "Setup required: enter provider keys, validate connectivity, and synchronize the corpus. Run the authenticated camera/Teams regression separately.",
  records: 0, checkedAt: null, queryPassed: false, followupPassed: false,
});
// Key changes invalidate prior checks without storing credentials or their individual hashes.
function validationKey() {
  return createHash("sha256").update(JSON.stringify([
    "pinecone-documents-source-validation", pineconeHost(), indexName(), namespace(), embeddingModel(),
    generationModel(), process.env.RAG_MIN_RELEVANCE || "0.1",
    process.env.NEBIUS_API_KEY || "", process.env.PINECONE_API_KEY || "",
  ])).digest("hex");
}
export async function validationReport(): Promise<ValidationReport> {
  if (!configurationChecks().every(c => c.configured)) return { ...empty(), message: "Setup required: required provider credentials are missing." };
  try {
    const { rows } = await pool.query("SELECT report FROM support_validation WHERE id=$1", [validationKey()]);
    return rows[0]?.report || empty();
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return { ...empty(), message: "Setup required: republish to apply the additive validation-table migration, then synchronize the corpus." };
    throw error;
  }
}
export async function liveReady() {
  const report = await validationReport();
  if (!["synced", "ready"].includes(report.stage) || report.records < 1) return false;
  const { rows } = await pool.query(`SELECT count(*)::int AS count FROM support_chunks c JOIN support_documents d ON d.id=c.document_id
    WHERE d.status='ready' AND d.namespace=$1 AND d.embedding_model=$2`, [namespace(), embeddingModel()]);
  return rows[0]?.count === report.records;
}
async function store(report: ValidationReport) {
  await pool.query(`INSERT INTO support_validation(id,report) VALUES($1,$2)
    ON CONFLICT(id) DO UPDATE SET report=excluded.report,updated_at=now()`, [validationKey(), JSON.stringify(report)]);
}
async function statsCount() {
  const result = z.object({
    dimension: z.number().optional(),
    namespaces: z.record(z.string(), z.object({ vectorCount: z.number().int().nonnegative() })).default({}),
  }).parse(await providerJson(`${pineconeHost()}/describe_index_stats`, {}, "pinecone"));
  if (result.dimension !== undefined && result.dimension !== 1024) throw new SupportError(409, "Index statistics report incompatible dimensions.");
  const count = result.namespaces[namespace()]?.vectorCount || 0;
  if (!count) throw new SupportError(409, "The configured namespace is empty or not visible to this API key.");
  return count;
}
async function validateProviders(): Promise<ValidationReport> {
  await sourceProfile(true);
  await embed(["Windows 11 Microsoft Teams camera not detected"]);
  const rank = await rerank("camera", [{ id: "connectivity-check", text: "Windows camera troubleshooting guidance." }]);
  if (rank.length !== 1 || rank[0]?.index !== 0) throw new SupportError(502, "Pinecone reranker validation failed.");
  const generation = await completion("Reply with exactly OK.", "Connectivity validation.", 20);
  if (!generation.trim()) throw new SupportError(502, "Nebius generation returned empty content.");
  const expected = await statsCount();
  return { ...empty(), stage: "providers", expected, message: "Pinecone index, 1024-dimensional query embedding, reranker, namespace and Nebius generation responded successfully. Corpus synchronization is required." };
}

function value(metadata: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const v = metadata[name];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
export function normalizeRecord(record: { id: string; values: number[]; metadata: Record<string, unknown> }) {
  const m = record.metadata;
  const text = value(m, ["text", "chunk_text", "content", "page_content"]);
  const singular = value(m, ["source_url", "sourceUrl", "url", "source"]);
  const sources = Array.isArray(m.source_urls) ? z.array(z.string().min(1)).min(1).parse(m.source_urls) : singular ? [singular] : [];
  const source = sources[0] || "";
  const documentId = value(m, ["document_id", "documentId", "doc_id", "docId"]);
  const platform = value(m, ["platform", "os"]);
  const category = value(m, ["category"]);
  const model = value(m, ["embedding_model", "embeddingModel", "embed_model", "embedding_model_name"]);
  const provider = value(m, ["embedding_provider", "embeddingProvider"]);
  if (!text || !source || !documentId || !platform || !category || !model) {
    throw new SupportError(409, "Corpus metadata validation failed: every record needs text, source URL, document ID, platform, category and embedding model. No records were skipped. Review metadata field mappings.");
  }
  for (const sourceUrl of sources) {
    let url: URL;
    try { url = new URL(sourceUrl); } catch { throw new SupportError(409, "A corpus citation is not an absolute HTTP(S) URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new SupportError(409, "A corpus citation uses an unsafe URL.");
  }
  if (model !== embeddingModel() && model !== `pinecone/${embeddingModel()}`) throw new SupportError(409, "A corpus record has incompatible embedding provenance.");
  if (provider && provider.toLowerCase() !== "pinecone") throw new SupportError(409, "A corpus record has an incompatible embedding provider.");
  if (record.values.length !== 1024 || record.values.some(v => !Number.isFinite(v))) throw new SupportError(409, "A corpus vector does not contain 1024 finite dimensions.");
  const dimensions = m.embedding_dimension ?? m.embedding_dimensions ?? m.dimensions;
  if (dimensions !== undefined && Number(dimensions) !== 1024) throw new SupportError(409, "A corpus record declares incompatible embedding dimensions.");
  const doc = `pinecone:${createHash("sha256").update(`${pineconeHost()}/${namespace()}/${documentId}`).digest("hex")}`;
  return { id: record.id, doc, title: value(m, ["title", "document_title", "source_title"]) || `${platform} · ${category}`, source, text, metadata: m };
}

async function syncPage(report: ValidationReport): Promise<ValidationReport> {
  if (!["providers", "syncing"].includes(report.stage)) throw new SupportError(409, "Validate providers before synchronizing the corpus.");
  const page = await listSource(report.cursor);
  const ids = page.ids;
  let records: ReturnType<typeof normalizeRecord>[] = [];
  if (ids.length) {
    records = (await fetchSource(ids)).map(normalizeRecord);
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    if (report.stage === "providers") {
      await db.query("UPDATE support_documents SET status='pending' WHERE namespace=$1 AND embedding_model=$2", [namespace(), embeddingModel()]);
    }
    for (const r of records) {
      await db.query(`INSERT INTO support_documents(id,title,source_url,namespace,embedding_model,status)
        VALUES($1,$2,$3,$4,$5,'pending') ON CONFLICT(id) DO UPDATE SET title=excluded.title,source_url=excluded.source_url,status='pending'`,
        [r.doc, r.title, r.source, namespace(), embeddingModel()]);
      const saved = await db.query(`INSERT INTO support_chunks(id,document_id,title,source_url,text,metadata) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,source_url=excluded.source_url,text=excluded.text,metadata=excluded.metadata
        WHERE support_chunks.document_id=excluded.document_id RETURNING id`,
        [r.id, r.doc, r.title, r.source, r.text, JSON.stringify(r.metadata)]);
      if (!saved.rowCount) throw new SupportError(409, "A vector ID conflicts with a different local document. Synchronization stopped without altering Pinecone.");
    }
    const next = page.next;
    const count = report.records + records.length;
    if (next && (!ids.length || next === report.cursor)) throw new SupportError(502, "Pinecone returned a non-advancing pagination cursor.");
    if (!next) {
      const currentCount = await statsCount();
      if (count !== report.expected || count !== currentCount) throw new SupportError(409, "Namespace record count changed or enumeration was incomplete. Validate and synchronize again.");
      const local = await db.query(`SELECT count(*)::int AS count FROM support_chunks c JOIN support_documents d ON d.id=c.document_id WHERE d.namespace=$1 AND d.embedding_model=$2`, [namespace(), embeddingModel()]);
      if (local.rows[0].count !== count) throw new SupportError(409, "Local corpus contains stale or conflicting records. Reconcile local metadata before enabling live support; original vectors were not changed.");
      await db.query(`UPDATE support_documents d SET status='ready',chunk_count=(SELECT count(*) FROM support_chunks c WHERE c.document_id=d.id) WHERE namespace=$1 AND embedding_model=$2`, [namespace(), embeddingModel()]);
    }
    await db.query("COMMIT");
    return { ...report, records: count, cursor: next, checkedAt: next ? null : new Date().toISOString(), stage: next ? "syncing" : "synced",
      message: next ? `Validated and synchronized ${count} of ${report.expected} records. Continue synchronization.` :
        `All ${count} records validated and mirrored for lexical retrieval and citations. Original vectors unchanged. Source ready; authenticated camera/Teams regression has not yet passed.` };
  } catch (e) { await db.query("ROLLBACK"); throw e; }
  finally { db.release(); }
}

async function regression(report: ValidationReport, ownerId: string): Promise<ValidationReport> {
  if (report.stage !== "synced" && report.stage !== "ready") throw new SupportError(409, "Complete corpus synchronization before the real-query regression.");
  const id = randomUUID();
  await pool.query("INSERT INTO support_conversations(id,owner_id,title,context) VALUES($1,$2,$3,$4)",
    [id, ownerId, "[SYNTHETIC TEST] Windows 11 Teams camera", JSON.stringify({ os: "Windows 11", model: "", application: "Microsoft Teams" })]);
  let chat = await readChat(ownerId, id);
  const question = "My Windows 11 camera works in the Camera app but the preview is black in Microsoft Teams";
  chat = await sendChatTurn(ownerId, chat, question, () => {});
  const first = chat.messages.at(-1)!;
  if (!first.citations.length || first.step === "Prepare an IT handoff") throw new SupportError(422, "The real camera/Teams query did not produce an evidence-backed technical step.");
  await recordChatOutcome(ownerId, chat, first.id, "failed");
  chat = await readChat(ownerId, id);
  if (!chat.attempts.some(a => a.messageId === first.id && a.outcome === "failed") || chat.context.os !== "Windows 11") {
    throw new SupportError(500, "Synthetic regression could not reload its failed-step memory and device context.");
  }
  const followupQuestion = "I tried that step and it is still not working. What is a different next step?";
  await sendChatTurn(ownerId, chat, followupQuestion, () => {});
  chat = await readChat(ownerId, id);
  const followup = chat.messages.at(-1)!;
  if (!followup.citations.length || followup.step === "Prepare an IT handoff") throw new SupportError(422, "The failed-step follow-up did not produce a different evidence-backed technical step. Live readiness remains blocked.");
  return { ...report, stage: "ready", queryPassed: true, followupPassed: true, checkedAt: new Date().toISOString(),
    firstStep: first.step, followupStep: followup.step, testConversationId: id,
    message: `Passed: providers, index compatibility, all ${report.records} records and citation URL syntax, Windows 11 camera/Teams query, and different failed-step follow-up. Citation destinations were not crawled; semantic step comparison is model-assisted.` };
}

export async function runValidation(action: "providers" | "sync" | "regression", authenticatedOwnerId?: string) {
  if (action === "regression" && !authenticatedOwnerId) throw new SupportError(401, "Sign in as an explicitly authorized administrator at /admin, then select Test camera query and failed follow-up.");
  if (!configurationChecks().every(c => c.configured)) throw new SupportError(503, "Setup required: enter both provider keys through Replit Secrets.");
  const lock = await pool.connect();
  const key = `corpus-validation:${validationKey()}`;
  const held = await lock.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key]);
  if (!held.rows[0].locked) { lock.release(); throw new SupportError(409, "Another validation operation is running."); }
  let report = await validationReport();
  try {
    report = action === "providers" ? await validateProviders() : action === "sync" ? await syncPage(report) : await regression(report, authenticatedOwnerId!);
    await store(report);
    return report;
  } catch (e) {
    const message = e instanceof SupportError ? e.message : "Validation failed: unexpected provider response, network failure, or metadata format. Review configuration and retry.";
    report = { ...report, stage: "failed", queryPassed: false, followupPassed: false, checkedAt: null, message };
    await store(report);
    return report;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
    lock.release();
  }
}
