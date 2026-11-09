import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { embed, rerank, providerJson, pineconeHost } from "./support-config.ts";
import { normalizeRecord, runValidation, liveReady } from "./corpus-validation.ts";
import { answer } from "./rag.ts";
import { ingest } from "./knowledge.ts";
import { sourceProfile, listSource, fetchSource, searchSource } from "./pinecone-source.ts";
import { synchronizeCorpus } from "./corpus-bootstrap.ts";

const vector = Array(1024).fill(0.01);
const metadata = {
  text: "Windows 11 camera guidance. Check camera permission, then choose the correct camera in Microsoft Teams.",
  source_url: "https://support.example.test/camera", document_id: "approved-camera",
  platform: "Windows 11", category: "camera", embedding_model: "llama-text-embed-v2",
  embedding_provider: "pinecone", embedding_dimension: 1024, custom_provenance: "retained",
};
const record = { id: "approved-chunk-1", values: vector, metadata };
const normalized = normalizeRecord(record);
let savedReport;
let providerCalls = [];
let modelSteps = 0;
let repeat = false;
let wrongDimensions = false;
let firstPage = false;
let missingFetchedRecord = false;
let documentMode = false;
const storedChats = new Map();
const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalFetch = globalThis.fetch;
const originalKeys = [process.env.NEBIUS_API_KEY, process.env.PINECONE_API_KEY];
// Synthetic credentials only, never real credentials and never printed.
process.env.NEBIUS_API_KEY = "synthetic-test-nebius";
process.env.PINECONE_API_KEY = "synthetic-test-pinecone";

pool.query = async (sql, params) => {
  if (sql.startsWith("INSERT INTO support_conversations")) {
    storedChats.set(params[0], { id: params[0], owner_id: params[1], title: params[2], context: JSON.parse(params[3]), status: "open", messages: [], attempts: [], updated_at: new Date() });
    return { rows: [] };
  }
  if (sql.startsWith("SELECT * FROM support_conversations")) {
    const row = storedChats.get(params[0]);
    return { rows: row?.owner_id === params[1] ? [structuredClone(row)] : [] };
  }
  if (sql.startsWith("UPDATE support_conversations")) {
    const row = storedChats.get(params[0]);
    if (!row || row.owner_id !== params[1]) return { rows: [] };
    Object.assign(row, { status: params[2], context: JSON.parse(params[3]), messages: JSON.parse(params[4]), attempts: JSON.parse(params[5]), updated_at: new Date() });
    return { rows: [structuredClone(row)] };
  }
  if (sql.includes("SELECT count(*)")) return { rows: [{ count: 1 }] };
  if (sql.startsWith("SELECT report")) return { rows: savedReport ? [{ report: savedReport }] : [] };
  if (sql.startsWith("INSERT INTO support_validation")) { savedReport = JSON.parse(params[1]); return { rows: [] }; }
  if (sql.includes("SELECT c.id FROM")) return { rows: [{ id: record.id }] };
  if (sql.includes("SELECT c.id,c.metadata")) return { rows: [{ id: record.id, metadata }] };
  if (sql.includes("SELECT c.id,c.title")) return { rows: [{ id: record.id, title: "Windows 11 camera guidance", text: metadata.text, source_url: metadata.source_url, metadata }] };
  throw new Error("Unexpected test database query");
};
pool.connect = async () => ({
  query: async (sql, params) => {
    if (sql.includes("SELECT c.id FROM") || sql.includes("SELECT c.id,c.title") || sql.includes("SELECT c.id,c.metadata")) return pool.query(sql, params);
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
    if (sql.includes("to_regclass")) return { rows: [{ available: true }] };
    if (sql.includes("SELECT count(*)")) return { rows: [{ count: 1 }] };
    if (sql.includes("INSERT INTO support_chunks")) return { rowCount: 1, rows: [{ id: record.id }] };
    return { rows: [] };
  },
  release() {},
});
globalThis.fetch = async (url, options = {}) => {
  const target = new URL(url);
  const body = options.body ? JSON.parse(options.body) : undefined;
  providerCalls.push({ path: target.pathname, method: options.method, body });
  let response;
  if (target.pathname.startsWith("/indexes/")) response = {
    name: "techassist-laptops-hybrid", host: new URL(pineconeHost()).host,
    dimension: wrongDimensions ? 1536 : 1024, metric: "cosine", status: { ready: true },
    ...(documentMode ? { schema: { fields: { embedding: { type: "dense_vector", dimension: 1024, metric: "cosine" }, text: { type: "string" } } } } : {}),
  };
  else if (target.pathname === "/describe_index_stats") response = { dimension: 1024, namespaces: { "laptop-corpus-recursive-v2": { vectorCount: 1 } } };
  else if (target.pathname === "/embed") {
    assert.equal(body.model, "llama-text-embed-v2");
    assert.equal(body.parameters.dimension, 1024);
    assert.ok(["query", "passage"].includes(body.parameters.input_type));
    response = { data: body.inputs.map(() => ({ values: vector })) };
  } else if (target.pathname === "/rerank") {
    assert.equal(body.model, "bge-reranker-v2-m3");
    assert.ok(body.top_n <= 5);
    response = { data: [{ index: 0, score: 0.9 }] };
  } else if (target.pathname.endsWith("/documents/list")) {
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-Pinecone-Api-Version"], "2026-07");
    response = { documents: [{ _id: record.id }] };
  } else if (target.pathname.endsWith("/documents/fetch")) {
    assert.deepEqual(body.include_fields, ["*"]);
    const { source_url, ...m } = metadata;
    response = { documents: { [record.id]: { _id: record.id, embedding: vector, ...m, source_urls: [source_url] } } };
  } else if (target.pathname.endsWith("/documents/search")) {
    assert.equal(body.score_by[0].type, "dense_vector");
    assert.equal(body.score_by[0].values.length, 1024);
    assert.equal(body.include_fields.includes("_id"), false);
    response = { matches: [{ _id: record.id, _score: 0.9 }] };
  } else if (target.pathname === "/vectors/list") {
    if (firstPage && !target.searchParams.has("paginationToken")) response = { vectors: [], pagination: { next: "bad-cursor" } };
    else response = { vectors: [{ id: record.id }] };
  } else if (target.pathname === "/vectors/fetch") response = { vectors: missingFetchedRecord ? {} : { [record.id]: record } };
  else if (target.pathname === "/query") {
    assert.equal(body.namespace, "laptop-corpus-recursive-v2");
    assert.equal(body.vector.length, 1024);
    response = { matches: [{ id: record.id }] };
  } else if (target.pathname === "/v1/chat/completions") {
    assert.equal(body.model, "Qwen/Qwen3-30B-A3B-Instruct-2507");
    const system = body.messages[0].content;
    let content;
    if (system.includes("Generate complementary")) content = '{"queries":[]}';
    else if (system.includes("exactly OK")) content = "OK";
    else if (system.includes("Rewrite")) content = "Windows 11 Teams camera troubleshooting";
    else if (system.includes("Compare the proposed")) content = JSON.stringify({ repeats: repeat });
    else {
      modelSteps++;
      const input = JSON.parse(body.messages[1].content);
      if (input.attempts.length) assert.equal(input.attempts[0].outcome, "failed");
      content = JSON.stringify({
        step: modelSteps % 2 ? "Check Windows camera permissions" : "Choose your camera in Teams",
        explanation: "Use the approved guidance.", navigation: "", expectedResult: "A camera preview may appear.",
        citationIds: [record.id],
      });
    }
    response = { choices: [{ message: { content } }] };
  } else throw new Error("Unexpected test provider path");
  return new Response(JSON.stringify(response), { status: 200 });
};

