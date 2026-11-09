import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import { answer } from "./rag.ts";
import { originalQuery } from "./retrieval.ts";
import { fusionConfig, distinctQueries, parseVariants, queryPlan, fuseLists, retrieveBranches, bounded } from "./rag-fusion.ts";

const cfg = { enabled: true, maxQueries: 4, concurrency: 2, generationMs: 100, branchMs: 100, totalMs: 1000 };
const signal = () => AbortSignal.timeout(2000);
const hits = (...ids) => ids.map(id => ({ id }));
const state = { originalIssue: "Camera works but Teams preview is black", topic: "other", symptom: "unknown" };
const context = { os: "Windows 11", model: "[unknown]", application: "Microsoft Teams" };
const anchor = originalQuery(state, context);
const enhanced = `${anchor} guidance`;

test("cross-query RRF rewards corroboration, not incompatible raw scores", () => {
  const result = fuseLists([hits("a", "b"), hits("b", "c"), hits("b", "a")]);
  assert.deepEqual(result.ids, ["b", "a", "c"]);
  assert.equal(result.fusedCount, 3);
});
test("duplicate hits vote once and do not distort within-list rank", () => {
  assert.deepEqual(fuseLists([hits("a", "a", "b"), hits("b", "a")]), fuseLists([hits("a", "b"), hits("b", "a")]));
});
test("stable ID tie-break is deterministic and combined shortlist is bounded", () => {
  assert.deepEqual(fuseLists([hits("z", "a"), hits("a", "z")]).ids, ["a", "z"]);
  assert.equal(fuseLists([hits(...Array.from({ length: 80 }, (_, i) => `id-${i}`))]).ids.length, 24);
});
test("query normalization deduplicates whitespace and case including original", async () => {
  assert.deepEqual(distinctQueries(["  Camera   black ", "camera black", "CAMERA BLACK", "Teams"], 4), ["Camera black", "Teams"]);
  const result = await retrieveBranches(["one", " ONE ", "two"], cfg, signal(), async () => hits("a"), async () => hits("b"));
  assert.equal(result.diagnostics.queryCount, 2);
  assert.equal(result.diagnostics.successfulBranches, 4);
});
test("bounded structured variants retain verbatim original facts, OS, product and codes", () => {
  const original = "Camera not working in Microsoft Teams Windows 11 error 0xA00F";
  const result = parseVariants(JSON.stringify({ queries: ["Microsoft Teams camera not working Windows 11 error 0xA00F troubleshooting"] }), original, original, 4);
  assert.equal(result[0], original);
  assert.ok(result[1].startsWith(original));
  assert.equal(parseVariants(JSON.stringify({ queries: [original.toUpperCase()] }), original, original, 4).length, 1);
  assert.throws(() => parseVariants(JSON.stringify({ queries: ["Windows 10 camera not working"] }), original, original, 4), /Unverified/);
});
test("invalid JSON, shape, oversized content, invented facts and changed negation fall back", async () => {
  const original = "Camera not working Windows 11";
  const enhanced = `${original} camera app`;
  const invalid = [
    "not JSON", '{"queries":"wrong"}', '{"queries":[],"facts":"invented"}',
    JSON.stringify({ queries: Array(4).fill("camera") }),
    JSON.stringify({ queries: ["x".repeat(701)] }),
    JSON.stringify({ queries: ["Camera Windows 11 WPA enterprise certificate reset"] }),
    JSON.stringify({ queries: ["Camera working Windows 11"] }),
    JSON.stringify({ queries: ["Camera not working Windows 11 unknown"] }),
  ];
  for (const raw of invalid) {
    const plan = await queryPlan(original, enhanced, cfg, signal(), async () => raw);
    assert.equal(plan.generation, "fallback");
    assert.deepEqual(plan.queries, [original, enhanced]);
  }
});
test("only duplicates, generation failure and timeout keep original plus deterministic enhancement", async () => {
  for (const generate of [
    async () => JSON.stringify({ queries: [anchor, anchor.toUpperCase(), enhanced] }),
    async () => { throw new Error("private upstream error"); },
    async () => { await new Promise(r => setTimeout(r, 150)); return '{"queries":[]}'; },
  ]) {
    const result = await queryPlan(anchor, enhanced, cfg, signal(), generate);
    assert.deepEqual(result.queries, [anchor, enhanced]);
    assert.equal(result.generation, "fallback");
  }
});
test("feature disabled or maximum one bypasses generation and preserves prior enhanced search", async () => {
  for (const config of [{ ...cfg, enabled: false }, { ...cfg, maxQueries: 1 }]) {
    const result = await queryPlan(anchor, enhanced, config, signal(), async () => { throw new Error("must not call"); });
    assert.deepEqual(result.queries, [enhanced]);
  }
});
test("partial alternative/channel failures retain original successful lists", async () => {
  const result = await retrieveBranches(["original", "alternative"], cfg, signal(),
    async q => { if (q === "alternative") throw new Error("upstream"); return hits("original-id"); },
    async q => q === "original" ? hits("original-id") : hits("alternative-id"));
  assert.deepEqual(result.ids, ["original-id", "alternative-id"]);
  assert.equal(result.diagnostics.successfulBranches, 3);
  assert.equal(result.diagnostics.failedBranches, 1);
  assert.equal(result.diagnostics.originalSuccessfulBranches, 2);
});
test("successful branches survive an alternative timeout and successful empty lists are not provider failures", async () => {
  const result = await retrieveBranches(["original", "alternative"], { ...cfg, branchMs: 20 }, signal(),
    async (q, child) => q === "original" ? [] : bounded(() => new Promise(() => {}), child),
    async q => q === "original" ? hits("original-id") : []);
  assert.deepEqual(result.ids, ["original-id"]);
  assert.equal(result.diagnostics.failedBranches, 1);
  assert.equal(result.diagnostics.successfulBranches, 3);
});
test("query concurrency and deadlines bound outstanding work", async () => {
  let active = 0, maximum = 0;
  const work = async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 10)); active--; return hits("a"); };
  await retrieveBranches(["a", "b", "c", "d"], cfg, signal(), work, work);
  assert.ok(maximum <= cfg.concurrency * 2);
  const controller = new AbortController();
  const pending = bounded(() => new Promise(() => {}), controller.signal);
  controller.abort();
  await assert.rejects(pending, /timed out/);
});

