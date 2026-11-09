import type { ConversationDetail } from "@workspace/api-client-react";

export type StreamHandlers = {
  onProgress: (stage: string) => void;
  onToken: (text: string) => void;
};
export class StreamServiceError extends Error {
  constructor(message: string, public readonly requestId?: string) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function streamMessage(
  conversationId: string,
  text: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<ConversationDetail> {
  let requestId: string | undefined;
  try {
  const res = await fetch(`/api/support/conversations/${conversationId}/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({ text }),
    signal,
  });
  const header = res.headers.get("X-Request-ID");
  requestId = header && uuid.test(header) ? header : undefined;
  if (!res.ok) {
    let msg = "The assistant could not respond right now.";
    try {
      const j = await res.json();
      if (j?.error && typeof j.error === "string") msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("text/event-stream") || !res.body) {
    return (await res.json()) as ConversationDetail;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ConversationDetail | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (!dataLines.length) continue;
      let data: any;
      try {
        data = JSON.parse(dataLines.join("\n"));
      } catch {
        continue;
      }
      if (event === "progress") handlers.onProgress(String(data.stage ?? ""));
      else if (event === "token") handlers.onToken(String(data.text ?? ""));
      else if (event === "done") result = data as ConversationDetail;
      else if (event === "error") throw new Error(String(data.error ?? "Something went wrong."));
    }
  }
  if (!result) throw new Error("The response ended early. Please try again.");
  return result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new StreamServiceError(error instanceof Error ? error.message : "The support service is unavailable.", requestId);
  }
}

const STAGE_LABELS: Record<string, string> = {
  retrieving: "Searching your IT knowledge base",
  retrieval: "Searching your IT knowledge base",
  searching: "Searching your IT knowledge base",
  embedding: "Understanding your question",
  generating: "Choosing one next step",
  generation: "Choosing one next step",
  thinking: "Choosing one next step",
};

export function stageLabel(stage: string) {
  const key = stage.toLowerCase();
  if (STAGE_LABELS[key]) return STAGE_LABELS[key];
  const s = stage.replace(/[_-]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