test("source readiness requires providers and corpus; authenticated regression persists failed-step memory", async () => {
  assert.equal(await liveReady(), false);
  assert.equal((await runValidation("providers")).stage, "providers");
  assert.equal(await liveReady(), false);
  const sync = await runValidation("sync");
  assert.equal(sync.stage, "synced");
  assert.equal(sync.records, 1);
  assert.equal(await liveReady(), true);
  await assert.rejects(() => runValidation("regression"), /Sign in as an explicitly authorized administrator/);
  const regression = await runValidation("regression", "synthetic-test-owner");
  assert.equal(regression.stage, "ready");
  assert.equal(regression.queryPassed, true);
  assert.equal(regression.followupPassed, true);
  const saved = storedChats.get(regression.testConversationId);
  assert.equal(saved.owner_id, "synthetic-test-owner");
  assert.equal(saved.messages.length, 4);
  assert.equal(saved.attempts[0].outcome, "failed");
  assert.equal(saved.attempts[0].step, regression.firstStep);
  assert.notEqual(regression.firstStep, regression.followupStep);
  assert.equal(saved.context.os, "Windows 11");
  assert.equal(await liveReady(), true);
  assert.equal(providerCalls.some(c => /upsert|delete|update/.test(c.path)), false);
});
test("preserves original IDs and provenance metadata; validates every citation URL", () => {
  assert.equal(normalized.id, record.id);
  assert.deepEqual(normalized.metadata, metadata);
  assert.equal(normalized.source, metadata.source_url);
  for (const bad of ["javascript:alert(1)", "file:///private/file", "https://user:password@example.test/"]) {
    assert.throws(() => normalizeRecord({ ...record, metadata: { ...metadata, source_url: bad } }));
  }
});
test("rejects absent text, URL, document ID, platform, category and embedding model", () => {
  for (const field of ["text", "source_url", "document_id", "platform", "category", "embedding_model"]) {
    const m = { ...metadata }; delete m[field];
    assert.throws(() => normalizeRecord({ ...record, metadata: m }));
  }
});
test("rejects incompatible vector dimensions and embedding provenance", () => {
  assert.throws(() => normalizeRecord({ ...record, values: [1, 2] }));
  assert.throws(() => normalizeRecord({ ...record, metadata: { ...metadata, embedding_model: "BAAI/bge-en-icl" } }));
  assert.throws(() => normalizeRecord({ ...record, metadata: { ...metadata, embedding_provider: "nebius" } }));
});
test("index dimension mismatch blocks readiness with a specific setup error", async () => {
  wrongDimensions = true;
  const r = await runValidation("providers");
  assert.equal(r.stage, "failed"); assert.match(r.message, /compatibility failed/);
  assert.equal(await liveReady(), false);
  wrongDimensions = false;
});
test("missing fetched records fail instead of silently skipping approved corpus records", async () => {
  await runValidation("providers"); missingFetchedRecord = true;
  const r = await runValidation("sync");
  assert.equal(r.stage, "failed"); assert.match(r.message, /missing during fetch/);
  missingFetchedRecord = false;
});
test("non-advancing empty pagination fails instead of declaring full corpus coverage", async () => {
  await runValidation("providers"); firstPage = true;
  assert.equal((await runValidation("sync")).stage, "failed");
  firstPage = false;
});
test("semantic repeat guard blocks a differently-worded repeated failed action", async () => {
  repeat = true;
  const chat = {
    id: "test", title: "test", status: "open", updatedAt: new Date().toISOString(),
    context: { os: "Windows 11", model: "", application: "Teams" }, messages: [],
    attempts: [{ messageId: "prior", step: "Previously attempted action", outcome: "failed" }],
  };
  await assert.rejects(() => answer(chat, "Still not working", () => {}), /repeats an attempted step/);
  repeat = false;
});
test("protected source rejects ingestion and provider endpoint credential forwarding", async () => {
  await assert.rejects(() => ingest({ title: "test", content: "test text" }), /protected existing corpus/);
  await assert.rejects(() => providerJson("https://attacker.example.test/query", {}, "pinecone"), /Invalid provider endpoint/);
});
test("Pinecone embeddings use query/passage roles and rerank response contract", async () => {
  assert.equal((await embed(["test query"]))[0].length, 1024);
  assert.equal((await embed(["test passage"], "passage"))[0].length, 1024);
  assert.equal((await rerank("test", [{ id: "a", text: "test" }]))[0].score, 0.9);
});
test("document-schema indexes use Documents API for list/fetch/search without rewriting vectors", async () => {
  documentMode = true;
  assert.equal((await sourceProfile(true)).mode, "documents");
  const page = await listSource();
  assert.deepEqual(page.ids, [record.id]);
  const records = await fetchSource(page.ids);
  assert.equal(normalizeRecord(records[0]).source, metadata.source_url);
  assert.deepEqual(await searchSource(vector), [{ id: record.id }]);
  assert.equal(providerCalls.some(c => /upsert|delete|update/.test(c.path)), false);
  documentMode = false;
});
test("validates every source_urls entry, including non-primary citations", () => {
  const { source_url, ...m } = metadata;
  assert.equal(normalizeRecord({ ...record, metadata: { ...m, source_urls: [source_url, "https://support.example.test/teams"] } }).source, source_url);
  assert.throws(() => normalizeRecord({ ...record, metadata: { ...m, source_urls: [source_url, "javascript:alert(1)"] } }), /unsafe URL/);
});
test("operator synchronization is retry-safe and completed startup sync does not revalidate each cold start", async () => {
  assert.equal((await synchronizeCorpus(true)).records, 1);
  assert.equal((await synchronizeCorpus(true)).records, 1);
  const calls = providerCalls.length;
  assert.equal((await synchronizeCorpus()).stage, "synced");
  assert.equal(providerCalls.length, calls);
  assert.equal(providerCalls.some(c => /upsert|delete|update/.test(c.path)), false);
});
test.after(async () => {
  pool.query = originalQuery; pool.connect = originalConnect; globalThis.fetch = originalFetch;
  for (const [i, key] of ["NEBIUS_API_KEY", "PINECONE_API_KEY"].entries()) {
    if (originalKeys[i] === undefined) delete process.env[key]; else process.env[key] = originalKeys[i];
  }
  await pool.end();
});
