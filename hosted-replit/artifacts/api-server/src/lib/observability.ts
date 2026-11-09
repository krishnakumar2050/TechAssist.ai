import { createHash, randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import { logger } from "./logger";
import { correlation, requestContext, traceStorage } from "./trace-context";
import type { FilterPolicy } from "./metadata-policy";

export { correlation, linkTrace, requestContext } from "./trace-context";
export function serverRequestId(_req: unknown, res: Pick<Response, "setHeader">) {
  const id = randomUUID();
  res.setHeader("X-Request-ID", id);
  return id;
}
export function correlatedPayload<T extends object>(payload: T) {
  return { ...payload, correlation: correlation() };
}
export function diagnostic(fields: Record<string, unknown>) {
  // Call sites pass allowlisted scalar/count/scope fields, never exception objects.
  logger.info({ ...fields, ...correlation() }, "Support diagnostics");
}
export function errorCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled";
  const value = error as { name?: string; status?: number; code?: string };
  if (value?.name === "TimeoutError" || value?.code === "RAG_TIMEOUT") return "timeout";
  if (value?.name === "AbortError" || value?.code === "RAG_CANCELLED") return "cancelled";
  return [400, 401, 403, 404, 409, 422, 429, 500, 502, 503].includes(value?.status || 0)
    ? `http_${value.status}` : "service_error";
}
export function retrievalMetrics(fields: Record<string, unknown>) {
  const state = traceStorage.getStore();
  if (state?.metrics) Object.assign(state.metrics, fields);
}
export function filterIdentity(policy: FilterPolicy, namespace: string, embeddingModel: string) {
  const canonical = Object.fromEntries(Object.entries({ ...policy, namespace, embeddingModel, ready: true,
    embeddingProvider: "pinecone", dimensions: 1024 }).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, Array.isArray(value) ? [...new Set(value)].sort() : value]));
  return {
    filterFingerprint: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"),
    scope: {
      family: policy.family || "unconfirmed", version: policy.version || "unconfirmed",
      deviceType: policy.deviceType || "unconfirmed", vendor: policy.vendor || "unconfirmed",
      category: policy.category, subcategory: policy.subcategory, language: policy.language,
      freshnessConfigured: Boolean(policy.reviewedAfter),
    },
  };
}
export async function withRetrieval<T>(work: () => Promise<T>): Promise<T> {
  const parent = traceStorage.getStore();
  if (parent?.retrievalId) return work();
  const state = { ...(parent || { requestId: randomUUID() }), retrievalId: randomUUID(), metrics: {
    generation: "not_started", queryCount: 0, generatedVariantCount: 0, catalogCount: null, eligibleCount: null,
    rejectionCounts: {}, successfulBranches: 0, failedBranches: 0, fusedCount: 0, rerankCount: 0, selectedCount: 0,
  } as Record<string, unknown> };
  return traceStorage.run(state, async () => {
    const start = performance.now();
    let status = "success", code: string | undefined;
    diagnostic({ event: "rag_retrieval_start" });
    try {
      const result = await work();
      const reply = result as { id?: string; role?: string; kind?: string };
      if (reply?.role === "assistant" && reply.id) {
        state.assistantMessageId = reply.id;
        retrievalMetrics({ resultKind: reply.kind });
      }
      return result;
    } catch (error) {
      code = errorCode(error);
      status = code === "timeout" || code === "cancelled" ? code : "failure";
      throw error;
    } finally {
      diagnostic({ ...state.metrics, event: "rag_retrieval_terminal", status, errorCode: code,
        totalMs: Math.round(performance.now() - start) });
      if (parent) {
        parent.lastRetrievalId = state.retrievalId;
        if (state.assistantMessageId) parent.assistantMessageId = state.assistantMessageId;
      }
    }
  });
}

// Installed after pino-http and before auth/body parsing. Never accepts client IDs.
export const requestTracing: RequestHandler = (req, res, next) => {
  requestContext(() => {
    const state = traceStorage.getStore()!;
    const start = performance.now();
    let terminal = false;
    const finish = (disconnected: boolean) => traceStorage.run(state, () => {
      if (terminal) return;
      terminal = true;
      diagnostic({ event: "http_request_terminal", status: disconnected ? "client_disconnected" : res.statusCode >= 400 ? "failure" : "success",
        statusCode: res.statusCode, totalMs: Math.round(performance.now() - start) });
    });
    res.once("finish", () => finish(false));
    res.once("close", () => finish(!res.writableFinished));
    next();
  }, String(req.id));
};
