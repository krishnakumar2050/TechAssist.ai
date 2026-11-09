import { test, after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import { readChat, sendChatTurn, recordChatOutcome } from "./conversation-flow.ts";
import { enhancedQuery, lexicalQuery, applicablePlatform, applicableTopic, applicableSymptom } from "./support-triage.ts";

const original = { query: pool.query, connect: pool.connect, fetch: globalThis.fetch, log: logger.info, keys: [process.env.PINECONE_API_KEY, process.env.NEBIUS_API_KEY] };
process.env.PINECONE_API_KEY = "synthetic-test";
process.env.NEBIUS_API_KEY = "synthetic-test";
const issue = "My laptop keeps dropping the office Wi-Fi.";
const owner = "synthetic-owner";
const rows = new Map();
const events = [];
const requests = [];
let lowScores = false;
let invalidAction = false;
const docs = [
  { id: "wifi-no-internet", title: "Windows shows Wi-Fi connected but no internet", text: "Windows 11. Connected wireless icon but internet unavailable.\nResolution:\n1. Check connection status\n2. Compare another device on the same network\n3. Run the network troubleshooter\nVerify: Internet access returns on affected laptop", metadata: { platform: "Windows 11", source_urls: ["https://support.example.test/wifi"] } },
  { id: "wifi-cannot-connect", title: "Windows cannot connect to Wi-Fi", text: "Windows 11. Wireless connection fails. Check Wi-Fi and airplane mode. Check selected network.", metadata: { platform: "Windows 11" } },
  { id: "bluetooth", title: "Bluetooth audio disconnects repeatedly", text: "Windows 11 Bluetooth audio disconnections.", metadata: { platform: "Windows 11" } },
  { id: "startup", title: "Windows repeatedly crashes during startup", text: "Windows 11 startup crash guidance.", metadata: { platform: "Windows 11" } },
  { id: "ubuntu", title: "Ubuntu Wi-Fi connected but no internet", text: "Ubuntu connected wireless icon but internet unavailable.", metadata: { platform: "Ubuntu" } },
].map(d => ({ ...d, source_url: "https://support.example.test/wifi",
  metadata: { ...d.metadata, document_id: d.id, embedding_model: "llama-text-embed-v2" } }));
logger.info = (data) => events.push(data);
pool.query = async (sql, args) => {
  if (sql.startsWith("SELECT * FROM support_conversations")) {
    const row = rows.get(args[0]); return { rows: row?.owner_id === args[1] ? [structuredClone(row)] : [] };
  }
  if (sql.startsWith("UPDATE support_conversations")) {
    const row = rows.get(args[0]); if (!row || row.owner_id !== args[1]) return { rows: [] };
    Object.assign(row, { status: args[2], context: JSON.parse(args[3]), messages: JSON.parse(args[4]), attempts: JSON.parse(args[5]), updated_at: new Date() });
    return { rows: [structuredClone(row)] };
  }
  if (sql.includes("SELECT c.id FROM")) {
    assert.match(sql, /to_tsquery/); assert.ok(args[0].includes(" | "));
    assert.equal(args[0].includes("unknown"), false);
    return { rows: docs.map(d => ({ id: d.id })) };
  }
  if (sql.includes("SELECT c.id,c.metadata")) return { rows: docs.map(({ id, metadata }) => ({ id, metadata })) };
  if (sql.includes("SELECT c.id,c.title")) return { rows: docs };
  throw new Error("Unexpected test SQL");
};
pool.connect = async () => ({
  query: async (sql, args) => /^(BEGIN|COMMIT|ROLLBACK|SELECT set_config)/.test(sql) ? { rows: [] } : pool.query(sql, args),
  release() {},
});
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname; const body = options.body ? JSON.parse(options.body) : undefined;
  requests.push({ path, body }); let result;
  if (path.startsWith("/indexes/")) result = { name: "techassist-laptops-hybrid", host: "techassist-laptops-hybrid-4rxtk29.svc.aped-4627-b74a.pinecone.io", dimension: 1024, metric: "cosine", status: { ready: true } };
  else if (path === "/embed") result = { data: [{ values: Array(1024).fill(0.01) }] };
  else if (path === "/query") result = { matches: docs.map(d => ({ id: d.id })) };
  else if (path === "/rerank") {
    assert.ok(body.top_n <= 5);
    result = { data: body.documents.slice(0, 5).map((d, index) => ({ index, score: lowScores ? 0.01 : 0.99 - index / 10 })) };
  } else if (path.endsWith("/chat/completions")) {
    const system = body.messages[0].content;
    if (system.includes("Generate complementary")) result = { choices: [{ message: { content: '{"queries":[]}' } }] };
    else if (system.includes("Compare the proposed")) result = { choices: [{ message: { content: '{"repeats":false}' } }] };
    else if (system.includes("Select exactly one next action")) {
      const input = JSON.parse(body.messages[1].content);
      assert.ok(input.approvedActions.every(a => !/reset|Settings|Bluetooth|startup/i.test(a.step)));
      result = { choices: [{ message: { content: JSON.stringify({ actionId: invalidAction ? "invented-action" : input.approvedActions[0].actionId }) } }] };
    }
    else {
      const input = JSON.parse(body.messages[1].content);
      assert.ok(input.evidence.every(e => e.id === "wifi-no-internet"));
      assert.equal(input.originalIssue, issue);
      const step = input.attempts.length ? "Compare another device on the same network" : "Check connection status";
      result = { choices: [{ message: { content: JSON.stringify({ step, explanation: "The approved Wi-Fi guidance supports this check.", navigation: "", expectedResult: "Determine whether internet access is available.", citationIds: ["wifi-no-internet"] }) } }] };
    }
  } else throw new Error("Unexpected provider path");
  return new Response(JSON.stringify(result), { status: 200 });
};
function create(id, os = "") {
  rows.set(id, { id, owner_id: owner, title: "[SYNTHETIC TEST] Wi-Fi triage", status: "open", updated_at: new Date(), context: { os, model: "", application: "" }, messages: [], attempts: [] });
}
async function turn(id, text) { return sendChatTurn(owner, await readChat(owner, id), text, () => {}); }

