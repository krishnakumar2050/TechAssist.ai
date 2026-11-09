import { pool } from "@workspace/db";
import { completion, embed, namespace, embeddingModel, SupportError } from "./support-config";
import { searchSource } from "./pinecone-source";
import { enhancedQuery, known, lexicalQuery, type Triage } from "./support-triage";
import type { ConversationDetail } from "./rag";
import { bounded, fusionConfig, queryPlan, retrieveBranches } from "./rag-fusion";
import { diagnostic, filterIdentity, retrievalMetrics, withRetrieval } from "./observability";
import { buildFilterPolicy, metadataRejection, compileDocumentFilter, policyKeys, type FilterPolicy, type Metadata } from "./metadata-policy";

export function filterCatalog(rows: { id: string; metadata: Metadata }[], policy: FilterPolicy) {
  if (rows.length > 512) throw new SupportError(503, "The corpus exceeds the bounded metadata compatibility limit. An administrator must configure a supported larger-corpus strategy; filters were not relaxed.");
  const rejections: Record<string, number> = {};
  const eligible = rows.filter(row => {
    const reason = metadataRejection(row.metadata, policy);
    if (reason) rejections[reason] = (rejections[reason] || 0) + 1;
    return !reason;
  });
  return { eligible, rejections, filter: eligible.length ? compileDocumentFilter(eligible, policy) : undefined };
}
export async function prepareMetadataScope(context: ConversationDetail["context"], signal: AbortSignal) {
  const policy = buildFilterPolicy(context);
  const catalog = (await retrievalRead<{ id: string; metadata: Metadata }>(
    `SELECT c.id,c.metadata FROM support_chunks c JOIN support_documents d ON d.id=c.document_id
     WHERE d.status='ready' AND d.namespace=$1 AND d.embedding_model=$2 ORDER BY c.id LIMIT 513`,
    [namespace(), embeddingModel()], signal)).rows;
  const scope = filterCatalog(catalog, policy);
  const identity = filterIdentity(policy, namespace(), embeddingModel());
  retrievalMetrics({ ...identity, catalogCount: catalog.length, eligibleCount: scope.eligible.length,
    rejectionCounts: scope.rejections, policyKeys: policyKeys(policy) });
  diagnostic({
    event: "rag_metadata", policyKeys: policyKeys(policy), catalogCount: catalog.length, eligibleCount: scope.eligible.length,
    rejectionCounts: scope.rejections, compatibility: "bounded_catalog", providerClauseCount: scope.eligible.length, ...identity,
  });
  return { ...scope, policy, catalogCount: catalog.length, catalogIds: new Set(catalog.map(r => r.id)),
    eligibleIds: scope.eligible.map(r => r.id), identity };
}

// Canonical rerank target: no generated hints and no assumed facts.
export function originalQuery(state: Triage, context: ConversationDetail["context"]) {
  const symptom = {
    unknown: "", connectedNoInternet: "Wi-Fi stays connected but internet stops",
    disconnects: "Wi-Fi disconnects completely", cannotConnect: "Cannot connect to Wi-Fi",
  }[state.symptom];
  return [state.originalIssue, ...Object.values(context).filter(v => typeof v === "string" && known(v)), symptom]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

// Isolated read-only transactions impose real PostgreSQL statement limits.
// Late pool acquisition is released even if the caller has already timed out.
export async function retrievalRead<T extends Record<string, unknown>>(text: string, values: unknown[], signal: AbortSignal) {
  return bounded(async () => {
    const client = await pool.connect();
    let released = false;
    const abort = () => { if (!released) { released = true; client.release(true); } };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('statement_timeout','5000',true)");
      const result = await client.query<T>(text, values);
      signal.throwIfAborted();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (!released) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      if (!released) { released = true; client.release(); }
    }
  }, signal);
}