// Full answer-path tests: canonical persistent metadata is fetched once after
// fusion; unrelated high-ranking hits must never become rerank evidence.
const originals = { connect: pool.connect, fetch: globalThis.fetch, log: logger.info };
let mode = "normal", rerankQuery, rerankIds, mappingCount = 0;
const events = [];
const docs = [
  { id: "approved", title: "Windows 11 Camera in Teams", text: "Windows 11 Camera works but Microsoft Teams preview is black. Choose the camera in Teams.", source_url: "https://support.example.test/approved", metadata: { platform: "Windows 11", source_urls: ["https://support.example.test/approved"] } },
  { id: "unrelated", title: "Bluetooth startup problem", text: "Windows 11 Bluetooth startup", source_url: "https://support.example.test/unrelated", metadata: { platform: "Windows 11" } },
].map(d => ({ ...d, metadata: { ...d.metadata, document_id: d.id, embedding_model: "llama-text-embed-v2" } }));
pool.connect = async () => ({
  query: async (sql) => {
    if (sql.includes("SELECT c.id,c.metadata")) return { rows: docs.map(({ id, metadata }) => ({ id, metadata })) };
    if (mode === "all-fail" && sql.includes("SELECT c.id FROM")) throw new Error("private db error");
    if (mode === "dense-fail-empty-lexical" && sql.includes("SELECT c.id FROM")) return { rows: [] };
    if (sql.includes("SELECT c.id FROM")) return { rows: hits("unrelated", "approved") };
    if (sql.includes("SELECT c.id,c.title")) { mappingCount++; return { rows: mode === "missing-mapping" ? [] : [...docs].reverse() }; }
    return { rows: [] };
  },
  release() {},
});
logger.info = data => events.push(data);
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname, body = JSON.parse(options.body || "{}");
  if (["all-fail", "dense-fail-empty-lexical"].includes(mode) && path === "/embed") throw new Error("private provider error");
  let data;
  if (path.endsWith("/chat/completions")) {
    const system = body.messages[0].content;
    data = { choices: [{ message: { content: system.includes("Generate complementary")
      ? JSON.stringify({ queries: ["Teams preview black Camera works Windows 11 Microsoft"] })
      : JSON.stringify({ step: "Choose the camera in Teams", explanation: "Approved evidence.", navigation: "", expectedResult: "Preview may appear.", citationIds: ["approved"] }) } }] };
  } else if (path === "/embed") data = { data: [{ values: Array(1024).fill(0.01) }] };
  else if (path.startsWith("/indexes/")) data = { name: "techassist-laptops-hybrid", host: "techassist-laptops-hybrid-4rxtk29.svc.aped-4627-b74a.pinecone.io", status: { ready: true }, schema: { fields: { embedding: { type: "dense_vector", dimension: 1024, metric: "cosine" } } } };
  else if (path.endsWith("/documents/search")) data = { matches: [{ _id: "unrelated" }, { _id: "approved" }] };
  else if (path === "/rerank") {
    rerankQuery = body.query; rerankIds = body.documents.map(d => d.id);
    data = { data: mode === "bad-rerank" ? [{ index: 9, score: 0.99 }] : [{ index: 0, score: 0.99 }] };
  } else throw new Error("Unexpected test endpoint");
  return new Response(JSON.stringify(data), { status: 200 });
};
const chat = () => ({ id: "synthetic-only", title: "[SYNTHETIC TEST]", status: "open", updatedAt: new Date().toISOString(), context: { ...context }, messages: [], attempts: [] });
test("original issue/context is the rerank target; fused hits map to canonical metadata and exclude unrelated topics", async () => {
  const result = await answer(chat(), state.originalIssue, () => {});
  assert.equal(rerankQuery, anchor);
  assert.deepEqual(rerankIds, ["approved"]);
  assert.equal(mappingCount, 1);
  assert.equal(result.citations[0].url, docs[0].source_url);
  assert.equal(result.citations[0].excerpt, docs[0].text);
});
test("total retrieval failure is a service error, never a corpus-gap handoff", async () => {
  for (mode of ["all-fail", "dense-fail-empty-lexical"]) {
    await assert.rejects(() => answer(chat(), state.originalIssue, () => {}), error => error.status === 503 && /not a confirmed knowledge coverage gap/.test(error.message));
  }
  mode = "normal";
});
test("missing synchronized IDs and invalid reranker mappings fail explicitly", async () => {
  mode = "missing-mapping";
  await assert.rejects(() => answer(chat(), state.originalIssue, () => {}), /out of sync/);
  mode = "bad-rerank";
  await assert.rejects(() => answer(chat(), state.originalIssue, () => {}), /invalid evidence references/);
  mode = "normal";
});
test("fusion diagnostics expose only aggregate counts and timings", () => {
  const allowed = ["event", "enabled", "generation", "queryCount", "successfulBranches", "failedBranches", "originalSuccessfulBranches", "denseCount", "lexicalCount", "fusedCount", "shortlistCount", "generationMs", "retrievalMs", "elapsedMs", "denseProviderCount", "denseScopeRejected", "policyKeys", "filterFingerprint", "scope", "requestId", "retrievalId", "generatedVariantCount"];
  for (const event of events.filter(e => e.event === "rag_fusion")) {
    assert.ok(Object.keys(event).every(k => allowed.includes(k)));
    assert.doesNotMatch(JSON.stringify(event), /Camera|Teams|approved|private|example\.test/);
  }
});
test("configuration defaults have hard caps and reject unsafe configuration", () => {
  assert.ok(fusionConfig().maxQueries <= 4);
  const prior = process.env.RAG_FUSION_MAX_QUERIES;
  process.env.RAG_FUSION_MAX_QUERIES = "99";
  assert.throws(fusionConfig, /Invalid RAG_FUSION_MAX_QUERIES/);
  if (prior === undefined) delete process.env.RAG_FUSION_MAX_QUERIES; else process.env.RAG_FUSION_MAX_QUERIES = prior;
});
after(async () => { pool.connect = originals.connect; globalThis.fetch = originals.fetch; logger.info = originals.log; await pool.end(); });
