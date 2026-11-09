import { z } from "zod";
import { indexName, namespace, pineconeHost, providerJson, SupportError } from "./support-config";
import type { DocumentFilter } from "./metadata-policy";

type SourceProfile = { mode: "documents" | "vectors"; field?: string };
let cached: { host: string; until: number; value: SourceProfile } | undefined;

// Describe the actual index. Converted document indexes reject all legacy reads.
export async function sourceProfile(refresh = false, signal?: AbortSignal): Promise<SourceProfile> {
  const host = pineconeHost();
  if (!refresh && cached?.host === host && cached.until > Date.now()) return cached.value;
  const index = z.object({
    name: z.string(), host: z.string(), dimension: z.number().optional(), metric: z.string().optional(),
    status: z.object({ ready: z.boolean() }),
    schema: z.object({ fields: z.record(z.string(), z.object({
      type: z.string(), dimension: z.number().optional(), metric: z.string().optional(),
    }).passthrough()) }).optional(),
  }).parse(await providerJson(`https://api.pinecone.io/indexes/${encodeURIComponent(indexName())}`, undefined, "pinecone", signal));
  if (index.name !== indexName() || `https://${index.host.replace(/^https:\/\//, "")}` !== host || !index.status.ready) {
    throw new SupportError(409, "Pinecone index name, host or ready state does not match the approved source.");
  }
  let value: SourceProfile;
  if (index.schema) {
    const field = index.schema.fields.embedding;
    if (!field || field.type !== "dense_vector" || field.dimension !== 1024 || field.metric !== "cosine") {
      throw new SupportError(409, "Document index compatibility failed: expected embedding dense-vector field, 1024 dimensions and cosine.");
    }
    value = { mode: "documents", field: "embedding" };
  } else {
    if (index.dimension !== 1024 || index.metric !== "cosine") throw new SupportError(409, "Index compatibility failed: expected 1024 dimensions and cosine.");
    value = { mode: "vectors" };
  }
  cached = { host, until: Date.now() + 300000, value };
  return value;
}
function documentsPath(operation: string) {
  return `${pineconeHost()}/namespaces/${encodeURIComponent(namespace())}/documents/${operation}`;
}
export async function listSource(cursor?: string) {
  const source = await sourceProfile();
  if (source.mode === "documents") {
    const page = z.object({
      documents: z.array(z.object({ _id: z.string().min(1) })),
      pagination: z.object({ next: z.string().optional() }).optional(),
    }).parse(await providerJson(documentsPath("list"), { limit: 100, ...(cursor ? { pagination_token: cursor } : {}) }, "pinecone"));
    return { ids: page.documents.map(d => d._id), next: page.pagination?.next };
  }
  const params = new URLSearchParams({ namespace: namespace(), limit: "100" });
  if (cursor) params.set("paginationToken", cursor);
  const page = z.object({
    vectors: z.array(z.object({ id: z.string().min(1) })),
    pagination: z.object({ next: z.string().optional() }).optional(),
  }).parse(await providerJson(`${pineconeHost()}/vectors/list?${params}`, undefined, "pinecone"));
  return { ids: page.vectors.map(d => d.id), next: page.pagination?.next };
}
export type SourceRecord = { id: string; values: number[]; metadata: Record<string, unknown> };
export async function fetchSource(ids: string[]): Promise<SourceRecord[]> {
  const source = await sourceProfile();
  if (source.mode === "documents") {
    const result = z.object({ documents: z.record(z.string(), z.record(z.string(), z.unknown())) })
      .parse(await providerJson(documentsPath("fetch"), { ids, include_fields: ["*"] }, "pinecone"));
    return ids.map(id => {
      const row = result.documents[id];
      if (!row || row._id !== id) throw new SupportError(409, "A listed corpus record was missing during fetch. Retry against a stable corpus.");
      const { _id, embedding, ...metadata } = row;
      return { id, values: z.array(z.number()).parse(embedding), metadata };
    });
  }
  const params = new URLSearchParams({ namespace: namespace() });
  ids.forEach(id => params.append("ids", id));
  const result = z.object({ vectors: z.record(z.string(), z.object({
    id: z.string(), values: z.array(z.number()), metadata: z.record(z.string(), z.unknown()),
  })) }).parse(await providerJson(`${pineconeHost()}/vectors/fetch?${params}`, undefined, "pinecone"));
  return ids.map(id => {
    const record = result.vectors[id];
    if (!record || record.id !== id) throw new SupportError(409, "A listed corpus record was missing during fetch. Retry against a stable corpus.");
    return record;
  });
}
export async function searchSource(vector: number[], signal?: AbortSignal, options?: { filter: DocumentFilter; topK: number }) {
  const source = await sourceProfile(false, signal);
  if (source.mode === "documents") {
    const result = z.object({ matches: z.array(z.object({ _id: z.string() })) }).parse(
      await providerJson(documentsPath("search"), {
        score_by: [{ type: "dense_vector", fields: [source.field!], values: vector }],
        // _id is returned automatically; requesting it as a field is rejected.
        top_k: options?.topK || 40, include_fields: ["title"],
        ...(options ? { filter: options.filter } : {}),
      }, "pinecone", signal));
    return result.matches.map(m => ({ id: m._id }));
  }
  return z.object({ matches: z.array(z.object({ id: z.string() })) }).parse(
    await providerJson(`${pineconeHost()}/query`, { namespace: namespace(), vector, topK: options?.topK || 40, includeMetadata: false,
      ...(options ? { filter: options.filter } : {}) }, "pinecone", signal)).matches;
}
