// Read-only real-provider smoke checks with memory-only SYNTHETIC conversations.
// Not an authenticated HTTP/browser test. No identity, history or Pinecone writes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import { answer } from "./rag.ts";
import { correlation, linkTrace, requestContext } from "./observability.ts";

const events = [], originalLog = logger.info;
logger.info = e => events.push(e);
const newChat = os => ({ id: randomUUID(), title: "[SYNTHETIC TEST] Correlation", status: "open",
  context: { os, model: "", application: "" }, messages: [], attempts: [], updatedAt: new Date().toISOString() });
async function turn(chat, text, label) {
  return requestContext(async () => {
    const message = { id: randomUUID(), role: "user", text, citations: [], createdAt: new Date().toISOString() };
    chat.messages.push(message);
    // Explicit synthetic harness context, not a claim of employee authentication.
    linkTrace({ conversationId: chat.id, userMessageId: message.id });
    const reply = await answer(chat, text, () => {});
    chat.messages.push(reply);
    const trace = correlation(), logs = events.filter(e => e.requestId === trace.requestId);
    const metadata = logs.find(e => e.event === "rag_metadata");
    const fusion = logs.find(e => e.event === "rag_fusion");
    const terminal = logs.filter(e => e.event === "rag_retrieval_terminal");
    const branches = logs.filter(e => e.event === "rag_branch_terminal");
    if (metadata) {
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].assistantMessageId, reply.id);
      assert.ok(logs.every(e => e.conversationId === chat.id && e.userMessageId === message.id && e.retrievalId === trace.retrievalId));
      assert.ok(branches.every(e => e.status === "success" && e.filterFingerprint === metadata.filterFingerprint));
      assert.equal(branches.length, fusion.queryCount * 2);
    }
    return { reply, report: { label, syntheticMemoryOnly: true, ...trace, kind: reply.kind,
      citationIds: reply.citations.map(c => c.id), attemptedCount: chat.attempts.length,
      scope: metadata?.scope, filterFingerprint: metadata?.filterFingerprint,
      eligibleCount: metadata?.eligibleCount, rejectionCounts: metadata?.rejectionCounts,
      generation: fusion?.generation, generatedVariantCount: fusion?.generatedVariantCount, queryCount: fusion?.queryCount,
      successfulBranches: fusion?.successfulBranches, failedBranches: fusion?.failedBranches,
      branches: branches.map(e => ({ variantId: e.variantId, channel: e.channel, candidateCount: e.candidateCount,
        status: e.status, durationMs: e.durationMs, filterFingerprint: e.filterFingerprint })),
      selectedCount: terminal[0]?.selectedCount, terminalCount: terminal.length } };
  });
}
try {
  const wifi = newChat("");
  const os = await turn(wifi, "My laptop keeps dropping the office Wi-Fi", "wifi-missing-os");
  assert.equal(os.reply.kind, "clarification"); assert.match(os.reply.text, /operating system/i);
  const symptom = await turn(wifi, "Windows 11", "wifi-confirmed-os");
  assert.equal(symptom.reply.kind, "clarification");
  const first = await turn(wifi, "It stays connected to Wi-Fi but internet stops", "wifi-first-step");
  assert.equal(first.reply.kind, "guidance"); assert.ok(first.reply.citations.length);
  wifi.attempts.push({ messageId: first.reply.id, step: first.reply.step, outcome: "failed" });
  const next = await turn(wifi, "Still not working", "wifi-failed-step-followup");
  assert.equal(next.reply.kind, "guidance"); assert.notEqual(next.reply.step, first.reply.step);
  assert.equal(wifi.context.os, "Windows 11");
  assert.equal(next.reply.triage.originalIssue, wifi.messages[0].text);
  const camera = await turn(newChat("Windows 11"), "My Windows 11 camera works in the Camera app but the preview is black in Microsoft Teams", "camera");
  assert.equal(camera.reply.kind, "guidance"); assert.ok(camera.reply.citations.length);
  const unsupported = await turn(newChat("Windows 11"), "My laptop quantum stabilizer loses coherence", "unsupported");
  assert.equal(unsupported.reply.kind, "handoff"); assert.equal(unsupported.reply.citations.length, 0);
  console.log(JSON.stringify({ checksPassed: 6, authenticatedHttpVerified: false, persistedConversations: 0,
    reports: [os, symptom, first, next, camera, unsupported].map(t => t.report) }, null, 2));
} finally { logger.info = originalLog; await pool.end(); }
