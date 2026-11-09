import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { UpdateConversationBody } from "@workspace/api-zod";
import { logger } from "./logger.ts";
import { buildFilterPolicy, metadataRejection, compileDocumentFilter, policyKeys } from "./metadata-policy.ts";
import { filterCatalog, retrieve } from "./retrieval.ts";
import { answer } from "./rag.ts";

const base = { platform: "Windows 11", device_type: "laptop", document_id: "fixture-doc", category: "software",
  subcategory: "networking", language: "en", embedding_provider: "pinecone", embedding_model: "llama-text-embed-v2",
  embedding_dimensions: 1024, reviewed_on: "2026-11-03", risk_level: "standard", technical_validation: "not_lab_tested" };
const metadata = (extra = {}) => ({ ...base, ...extra });
const policy = (os = "Windows 11", extra = {}, config = {}) => buildFilterPolicy({ os, ...extra }, config);
const rejection = (m, p = policy()) => metadataRejection(m, p);
test("Windows, macOS and Ubuntu procedures are isolated", () => {
  for (const os of ["Windows 11", "macOS", "Ubuntu"]) {
    for (const platform of ["Windows 11", "macOS", "Ubuntu desktop with NetworkManager"]) {
      assert.equal(rejection(metadata({ platform }), policy(os)) === undefined,
        os === (platform.startsWith("Ubuntu") ? "Ubuntu" : platform));
    }
  }
});
test("Windows 10/11 and unversioned Windows never silently substitute for one another", () => {
  assert.equal(rejection(metadata({ platform: "Windows 10" }), policy("Windows 10")), undefined);
  assert.equal(rejection(base, policy("Windows 10")), "os_version_mismatch");
  assert.equal(rejection(metadata({ platform: "Windows" })), "os_version_mismatch");
  assert.equal(rejection(base, policy("Windows")), "os_version_mismatch");
});
test("Dell hardware requires confirmed vendor; truly general hardware stays available", () => {
  const dell = metadata({ platform: "Dell laptops", category: "hardware" });
  const general = metadata({ platform: "general", category: "hardware" });
  assert.equal(rejection(dell), "vendor_unconfirmed");
  assert.equal(rejection(dell, policy("Windows 11", { vendor: "apple" })), "vendor_mismatch");
  assert.equal(rejection(dell, policy("Windows 11", { vendor: "dell", deviceType: "laptop" })), undefined);
  assert.equal(rejection(general), undefined);
  assert.equal(rejection(general, policy("macOS")), undefined);
  assert.equal(rejection(metadata({ platform: "macOS; Mac laptops" }), policy("macOS")), "vendor_unconfirmed");
});
test("free-text model does not infer vendor and model-specific metadata has no fabricated match", () => {
  const p = buildFilterPolicy({ os: "Windows 11", model: "Dell Latitude 7440" }, {});
  assert.equal(p.vendor, undefined);
  assert.equal(rejection(metadata({ platform: "Dell laptops" }), p), "vendor_unconfirmed");
  assert.equal(rejection(metadata({ model: "Latitude 7440" }), p), "model_scope_unsupported");
});
test("missing OS admits only explicitly general evidence; Wi-Fi still clarifies before provider work", async () => {
  assert.equal(rejection(base, policy("")), "os_unconfirmed");
  assert.equal(rejection(metadata({ platform: "general" }), policy("")), undefined);
  const result = await answer({ id: "synthetic", title: "synthetic", status: "open", context: { os: "", model: "", application: "" }, messages: [], attempts: [], updatedAt: new Date().toISOString() },
    "My laptop keeps dropping the office Wi-Fi", () => {});
  assert.equal(result.kind, "clarification"); assert.match(result.text, /operating system/);
});
test("legacy os and embedding aliases normalize; absent/unknown/conflicting metadata fails closed", () => {
  const legacy = { ...base, os: "Windows 11", embeddingModel: "llama-text-embed-v2" };
  delete legacy.platform; delete legacy.embedding_model;
  assert.equal(rejection(legacy), undefined);
  assert.equal(rejection({}), "unknown_platform");
  assert.equal(rejection(undefined), "unknown_metadata");
  assert.equal(rejection(metadata({ platform: "unknown" })), "unknown_platform");
  assert.equal(rejection(metadata({ os: "Windows 10" })), "conflicting_platform");
  assert.equal(rejection(metadata({ embedding_dimensions: 768 })), "embedding_incompatible");
});
test("optional language/category/subcategory constraints match exactly without widening", () => {
  assert.equal(rejection(base, policy("Windows 11", {}, { language: ["en"], category: ["software"], subcategory: ["networking"] })), undefined);
  assert.equal(rejection(base, policy("Windows 11", {}, { language: ["fr"] })), "language_mismatch");
  assert.equal(rejection(base, policy("Windows 11", {}, { category: ["hardware"] })), "category_mismatch");
  assert.equal(rejection(base, policy("Windows 11", {}, { subcategory: ["camera"] })), "subcategory_mismatch");
  assert.equal(rejection(metadata({ language: undefined }), policy("Windows 11", {}, { language: ["en"] })), "language_mismatch");
});
test("unsupported configuration/input and conflicting confirmed scopes are rejected", () => {
  for (const config of [{ category: ["anything"] }, { language: ["xx"] }, { subcategory: [] }, { risk_level: "standard" }, { reviewedAfter: "2026-02-30" }]) {
    assert.throws(() => policy("Windows 11", {}, config), /Invalid server metadata/);
  }
  assert.throws(() => policy("Plan 9"), /not supported/);
  assert.throws(() => policy("Windows 11", { vendor: "invented" }), /Unsupported/);
  assert.throws(() => policy("Windows 11", { deviceType: "server" }), /Unsupported/);
  assert.throws(() => policy("Windows 11", { vendor: "dell" }, { vendor: "apple" }), /conflicts/);
  assert.throws(() => UpdateConversationBody.strict().parse({ os: "", model: "", application: "", category: "hardware" }));
});
test("confirmed device constraints exclude incompatible or unknown device scope", () => {
  assert.equal(rejection(base, policy("Windows 11", { deviceType: "desktop" })), "device_mismatch");
  assert.equal(rejection(metadata({ device_type: undefined }), policy("Windows 11", { deviceType: "laptop" })), "device_unconfirmed");
  assert.equal(rejection(metadata({ device_type: "general", platform: "general" }), policy("Windows 11", { deviceType: "desktop" })), undefined);
});
test("high-risk battery evidence and not-lab-tested editorial provenance are not suppressed", () => {
  const battery = metadata({ platform: "Dell laptops", category: "hardware", subcategory: "battery_safety", risk_level: "high", technical_validation: "not_lab_tested" });
  assert.equal(rejection(battery, policy("Windows 11", { vendor: "dell", deviceType: "laptop" })), undefined);
  assert.equal(rejection({ ...battery, platform: "general" }), undefined);
});
test("review date is provenance by default; explicit valid freshness policy is enforced", () => {
  assert.equal(rejection(metadata({ reviewed_on: "2001-01-01" })), undefined);
  assert.equal(rejection(base, policy("Windows 11", {}, { reviewedAfter: "2026-11-04" })), "freshness_mismatch");
  assert.equal(rejection(base, policy("Windows 11", {}, { reviewedAfter: "2026-11-01" })), undefined);
});
test("bounded compatibility catalog cannot silently truncate and provider predicates retain legacy identities", () => {
  assert.throws(() => filterCatalog(Array.from({ length: 513 }, (_, i) => ({ id: String(i), metadata: base })), policy()), /bounded metadata compatibility limit/);
  const legacy = { ...base, os: "Windows 11", doc_id: "legacy" }; delete legacy.platform; delete legacy.document_id;
  const filter = compileDocumentFilter([{ id: "one", metadata: legacy }], policy());
  const serialized = JSON.stringify(filter);
  assert.match(serialized, /"os"/); assert.match(serialized, /"doc_id"/); assert.match(serialized, /"\$eq"/);
  assert.doesNotMatch(serialized, /"_id"|risk_level|technical_validation|reviewed_on/);
  assert.throws(() => compileDocumentFilter([{ id: "oversized", metadata: { ...base, document_id: "x".repeat(128 * 1024) } }], policy()), /payload limit/);
});