export async function retrieve(state: Triage, context: ConversationDetail["context"], progress: (stage: string) => void, turnSignal?: AbortSignal) {
  return withRetrieval(async () => {
  const config = fusionConfig();
  const start = performance.now();
  const signal = turnSignal ? AbortSignal.any([turnSignal, AbortSignal.timeout(config.totalMs)]) : AbortSignal.timeout(config.totalMs);
  const scope = await prepareMetadataScope(context, signal);
  const eligibleIds = new Set(scope.eligibleIds);
  const query = originalQuery(state, context);
  progress(config.enabled && config.maxQueries > 1 ? "Preparing complementary knowledge searches" : "Searching the knowledge base");
  const plan = scope.eligible.length ? await queryPlan(query, enhancedQuery(state, context), config, signal, completion)
    : { queries: [], generation: "scope_empty" };
  const generationMs = Math.round(performance.now() - start);
  const generation = { generation: plan.generation, queryCount: plan.queries.length,
    generatedVariantCount: plan.generation === "accepted" ? plan.queries.length - 1 : 0 };
  retrievalMetrics({ ...generation, generationMs });
  progress("Searching semantic and keyword evidence");
  let denseProviderCount = 0, denseScopeRejected = 0, unknownSourceRecords = false;
  const result = await retrieveBranches(plan.queries, config, signal, async (variant, child) => {
    const [vector] = await embed([variant], "query", child);
    // Push actual Documents API metadata predicates before provider scoring.
    // Oversample the bounded synchronized catalog, then intersect by stable ID
    // BEFORE the 40-per-list and 24-fused budgets. This handles legacy aliases
    // without pretending normalized fields exist in the original Pinecone index.
    const hits = await searchSource(vector!, child, { filter: scope.filter!, topK: Math.max(40, scope.catalogCount) });
    denseProviderCount += hits.length;
    if (hits.some(h => !scope.catalogIds.has(h.id))) {
      unknownSourceRecords = true;
      throw new SupportError(503, "The source corpus changed. Validate and synchronize before retrying.");
    }
    const allowed = hits.filter(h => eligibleIds.has(h.id));
    denseScopeRejected += hits.length - allowed.length;
    return allowed;
  }, async (variant, child) => {
    const keywords = lexicalQuery(variant);
    return (await retrievalRead<{ id: string }>(`SELECT c.id FROM support_chunks c JOIN support_documents d ON d.id=c.document_id
      WHERE d.status='ready' AND d.namespace=$2 AND d.embedding_model=$3
      AND ($4::text='' OR c.text ~* $4)
      AND c.id=ANY($5::text[])
      AND to_tsvector('english',c.text) @@ to_tsquery('english',$1)
      ORDER BY ts_rank_cd(to_tsvector('english',c.text),to_tsquery('english',$1)) DESC,c.id ASC LIMIT 40`,
    [keywords || "zznomatchingkeywords", namespace(), embeddingModel(), state.topic === "wifi" ? "wi[[:space:]-]?fi|wireless" : "", scope.eligibleIds], child)).rows
      .filter(h => eligibleIds.has(h.id));
  }, scope.identity);
  const diagnostics = {
    event: "rag_fusion", enabled: config.enabled, generation: plan.generation,
    ...result.diagnostics, fusedCount: result.fusedCount, shortlistCount: result.ids.length,
    generationMs, retrievalMs: Math.round(performance.now() - start) - generationMs,
    elapsedMs: Math.round(performance.now() - start),
    denseProviderCount, denseScopeRejected, policyKeys: policyKeys(scope.policy), ...scope.identity,
    generatedVariantCount: generation.generatedVariantCount,
  };
  retrievalMetrics(diagnostics);
  diagnostic(diagnostics);
  if (unknownSourceRecords) throw new SupportError(503, "The source corpus changed. An administrator must validate and synchronize it before retrying.");
  if (scope.eligible.length && (!result.diagnostics.successfulBranches || (!result.ids.length && result.diagnostics.failedBranches > 0))) {
    throw new SupportError(503, "Knowledge retrieval services are unavailable. Please retry; this is not a confirmed knowledge coverage gap.");
  }
  return { query, ids: result.ids, diagnostics, signal, started: start, policy: scope.policy };
  });
}
