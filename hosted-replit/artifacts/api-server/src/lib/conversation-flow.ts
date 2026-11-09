import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { GetConversationResponse } from "@workspace/api-zod";
import { answer, type ConversationDetail } from "./rag";
import { SupportError } from "./support-config";
import { correlation, diagnostic, errorCode, linkTrace } from "./observability";

export function parseConversation(row: Record<string, unknown>): ConversationDetail {
  return GetConversationResponse.parse({
    id: row.id, title: row.title, status: row.status, context: row.context,
    messages: row.messages, attempts: row.attempts, updatedAt: new Date(row.updated_at as string).toISOString(),
  });
}
export async function readChat(ownerId: string, id: string) {
  const { rows } = await pool.query("SELECT * FROM support_conversations WHERE id=$1 AND owner_id=$2", [id, ownerId]);
  if (!rows[0]) throw new SupportError(404, "Conversation not found.");
  return parseConversation(rows[0]);
}
export async function persistChat(ownerId: string, chat: ConversationDetail) {
  const { rows } = await pool.query(`UPDATE support_conversations SET status=$3,context=$4,messages=$5,attempts=$6,updated_at=now()
    WHERE id=$1 AND owner_id=$2 RETURNING *`,
    [chat.id, ownerId, chat.status, JSON.stringify(chat.context), JSON.stringify(chat.messages), JSON.stringify(chat.attempts)]);
  if (!rows[0]) throw new SupportError(404, "Conversation not found.");
  return parseConversation(rows[0]);
}
// Callers must authenticate and serialize mutations before invoking this shared flow.
export async function sendChatTurn(ownerId: string, chat: ConversationDetail, text: string, progress: (stage: string) => void) {
  const start = performance.now();
  let status = "success", code: string | undefined;
  diagnostic({ event: "chat_turn_start" });
  try {
  if (chat.messages.length >= 200) throw new SupportError(400, "Please start a new chat; this conversation has reached its limit.");
  if (chat.messages.at(-1)?.role !== "user" || chat.messages.at(-1)?.text !== text) {
    chat.messages.push({ id: randomUUID(), role: "user", text, citations: [], createdAt: new Date().toISOString() });
    linkTrace({ userMessageId: chat.messages.at(-1)!.id });
    chat.status = "open";
    await persistChat(ownerId, chat);
  }
  linkTrace({ userMessageId: chat.messages.at(-1)!.id });
  const reply = await answer(chat, text, progress);
  linkTrace({ assistantMessageId: reply.id });
  chat.messages.push(reply);
  if (reply.kind === "handoff") chat.status = "handoff";
  return await persistChat(ownerId, chat);
  } catch (error) {
    code = errorCode(error); status = code === "timeout" || code === "cancelled" ? code : "failure";
    throw error;
  } finally {
    diagnostic({ event: "chat_turn_terminal", ...correlation(), status, errorCode: code, totalMs: Math.round(performance.now() - start) });
  }
}
export async function recordChatOutcome(ownerId: string, chat: ConversationDetail, messageId: string, outcome: "solved" | "failed" | "blocked") {
  const message = chat.messages.find(m => m.id === messageId && m.role === "assistant" && m.step && m.kind !== "handoff");
  if (!message) throw new SupportError(400, "Select an assistant troubleshooting step.");
  if ([...chat.messages].reverse().find(m => m.role === "assistant" && m.step)?.id !== messageId) {
    throw new SupportError(409, "Please record the outcome of the latest step.");
  }
  chat.attempts = chat.attempts.filter(a => a.messageId !== message.id);
  chat.attempts.push({ messageId, step: message.step!, outcome });
  chat.status = outcome === "solved" ? "resolved" : outcome === "blocked" ? "handoff" : "open";
  return persistChat(ownerId, chat);
}