test("missing OS then symptom are separate questions, persisted across reloads before any retrieval", async () => {
  create("clarify"); const before = requests.length;
  const first = await turn("clarify", issue);
  assert.equal(first.messages.at(-1).kind, "clarification");
  assert.match(first.messages.at(-1).text, /operating system/);
  assert.equal(first.messages.at(-1).step, undefined);
  assert.equal(first.messages.at(-1).triage.originalIssue, issue);
  const second = await turn("clarify", "Windows 11");
  assert.equal(second.context.os, "Windows 11");
  assert.match(second.messages.at(-1).text, /disconnect completely.*stay connected/);
  assert.equal(second.messages.at(-1).triage.originalIssue, issue);
  assert.equal(requests.length, before);
});
test("connected-without-internet uses only applicable Wi-Fi evidence and failed follow-up preserves issue/context/attempt", async () => {
  const third = await turn("clarify", "It stays connected while internet stops.");
  const first = third.messages.at(-1);
  assert.equal(first.kind, "guidance");
  assert.equal(first.navigation, "");
  assert.equal(first.step, "Check connection status");
  assert.deepEqual(first.citations.map(c => c.id), ["wifi-no-internet"]);
  await recordChatOutcome(owner, third, first.id, "failed");
  const next = await turn("clarify", "That step did not fix it. What should I try next?");
  assert.notEqual(next.messages.at(-1).step, first.step);
  assert.equal(next.messages.at(-1).triage.originalIssue, issue);
  assert.equal(next.messages.at(-1).triage.symptom, "connectedNoInternet");
  assert.equal(next.context.os, "Windows 11");
  assert.equal(next.attempts[0].step, first.step);
  assert.equal(next.attempts[0].outcome, "failed");
  assert.equal(next.messages.at(-1).citations[0].id, "wifi-no-internet");
  const rankCalls = requests.filter(r => r.path === "/rerank");
  assert.ok(rankCalls.every(r => r.body.documents.every(d => d.id === "wifi-no-internet")));
});
test("confirmed complete disconnections explain coverage gap, not cannot-connect or unrelated advice", async () => {
  create("disconnect", "Windows 11");
  await turn("disconnect", issue);
  const result = await turn("disconnect", "Wi-Fi disconnects completely.");
  assert.equal(result.status, "handoff");
  assert.equal(result.messages.at(-1).kind, "handoff");
  assert.match(result.messages.at(-1).text, /intermittent Wi-Fi disconnections/);
  assert.match(result.messages.at(-1).text, /not the symptom you confirmed/);
  assert.equal(result.messages.at(-1).citations.length, 0);
});
test("uncovered issue with confirmed OS and subthreshold scores safely hands off", async () => {
  create("unsupported", "Windows 11"); lowScores = true;
  const result = await turn("unsupported", "My laptop has an unsupported quantum flux buffer issue.");
  assert.equal(result.status, "handoff");
  assert.equal(result.messages.at(-1).kind, "handoff");
  assert.match(result.messages.at(-1).text, /won't substitute unrelated instructions/);
  lowScores = false;
});
test("exhausted approved actions hand off without repeating an attempted action", async () => {
  const chat = await readChat(owner, "clarify");
  for (const step of ["Check connection status", "Compare another device on the same network", "Run the network troubleshooter"]) {
    chat.attempts.push({ messageId: `synthetic-${step}`, step, outcome: "failed" });
  }
  const result = await sendChatTurn(owner, chat, "What should I try next?", () => {});
  assert.equal(result.messages.at(-1).kind, "handoff");
  assert.match(result.messages.at(-1).text, /no different supported action/);
  assert.equal(result.messages.at(-1).step, undefined);
});
test("invented model action IDs cannot become technical guidance", async () => {
  create("invalid-action", "Windows 11");
  await turn("invalid-action", issue);
  invalidAction = true;
  await assert.rejects(() => turn("invalid-action", "It stays connected but no internet"), /did not choose a supplied source action/);
  invalidAction = false;
});
test("controlled enhancement preserves issue and OR keywords without unknowns or invented office details", () => {
  const state = { originalIssue: issue, topic: "wifi", symptom: "connectedNoInternet" };
  const query = enhancedQuery(state, { os: "Windows 11", model: "[unknown]", application: "unspecified" });
  assert.ok(query.startsWith(issue));
  assert.doesNotMatch(query, /unknown|unspecified|enterprise|802\.1|certificate|SSID/i);
  const keywords = lexicalQuery(query);
  assert.match(keywords, /wifi/); assert.match(keywords, /wireless/); assert.match(keywords, /internet/);
  assert.ok(keywords.includes(" | "));
  assert.equal(applicablePlatform(docs[4], "Windows 11"), false);
  assert.equal(applicableTopic(docs[2], state), false);
  assert.equal(applicableSymptom(docs[1], state), false);
});
test("retrieval diagnostics contain counts/filtering/rejection but no query text, IDs, source text or credentials", () => {
  const retrieval = events.filter(e => e.event === "rag_retrieval");
  assert.ok(events.some(e => e.event === "rag_metadata" && e.rejectionCounts.os_mismatch > 0));
  assert.ok(retrieval.some(e => e.topicExcluded > 0 && e.symptomExcluded > 0));
  assert.ok(retrieval.some(e => e.belowThreshold > 0 && e.selectedCount === 0));
  for (const e of events) {
    const output = JSON.stringify(e);
    assert.doesNotMatch(output, /office|synthetic|support\.example|wifi-no-internet|quantum|connected wireless icon/i);
    if (e.event === "rag_metadata") {
      assert.ok(Object.keys(e).every(k => ["event", "policyKeys", "catalogCount", "eligibleCount", "rejectionCounts", "compatibility", "providerClauseCount", "filterFingerprint", "scope", "requestId", "retrievalId"].includes(k)));
      continue;
    }
    if (e.event === "rag_fusion") {
      assert.ok(Object.keys(e).every(k => ["event", "enabled", "generation", "queryCount", "successfulBranches", "failedBranches", "originalSuccessfulBranches", "denseCount", "lexicalCount", "fusedCount", "shortlistCount", "generationMs", "retrievalMs", "elapsedMs", "denseProviderCount", "denseScopeRejected", "policyKeys", "filterFingerprint", "scope", "requestId", "retrievalId", "generatedVariantCount"].includes(k)));
      continue;
    }
    if (e.event !== "rag_retrieval") continue; // New lifecycle/branch events have their own dedicated tests.
    assert.equal(e.threshold, 0.1);
    assert.ok(Object.keys(e).every(k => ["event", "topic", "platform", "denseCount", "lexicalCount", "fusedCount", "mappedCount", "metadataExcluded", "topicExcluded", "platformExcluded", "symptomExcluded", "rerankCount", "belowThreshold", "invalidIndexes", "scores", "threshold", "selectedCount", "rerankMs", "totalRetrievalMs", "requestId", "retrievalId", "filterFingerprint", "scope"].includes(k)));
  }
});
test("owner-scoped persistence cannot be read or mutated by another owner", async () => {
  await assert.rejects(() => readChat("another-synthetic-owner", "clarify"), /Conversation not found/);
});
after(async () => {
  pool.query = original.query; pool.connect = original.connect; globalThis.fetch = original.fetch; logger.info = original.log;
  for (const [index, key] of ["PINECONE_API_KEY", "NEBIUS_API_KEY"].entries()) {
    if (original.keys[index] === undefined) delete process.env[key]; else process.env[key] = original.keys[index];
  }
  await pool.end();
});
