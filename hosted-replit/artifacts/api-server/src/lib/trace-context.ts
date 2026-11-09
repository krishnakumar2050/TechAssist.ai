import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TraceState = {
  requestId: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  retrievalId?: string;
  lastRetrievalId?: string;
  metrics?: Record<string, unknown>;
};
export const traceStorage = new AsyncLocalStorage<TraceState>();
export function requestContext<T>(work: () => T, requestId: string = randomUUID()): T {
  return traceStorage.run({ requestId }, work);
}
export function linkTrace(fields: Partial<Pick<TraceState, "conversationId" | "userMessageId" | "assistantMessageId">>) {
  const state = traceStorage.getStore();
  if (state) Object.assign(state, fields);
}
export function correlation() {
  const state = traceStorage.getStore();
  if (!state) return {};
  return {
    requestId: state.requestId,
    ...(state.conversationId ? { conversationId: state.conversationId } : {}),
    ...(state.userMessageId ? { userMessageId: state.userMessageId } : {}),
    ...(state.assistantMessageId ? { assistantMessageId: state.assistantMessageId } : {}),
    ...(state.retrievalId || state.lastRetrievalId ? { retrievalId: state.retrievalId || state.lastRetrievalId } : {}),
  };
}
