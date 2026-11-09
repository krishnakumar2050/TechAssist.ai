import test, { after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import pino from "pino";
import pinoHttp from "pino-http";
import { pool } from "@workspace/db";
import { logger } from "./logger.ts";
import { correlation, correlatedPayload, diagnostic, errorCode, filterIdentity, linkTrace, requestContext,
  requestTracing, retrievalMetrics, serverRequestId, withRetrieval } from "./observability.ts";
import { buildFilterPolicy } from "./metadata-policy.ts";
import { bounded, fusionConfig, retrieveBranches } from "./rag-fusion.ts";
import { sendChatTurn } from "./conversation-flow.ts";
import { streamMessage, StreamServiceError } from "../../../techassist/src/lib/stream.ts";

const events = [], original = { log: logger.info, query: pool.query, fetch: globalThis.fetch };
logger.info = e => events.push(e);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const delay = ms => new Promise(r => setTimeout(r, ms));
const cfg = { ...fusionConfig(), branchMs: 100, concurrency: 2 };
const signal = () => AbortSignal.timeout(2000);
const policy = os => filterIdentity(buildFilterPolicy({ os }), "fixture-namespace", "llama-text-embed-v2");

test("parallel request contexts isolate conversation, retrieval, variant and channel correlation", async () => {
  const from = events.length;
  const run = (conversationId, os, wait) => requestContext(async () => {
    linkTrace({ conversationId, userMessageId: `${conversationId}-message` });
    return withRetrieval(async () => {
      diagnostic({ event: "rag_metadata", ...policy(os) });
      const branch = async () => { await delay(wait); return [{ id: "fixture-chunk" }]; };
      await retrieveBranches(["PRIVATE QUERY ONE", "PRIVATE QUERY TWO"], cfg, signal(), branch, branch, policy(os));
      retrievalMetrics({ eligibleCount: 22, selectedCount: 1 });
      return correlation();
    });
  });
  const [a, b] = await Promise.all([run("fixture-a", "Windows 11", 5), run("fixture-b", "macOS", 2)]);
  assert.notEqual(a.requestId, b.requestId); assert.notEqual(a.retrievalId, b.retrievalId);
  for (const item of [a, b]) {
    const logs = events.slice(from).filter(e => e.requestId === item.requestId);
    assert.ok(logs.every(e => e.conversationId === item.conversationId && e.retrievalId === item.retrievalId));
    const metadata = logs.find(e => e.event === "rag_metadata");
    const starts = logs.filter(e => e.event === "rag_branch_start");
    const finishes = logs.filter(e => e.event === "rag_branch_terminal");
    assert.equal(starts.length, 4); assert.equal(finishes.length, 4);
    assert.deepEqual(new Set(finishes.map(e => `${e.variantId}/${e.channel}`)), new Set(["v0/dense", "v0/lexical", "v1/dense", "v1/lexical"]));
    assert.ok([...starts, ...finishes].every(e => e.filterFingerprint === metadata.filterFingerprint));
    assert.ok(finishes.every(e => e.candidateCount === 1 && e.durationMs >= 0 && e.status === "success"));
    const terminal = logs.filter(e => e.event === "rag_retrieval_terminal");
    assert.equal(terminal.length, 1); assert.equal(terminal[0].selectedCount, 1);
  }
  assert.doesNotMatch(JSON.stringify(events.slice(from)), /PRIVATE QUERY|fixture-chunk/);
  assert.deepEqual(correlation(), {});
});

test("canonical policy fingerprint is order independent, constraint sensitive, and contains no query hash", () => {
  const a = buildFilterPolicy({ os: "Windows 11" }, { language: ["fr", "en"], category: ["software", "hardware"] });
  const b = buildFilterPolicy({ os: "Windows 11" }, { category: ["hardware", "software"], language: ["en", "fr"] });
  assert.equal(filterIdentity(a, "n", "m").filterFingerprint, filterIdentity(b, "n", "m").filterFingerprint);
  assert.notEqual(policy("Windows 11").filterFingerprint, policy("Windows 10").filterFingerprint);
  assert.notEqual(filterIdentity(a, "n", "m").filterFingerprint, filterIdentity(a, "different", "m").filterFingerprint);
  assert.equal(policy("Windows 11").scope.version, "11");
});

test("nested retrieval wrappers share one invocation and emit one terminal with message linkage", async () => {
  const from = events.length;
  await requestContext(() => withRetrieval(() => withRetrieval(async () => {
    retrievalMetrics({ event: "rag_fusion", queryCount: 1 });
    return { id: "fixture-assistant", role: "assistant", kind: "guidance" };
  })));
  const logs = events.slice(from);
  assert.equal(logs.filter(e => e.event === "rag_retrieval_start").length, 1);
  const terminal = logs.filter(e => e.event === "rag_retrieval_terminal");
  assert.equal(terminal.length, 1); assert.equal(terminal[0].assistantMessageId, "fixture-assistant");
});

test("provider failure logs bounded codes, never exception payloads or employee text", async () => {
  const from = events.length;
  const leak = new Error("SECRET_TOKEN email@example.test PRIVATE QUERY provider body");
  await requestContext(() => assert.rejects(() => withRetrieval(async () => {
    await retrieveBranches(["PRIVATE QUERY"], cfg, signal(), async () => { throw leak; }, async () => { throw leak; }, policy("Windows 11"));
    throw leak;
  })));
  const logs = events.slice(from);
  assert.equal(logs.filter(e => e.event === "rag_branch_terminal" && e.errorCode === "service_error").length, 2);
  assert.equal(logs.filter(e => e.event === "rag_retrieval_terminal" && e.status === "failure").length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /SECRET_TOKEN|email@|PRIVATE QUERY|provider body/);
});

test("branch timeout and retrieval timeout each emit exactly one terminal", async () => {
  const from = events.length;
  await requestContext(() => assert.rejects(() => withRetrieval(async () => {
    await retrieveBranches(["secret"], { ...cfg, branchMs: 5 }, signal(), () => new Promise(() => {}), () => new Promise(() => {}), policy("Windows 11"));
    await bounded(() => new Promise(() => {}), AbortSignal.timeout(5));
  })));
  const logs = events.slice(from);
  assert.equal(logs.filter(e => e.event === "rag_branch_terminal" && e.status === "timeout").length, 2);
  assert.equal(logs.filter(e => e.event === "rag_retrieval_terminal" && e.status === "timeout").length, 1);
});

test("cancellation emits one retrieval terminal and a bounded cancellation code", async () => {
  const from = events.length;
  await requestContext(() => assert.rejects(() => withRetrieval(async () => {
    const ac = new AbortController();
    const pending = bounded(() => new Promise(() => {}), ac.signal);
    ac.abort();
    await pending;
  })));
  assert.equal(events.slice(from).filter(e => e.event === "rag_retrieval_terminal" && e.status === "cancelled").length, 1);
  assert.equal(errorCode({ code: "arbitrary secret", message: "secret" }), "service_error");
});

const chat = () => ({ id: "fixture-conversation", title: "Fixture", status: "open", context: { os: "", model: "", application: "" },
  messages: [], attempts: [], updatedAt: new Date().toISOString() });
function persistFixture(_sql, values) {
  return Promise.resolve({ rows: [{ id: values[0], status: values[2], context: JSON.parse(values[3]),
    messages: JSON.parse(values[4]), attempts: JSON.parse(values[5]), title: "Fixture", updated_at: new Date() }] });
}
test("turn links persisted message IDs and retries get fresh request IDs without exactly-once claims", async () => {
  pool.query = persistFixture;
  const c = chat(), from = events.length;
  const run = () => requestContext(async () => {
    linkTrace({ conversationId: c.id });
    const saved = await sendChatTurn("fixture-owner", c, "My laptop keeps dropping the office Wi-Fi", () => {});
    return { ...correlation(), saved };
  });
  const a = await run(), b = await run();
  assert.match(a.requestId, uuid); assert.notEqual(a.requestId, b.requestId);
  assert.notEqual(a.userMessageId, b.userMessageId);
  const terminals = events.slice(from).filter(e => e.event === "chat_turn_terminal");
  assert.equal(terminals.length, 2);
  for (const end of terminals) {
    assert.ok(c.messages.some(m => m.id === end.userMessageId && m.role === "user"));
    assert.ok(c.messages.some(m => m.id === end.assistantMessageId && m.role === "assistant"));
  }
  assert.equal(c.messages.length, 4); // Existing completed-turn retries are NOT deduplicated.
});

test("failed persistence keeps available message linkage and emits one failure terminal", async () => {
  const from = events.length;
  pool.query = async () => { throw new Error("DATABASE CONNECTION SECRET"); };
  await requestContext(() => assert.rejects(async () => {
    linkTrace({ conversationId: "fixture-conversation" });
    await sendChatTurn("fixture-owner", chat(), "My laptop keeps dropping the office Wi-Fi", () => {});
  }));
  const ends = events.slice(from).filter(e => e.event === "chat_turn_terminal");
  assert.equal(ends.length, 1); assert.match(ends[0].userMessageId, uuid);
  assert.doesNotMatch(JSON.stringify(ends), /CONNECTION SECRET|fixture-owner|office/);
  pool.query = original.query;
});

test("HTTP generates fresh UUID headers ignoring caller IDs, preserves async context, and terminates once", async () => {
  const from = events.length, app = express();
  app.use(pinoHttp({ logger: pino({ enabled: false }), genReqId: serverRequestId }));
  app.use(requestTracing);
  app.get("/fixture", async (_req, res) => { await delay(2); res.json(correlatedPayload({ ok: true })); });
  app.get("/disconnect", (_req, res) => { res.write("partial"); setTimeout(() => res.destroy(), 5); });
  const server = app.listen(0); await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    const a = await original.fetch(url, { headers: { "X-Request-ID": "caller-secret" } });
    const b = await original.fetch(url, { headers: { "X-Request-ID": a.headers.get("X-Request-ID") } });
    const aid = a.headers.get("X-Request-ID"), bid = b.headers.get("X-Request-ID");
    assert.match(aid, uuid); assert.match(bid, uuid); assert.notEqual(aid, bid);
    assert.equal((await a.json()).correlation.requestId, aid);
    assert.equal((await b.json()).correlation.requestId, bid);
    await delay(5);
    for (const id of [aid, bid]) assert.equal(events.slice(from).filter(e => e.event === "http_request_terminal" && e.requestId === id).length, 1);
    const interrupted = await original.fetch(url.replace("/fixture", "/disconnect"));
    const disconnectedId = interrupted.headers.get("X-Request-ID");
    await assert.rejects(() => interrupted.text());
    await delay(5);
    const disconnected = events.slice(from).filter(e => e.event === "http_request_terminal" && e.requestId === disconnectedId);
    assert.equal(disconnected.length, 1); assert.equal(disconnected[0].status, "client_disconnected");
    assert.doesNotMatch(JSON.stringify(events.slice(from)), /caller-secret/);
  } finally { await new Promise(r => server.close(r)); }
});

