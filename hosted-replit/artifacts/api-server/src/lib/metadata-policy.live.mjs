// Read-only real Documents API contract checks on approved corpus metadata.
// Does not read histories, change roles, persist chats or mutate source vectors.
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { embed, namespace, embeddingModel, providerJson, pineconeHost } from "./support-config.ts";
import { searchSource, sourceProfile } from "./pinecone-source.ts";
import { buildFilterPolicy } from "./metadata-policy.ts";
import { filterCatalog } from "./retrieval.ts";
import { lexicalQuery } from "./support-triage.ts";

try {
  const profile = await sourceProfile(true);
  assert.equal(profile.mode, "documents");
  const { rows } = await pool.query(`SELECT c.id,c.metadata FROM support_chunks c JOIN support_documents d ON d.id=c.document_id
    WHERE d.status='ready' AND d.namespace=$1 AND d.embedding_model=$2 ORDER BY c.id LIMIT 513`, [namespace(), embeddingModel()]);
  const signal = AbortSignal.timeout(45000);
  const [vector] = await embed(["Synthetic Windows 11 camera works in Camera app but preview black in Microsoft Teams"], "query", signal);
  const before = await searchSource(vector, signal);
  const cases = [
    ["windows11", { os: "Windows 11" }, {}],
    ["macos", { os: "macOS" }, {}],
    ["ubuntu", { os: "Ubuntu" }, {}],
    ["windows10", { os: "Windows 10" }, {}],
    ["windows11-dell", { os: "Windows 11", vendor: "dell", deviceType: "laptop" }, {}],
    ["windows11-hardware", { os: "Windows 11" }, { category: ["hardware"] }],
    ["windows11-networking", { os: "Windows 11" }, { subcategory: ["networking"], language: ["en"] }],
    ["language-no-match", { os: "Windows 11" }, { language: ["fr"] }],
  ];
  const results = [];
  for (const [label, context, settings] of cases) {
    const policy = buildFilterPolicy(context, settings);
    const scope = filterCatalog(rows, policy);
    const hits = scope.eligible.length ? await searchSource(vector, signal, { filter: scope.filter, topK: Math.max(40, rows.length) }) : [];
    const allowed = new Set(scope.eligible.map(r => r.id));
    assert.ok(hits.every(h => allowed.has(h.id)), "Provider returned an out-of-scope ID");
    assert.equal(new Set(hits.map(h => h.id)).size, allowed.size, "Provider filtered result did not match canonical scope");
    const keywords = lexicalQuery("Windows 11 Wi-Fi connected without internet");
    const lexicalSql = `SELECT c.id FROM support_chunks c JOIN support_documents d ON d.id=c.document_id
      WHERE d.status='ready' AND d.namespace=$1 AND d.embedding_model=$2
      AND to_tsvector('english',c.text) @@ to_tsquery('english',$3)`;
    const lexicalBefore = await pool.query(`${lexicalSql} ORDER BY c.id LIMIT 40`, [namespace(), embeddingModel(), keywords]);
    const lexicalAfter = await pool.query(`${lexicalSql} AND c.id=ANY($4::text[]) ORDER BY c.id LIMIT 40`,
      [namespace(), embeddingModel(), keywords, [...allowed]]);
    assert.ok(lexicalAfter.rows.every(r => allowed.has(r.id)));
    results.push({ label, catalogCount: rows.length, denseBefore: before.length, eligibleCount: allowed.size,
      denseAfter: hits.length, lexicalBefore: lexicalBefore.rows.length, lexicalAfter: lexicalAfter.rows.length,
      rejectionCounts: scope.rejections,
      retainedHighRiskCount: scope.eligible.filter(r => r.metadata.risk_level === "high").length,
      retainedEditorialCount: scope.eligible.filter(r => r.metadata.technical_validation === "not_lab_tested").length });
  }
  // Exercise the real endpoint with both a positive and impossible equality,
  // independently of the app's no-match short circuit.
  const endpoint = `${pineconeHost()}/namespaces/${encodeURIComponent(namespace())}/documents/search`;
  const contract = [];
  for (const [label, filter] of [
    ["positive-compound", { $and: [{ language: { $eq: "en" } }, { category: { $in: ["hardware"] } }] }],
    ["impossible-language", { language: { $eq: "zz-contract-no-match" } }],
  ]) {
    const result = await providerJson(endpoint, { score_by: [{ type: "dense_vector", fields: ["embedding"], values: vector }],
      top_k: 40, include_fields: ["language", "category"], filter }, "pinecone", signal);
    if (label === "impossible-language") assert.equal(result.matches.length, 0);
    else assert.ok(result.matches.length > 0 && result.matches.every(m => m.language === "en" && m.category === "hardware"));
    contract.push({ label, http: 200, matches: result.matches.length });
  }
  process.stdout.write(JSON.stringify({ syntheticOnly: true, sourceWrites: 0, profile: profile.mode, contract, results }, null, 2) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ syntheticOnly: true, error: error.name === "AssertionError" ? error.message : "Live metadata/provider contract failed; no raw provider error or credentials disclosed." }) + "\n");
  process.exitCode = 1;
} finally { await pool.end(); }