const original = { fetch: globalThis.fetch, connect: pool.connect, log: logger.info, settings: process.env.RAG_METADATA_FILTERS };
const catalog = [
  { id: "windows", metadata: metadata({ document_id: "windows" }) },
  { id: "mac", metadata: metadata({ document_id: "mac", platform: "macOS" }) },
  { id: "ubuntu", metadata: metadata({ document_id: "ubuntu", platform: "Ubuntu desktop" }) },
  { id: "battery", metadata: metadata({ document_id: "battery", platform: "general", category: "hardware", subcategory: "battery_safety", risk_level: "high" }) },
];
let mode = "normal"; const filters = [], sqlScopes = [], events = [];
function matches(filter, m) {
  if (filter.$and) return filter.$and.every(f => matches(f, m));
  if (filter.$or) return filter.$or.some(f => matches(f, m));
  return Object.entries(filter).every(([k, op]) => op.$eq === m[k]);
}
delete process.env.RAG_METADATA_FILTERS;
logger.info = event => events.push(event);
pool.connect = async () => ({
  query: async (sql, values) => {
    if (sql.includes("SELECT c.id,c.metadata")) return { rows: catalog };
    if (sql.includes("SELECT c.id FROM")) {
      assert.ok(sql.indexOf("c.id=ANY($5::text[])") < sql.indexOf("LIMIT 40"));
      sqlScopes.push([...values[4]]);
      if (mode === "all-fail") throw new Error("synthetic SQL failure");
      return { rows: catalog.filter(r => values[4].includes(r.id)).map(r => ({ id: r.id })) };
    }
    return { rows: [] };
  }, release() {},
});
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname, body = JSON.parse(options.body || "{}");
  let response;
  if (path.endsWith("/chat/completions")) response = { choices: [{ message: { content: JSON.stringify({ queries: ["Windows 11 wireless internet connected Wi-Fi", "Wi-Fi Windows 11 connected internet guidance"] }) } }] };
  else if (path === "/embed") response = { data: [{ values: Array(1024).fill(0.01) }] };
  else if (path.startsWith("/indexes/")) response = { name: "techassist-laptops-hybrid", host: "techassist-laptops-hybrid-4rxtk29.svc.aped-4627-b74a.pinecone.io", status: { ready: true }, schema: { fields: { embedding: { type: "dense_vector", dimension: 1024, metric: "cosine" } } } };
  else if (path.endsWith("/documents/search")) {
    filters.push(JSON.stringify(body.filter));
    assert.ok(body.filter); assert.equal(body.top_k, 40);
    if (["filter-fail", "all-fail"].includes(mode)) return new Response('{"error":{"code":"INVALID_ARGUMENT"}}', { status: 400 });
    response = { matches: catalog.filter(r => matches(body.filter, r.metadata)).map(r => ({ _id: r.id })) };
  } else throw new Error("Unexpected synthetic provider call");
  return new Response(JSON.stringify(response), { status: 200 });
};
const triage = { originalIssue: "Wi-Fi connected internet Windows 11", topic: "wifi", symptom: "connectedNoInternet" };
test("every multi-query dense/lexical branch shares one frozen confirmed filter policy", async () => {
  const result = await retrieve(triage, { os: "Windows 11", model: "", application: "", deviceType: "laptop" }, () => {});
  assert.ok(result.diagnostics.queryCount > 1);
  assert.equal(new Set(filters).size, 1);
  assert.equal(new Set(sqlScopes.map(s => JSON.stringify(s))).size, 1);
  assert.deepEqual(result.ids.sort(), ["battery", "windows"]);
  assert.ok(Object.isFrozen(result.policy));
  assert.ok(filters.every(f => !f.includes('"mac"') && !f.includes('"ubuntu"')));
});
test("zero scoped matches makes no provider call and never relaxes optional constraints", async () => {
  const before = filters.length;
  process.env.RAG_METADATA_FILTERS = '{"language":["fr"]}';
  const result = await retrieve(triage, { os: "Windows 11", model: "", application: "" }, () => {});
  assert.deepEqual(result.ids, []); assert.equal(result.diagnostics.generation, "scope_empty");
  assert.equal(filters.length, before);
  delete process.env.RAG_METADATA_FILTERS;
});
test("provider filter failure is reported, never retried unfiltered; SQL keeps confirmed scope", async () => {
  mode = "filter-fail"; const before = filters.length;
  const result = await retrieve(triage, { os: "Windows 11", model: "", application: "" }, () => {});
  assert.ok(result.ids.every(id => ["windows", "battery"].includes(id)));
  assert.equal(result.diagnostics.failedBranches, result.diagnostics.queryCount);
  assert.equal(filters.length - before, result.diagnostics.queryCount);
  mode = "all-fail";
  await assert.rejects(() => retrieve(triage, { os: "Windows 11", model: "", application: "" }, () => {}), error => error.status === 503);
  mode = "normal";
});
test("sanitized metadata diagnostics contain keys/counts/reasons, never actual employee values", () => {
  const allowed = ["event", "policyKeys", "catalogCount", "eligibleCount", "rejectionCounts", "compatibility", "providerClauseCount", "filterFingerprint", "scope", "requestId", "retrievalId"];
  for (const event of events.filter(e => e.event === "rag_metadata")) {
    assert.ok(Object.keys(event).every(k => allowed.includes(k)));
    assert.doesNotMatch(JSON.stringify(event), /Windows 11|Wi-Fi|fixture-doc|battery_safety|not_lab_tested/);
  }
  assert.ok(policyKeys(policy()).includes("embedding"));
});
after(async () => {
  globalThis.fetch = original.fetch; pool.connect = original.connect; logger.info = original.log;
  if (original.settings === undefined) delete process.env.RAG_METADATA_FILTERS; else process.env.RAG_METADATA_FILTERS = original.settings;
  await pool.end();
});
