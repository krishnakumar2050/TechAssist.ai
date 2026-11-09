// Synthetic-only, read-only corpus evaluation. Never creates identities, changes
// roles, reads employee histories, writes Pinecone or persists synthetic chats.
// Run via esbuild like the .test.mjs files; this is NOT an authenticated E2E test.
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import { answer } from "./rag.ts";

const events = [];
const originalLog = logger.info;
const originalFetch = globalThis.fetch;
const counts = {};
let currentCalls;
logger.info = event => events.push(event);
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  const name = path.endsWith("/chat/completions") ? "nebius"
    : path === "/embed" ? "embed" : path === "/rerank" ? "rerank"
    : path.endsWith("/documents/search") || path === "/query" ? "dense" : "other";
  if (currentCalls) currentCalls[name] = (currentCalls[name] || 0) + 1;
  return originalFetch(url, options);
};
function chat(os = "") {
  return { id: "memory-only-synthetic-evaluation", title: "[SYNTHETIC TEST] RAG-Fusion", status: "open",
    updatedAt: new Date().toISOString(), context: { os, model: "", application: "" }, messages: [], attempts: [] };
}
async function turn(chat, question, label) {
  const from = events.length, start = performance.now();
  currentCalls = {};
  chat.messages.push({ id: `synthetic-question-${chat.messages.length}`, role: "user", text: question, citations: [], createdAt: new Date().toISOString() });
  const reply = await answer(chat, question, () => {});
  chat.messages.push(reply);
  const diagnostic = events.slice(from);
  const fusion = diagnostic.find(e => e.event === "rag_fusion");
  const ranking = diagnostic.find(e => e.event === "rag_retrieval");
  const report = { label, kind: reply.kind, text: reply.text, citations: reply.citations.map(c => ({ id: c.id, url: c.url })),
    osRetained: chat.context.os === "Windows 11",
    originalIssueRetained: reply.triage?.originalIssue === chat.messages[0].text,
    attemptedCount: chat.attempts.length,
    fusion, ranking, elapsedMs: Math.round(performance.now() - start), providerCalls: { ...currentCalls } };
  currentCalls = undefined;
  return { reply, report };
}
try {
  const corpus = await pool.query("SELECT count(DISTINCT d.id)::int documents,count(c.id)::int chunks FROM support_documents d JOIN support_chunks c ON c.document_id=d.id WHERE d.status='ready'");
  const reports = [];
  for (const enabled of [false, true]) {
    process.env.RAG_FUSION_ENABLED = String(enabled);
    const mode = enabled ? "multi" : "single", results = [];
    const wifi = chat();
    const first = await turn(wifi, "My laptop keeps dropping the office Wi-Fi", `${mode}:wifi-missing-os`);
    assert.equal(first.reply.kind, "clarification"); assert.match(first.reply.text, /operating system/);
    assert.equal(first.report.fusion, undefined); results.push(first.report);
    const os = await turn(wifi, "Windows 11", `${mode}:wifi-os-answer`);
    assert.equal(os.reply.kind, "clarification"); assert.match(os.reply.text, /disconnect completely/);
    assert.equal(os.report.fusion, undefined); results.push(os.report);
    const step = await turn(wifi, "It stays connected to Wi-Fi but internet stops", `${mode}:wifi-connected-no-internet`);
    assert.equal(step.reply.kind, "guidance"); assert.ok(step.reply.citations.some(c => c.id === "TA-LAP-007-01"));
    results.push(step.report);
    // Mirrors the persisted outcome shape; actual owner-scoped DB roundtrip is
    // tested with fixtures, not an invented employee identity.
    wifi.attempts.push({ messageId: step.reply.id, step: step.reply.step, outcome: "failed" });
    const next = await turn(wifi, "Still not working", `${mode}:wifi-failed-follow-up`);
    assert.equal(next.reply.kind, "guidance"); assert.notEqual(next.reply.step, step.reply.step);
    assert.equal(next.reply.triage.originalIssue, "My laptop keeps dropping the office Wi-Fi");
    assert.equal(next.reply.triage.symptom, "connectedNoInternet"); assert.equal(wifi.context.os, "Windows 11");
    assert.equal(wifi.attempts[0].step, step.reply.step); results.push(next.report);
    const camera = await turn(chat("Windows 11"), "My Windows 11 camera works in the Camera app but the preview is black in Microsoft Teams", `${mode}:camera`);
    assert.equal(camera.reply.kind, "guidance"); assert.ok(camera.reply.citations.length > 0); results.push(camera.report);
    const unsupported = await turn(chat("Windows 11"), "My laptop has a failing quantum entanglement stabilizer", `${mode}:unsupported`);
    assert.equal(unsupported.reply.kind, "handoff"); assert.equal(unsupported.reply.citations.length, 0); results.push(unsupported.report);
    counts[mode] = results.length;
    reports.push({ mode, results });
  }
  // Only synthetic content and aggregate retrieval diagnostics are output.
  process.stdout.write(JSON.stringify({ syntheticOnly: true, authenticatedE2E: false, corpus: corpus.rows[0], checks: counts, reports }, null, 2) + "\n");
} catch (error) {
  // Never print provider response bodies, credentials or database connection data.
  process.stdout.write(JSON.stringify({ syntheticOnly: true, checksCompleted: counts, error: { name: error.name, status: error.status, message: error.name === "AssertionError" ? error.message : "Live provider or corpus check failed; inspect sanitized service diagnostics." }, diagnostics: events }, null, 2) + "\n");
  process.exitCode = 1;
} finally {
  globalThis.fetch = originalFetch; logger.info = originalLog;
  await pool.end();
}