test("SSE additive correlation retains existing progress/token/done consumer contract", async () => {
  const id = "11111111-1111-4111-8111-111111111111", stages = [], tokens = [];
  const payload = { ...chat(), correlation: { requestId: id, retrievalId: "fixture-retrieval" } };
  globalThis.fetch = async () => new Response(
    `event: progress\ndata: ${JSON.stringify({ stage: "searching", correlation: { requestId: id } })}\n\n`
    + 'event: token\ndata: {"text":"Hello"}\n\n'
    + `event: done\ndata: ${JSON.stringify(payload)}\n\n`,
    { headers: { "Content-Type": "text/event-stream", "X-Request-ID": id } });
  const result = await streamMessage("fixture", "private", { onProgress: s => stages.push(s), onToken: t => tokens.push(t) });
  assert.equal(result.id, payload.id); assert.deepEqual(stages, ["searching"]); assert.deepEqual(tokens, ["Hello"]);
});

test("SSE/JSON/early-close service errors expose only validated support references", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const response of [
    () => new Response('event: error\ndata: {"error":"Please retry","correlation":{"requestId":"ignored"}}\n\n', { headers: { "Content-Type": "text/event-stream", "X-Request-ID": id } }),
    () => new Response('{"error":"Please retry"}', { status: 503, headers: { "X-Request-ID": id } }),
    () => new Response(": heartbeat\n\n", { headers: { "Content-Type": "text/event-stream", "X-Request-ID": id } }),
  ]) {
    globalThis.fetch = async () => response();
    await assert.rejects(() => streamMessage("fixture", "private", { onProgress() {}, onToken() {} }),
      error => error instanceof StreamServiceError && error.requestId === id);
  }
  globalThis.fetch = async () => new Response('{"error":"Please retry"}', { status: 503, headers: { "X-Request-ID": "unsafe-not-a-uuid" } });
  await assert.rejects(() => streamMessage("fixture", "private", { onProgress() {}, onToken() {} }),
    error => error.requestId === undefined);
});
after(async () => { logger.info = original.log; pool.query = original.query; globalThis.fetch = original.fetch; await pool.end(); });
