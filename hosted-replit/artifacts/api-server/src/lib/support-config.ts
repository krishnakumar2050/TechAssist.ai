import { z } from "zod";

export const embeddingModel = () => "llama-text-embed-v2";
export const rerankModel = "bge-reranker-v2-m3";
export const indexName = () => process.env.PINECONE_INDEX_NAME || "techassist-laptops-hybrid";
export const namespace = () => process.env.PINECONE_NAMESPACE || "laptop-corpus-recursive-v2";
export const generationModel = () => process.env.NEBIUS_MODEL || "Qwen/Qwen3-30B-A3B-Instruct-2507";
export function pineconeHost() {
  const raw = process.env.PINECONE_INDEX_HOST || "https://techassist-laptops-hybrid-4rxtk29.svc.aped-4627-b74a.pinecone.io";
  const url = new URL(raw.startsWith("https://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".pinecone.io") || url.username || url.password || url.port) {
    throw new Error("Invalid Pinecone host");
  }
  return url.origin;
}
export function configurationChecks() {
  return ["NEBIUS_API_KEY", "PINECONE_API_KEY", "DATABASE_URL"].map(name => ({
    name, configured: Boolean(process.env[name]),
  }));
}
export class SupportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function providerJson(url: string, body: unknown, provider: "nebius" | "pinecone", signal?: AbortSignal) {
  const target = new URL(url);
  const allowed = provider === "nebius"
    ? target.origin === "https://api.tokenfactory.nebius.com"
    : [pineconeHost(), "https://api.pinecone.io"].includes(target.origin);
  if (!allowed || target.username || target.password) throw new SupportError(500, "Invalid provider endpoint.");
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: provider === "nebius"
      ? { Authorization: `Bearer ${process.env.NEBIUS_API_KEY}`, "Content-Type": "application/json" }
      : { "Api-Key": process.env.PINECONE_API_KEY || "", ...(body === undefined ? {} : { "Content-Type": "application/json" }), "X-Pinecone-Api-Version": "2026-07" },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
  });
  // Provider response bodies may contain sensitive context; never send them to employees or logs.
  if (!response.ok) throw new SupportError(502, `${provider === "pinecone" ? "Pinecone" : "Nebius"} ${target.pathname} returned HTTP ${response.status}. Check provider permissions, model access, and configuration.`);
  return response.json();
}
export async function completion(system: string, input: string, maxTokens = 1200, signal?: AbortSignal): Promise<string> {
  const data = await providerJson("https://api.tokenfactory.nebius.com/v1/chat/completions", {
    model: generationModel(), temperature: 0, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: input }],
  }, "nebius", signal);
  const text = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) }).parse(data).choices[0]?.message.content;
  if (typeof text !== "string") throw new SupportError(502, "The support service returned an invalid response. Please retry.");
  return text;
}
export async function embed(texts: string[], inputType: "query" | "passage" = "query", signal?: AbortSignal): Promise<number[][]> {
  const data = await providerJson("https://api.pinecone.io/embed", {
    model: embeddingModel(), inputs: texts.map(text => ({ text })),
    parameters: { input_type: inputType, dimension: 1024, truncate: "END" },
  }, "pinecone", signal);
  const rows = z.object({ data: z.array(z.object({ values: z.array(z.number().finite()).length(1024) })) }).parse(data).data;
  if (rows.length !== texts.length) {
    throw new SupportError(502, "The knowledge service returned invalid embeddings.");
  }
  return rows.map(row => row.values);
}
export async function rerank(query: string, documents: { id: string; text: string }[], signal?: AbortSignal) {
  const data = await providerJson("https://api.pinecone.io/rerank", {
    model: rerankModel, query, documents, top_n: Math.min(5, documents.length),
    return_documents: false, parameters: { truncate: "END" },
  }, "pinecone", signal);
  return z.object({ data: z.array(z.object({ index: z.number().int().min(0), score: z.number().finite() })) }).parse(data).data;
}
