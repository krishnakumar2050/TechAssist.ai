import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  Plus, Search, Trash2, Send, Laptop, Monitor, AppWindow, Check, LifeBuoy, Copy, AlertTriangle, RefreshCw, Wifi, Video, Headphones, BatteryCharging, ChevronDown,
} from "lucide-react";
import {
  useGetSupportStatus, getGetSupportStatusQueryKey,
  useListConversations, getListConversationsQueryKey,
  useGetConversation, getGetConversationQueryKey,
  useGetHandoff, getGetHandoffQueryKey,
  useCreateConversation, useUpdateConversation, useDeleteConversation, useRecordOutcome,
  type ConversationDetail, type DeviceContext, type Conversation,
} from "@workspace/api-client-react";
import { Shell } from "@/components/shell";
import { PROMPTS } from "@/components/brand";
import { AssistantBody, OutcomeBar, type Outcome } from "@/components/step-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { streamMessage, stageLabel, StreamServiceError } from "@/lib/stream";
import { cn } from "@/lib/utils";

export const PROMPT_ICONS = { connectivity: Wifi, camera: Video, audio: Headphones, power: BatteryCharging } as const;
export const EMPTY_CTX: DeviceContext = { os: "", model: "", application: "" };

export default function ChatPage() {
  const status = useGetSupportStatus({ query: { queryKey: getGetSupportStatusQueryKey() } });
  const search = useSearch();
  const [, setLocation] = useLocation();
  const selectedId = new URLSearchParams(search).get("c");
  const select = (id: string | null) => setLocation(id ? `/chat?c=${id}` : "/chat");

  return (
    <Shell active="chat" admin={status.data?.admin} sidebar={(close) => <History selectedId={selectedId} onSelect={(id) => { select(id); close(); }} />}>
      {status.isLoading ? (
        <div className="mx-auto w-full max-w-3xl space-y-4 p-8"><Skeleton className="h-10 w-2/3" /><Skeleton className="h-40 w-full" /></div>
      ) : status.isError ? (
        <Notice title="We could not reach TechAssist" body="Check your connection and try again." onRetry={() => status.refetch()} />
      ) : (
        <>
          {!status.data?.ready && <SetupNotice onRetry={() => status.refetch()} />}
          {selectedId ? (
            <ConversationView key={selectedId} id={selectedId} onGone={() => select(null)} paused={!status.data?.ready} />
          ) : (
            <NewChat onCreated={(id) => select(id)} paused={!status.data?.ready} />
          )}
        </>
      )}
    </Shell>
  );
}

export function SetupNotice({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/70 px-5 py-2 text-xs text-muted-foreground md:px-10" role="status" data-testid="notice-setup">
      <AlertTriangle className="h-3.5 w-3.5 text-[hsl(32_70%_40%)]" />
      <span className="flex-1">New answers are paused while your IT team finishes setup. Your history and handoff summaries are still available.</span>
      {onRetry && <button type="button" onClick={onRetry} className="underline" data-testid="button-recheck">Check again</button>}
    </div>
  );
}

function Notice({ title, body, onRetry }: { title: string; body: string; onRetry?: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="rise max-w-md text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent text-accent-foreground"><AlertTriangle className="h-5 w-5" /></span>
        <h1 className="font-display mt-4 text-2xl">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
        {onRetry && <button type="button" onClick={onRetry} data-testid="button-retry" className="mt-5 inline-flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm font-medium hover:border-primary/40"><RefreshCw className="h-4 w-4" />Try again</button>}
      </div>
    </div>
  );
}

/* ---------------- History ---------------- */

function History({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const params = debounced ? { search: debounced } : undefined;
  const list = useListConversations(params, { query: { queryKey: getListConversationsQueryKey(params) } });
  const [toDelete, setToDelete] = useState<Conversation | null>(null);
  const del = useDeleteConversation();
  const qc = useQueryClient();
  const { toast } = useToast();

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-3">
        <button type="button" onClick={() => onSelect(null)} data-testid="button-new-chat"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-sidebar-primary px-3 py-2 text-sm font-semibold text-sidebar-primary-foreground transition hover:brightness-105 active:scale-[.98]">
          <Plus className="h-4 w-4" />New conversation
        </button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
          <label htmlFor="history-search" className="sr-only">Search history</label>
          <input id="history-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search history" data-testid="input-search"
            className="w-full rounded-lg border border-sidebar-border bg-sidebar-accent/50 py-2 pl-8 pr-3 text-sm text-sidebar-accent-foreground placeholder:text-sidebar-foreground/45" />
        </div>
      </div>
      <div className="mt-3 px-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/50">History</div>
      <ul className="mt-1.5 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {list.isLoading && [0, 1, 2].map((i) => <li key={i} className="mx-2 my-2 h-9 animate-pulse rounded bg-sidebar-accent/60" />)}
        {list.isError && (
          <li className="px-2 py-3 text-xs text-sidebar-foreground/70">Could not load history. <button type="button" className="underline" onClick={() => list.refetch()}>Retry</button></li>
        )}
        {list.data?.length === 0 && (
          <li className="px-2 py-3 text-xs leading-5 text-sidebar-foreground/60">{debounced ? "No conversations match that search." : "Your conversations will appear here."}</li>
        )}
        {list.data?.map((c) => (
          <li key={c.id} className="group relative">
            <button type="button" onClick={() => onSelect(c.id)} data-testid={`button-conversation-${c.id}`}
              className={cn("w-full rounded-lg px-3 py-2 pr-9 text-left transition", c.id === selectedId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50")}>
              <span className="block truncate text-sm">{c.title}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-sidebar-foreground/55">
                <StatusDot status={c.status} />{statusLabel(c.status)} · {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}
              </span>
            </button>
            <button type="button" onClick={() => setToDelete(c)} aria-label={`Delete ${c.title}`} data-testid={`button-delete-${c.id}`}
              className="absolute right-1.5 top-2 rounded p-1.5 text-sidebar-foreground/50 opacity-0 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus:opacity-100 group-hover:opacity-100">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>"{toDelete?.title}" and its steps will be permanently removed from your history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Keep it</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-delete" className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const c = toDelete; if (!c) return;
                del.mutate({ id: c.id }, {
                  onSuccess: () => {
                    qc.invalidateQueries({ queryKey: getListConversationsQueryKey() });
                    qc.removeQueries({ queryKey: getGetConversationQueryKey(c.id) });
                    if (c.id === selectedId) onSelect(null);
                    toast({ title: "Conversation deleted" });
                  },
                  onError: () => toast({ title: "Could not delete", description: "Please try again.", variant: "destructive" }),
                });
              }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function statusLabel(s: string) { return s === "resolved" ? "Solved" : s === "handoff" ? "Needs IT" : "Open"; }
export function StatusDot({ status }: { status: string }) {
  return <span className={cn("h-1.5 w-1.5 rounded-full", status === "resolved" ? "bg-sidebar-primary" : status === "handoff" ? "bg-[hsl(38_80%_60%)]" : "bg-sidebar-foreground/40")} />;
}

/* ---------------- Device context ---------------- */

export function ContextFields({ value, onChange, idPrefix }: { value: DeviceContext; onChange: (v: DeviceContext) => void; idPrefix: string }) {
  const fields: { k: "os" | "model" | "application"; label: string; ph: string; icon: typeof Laptop }[] = [
    { k: "os", label: "Operating system", ph: "e.g. Windows 11, macOS 14", icon: Monitor },
    { k: "model", label: "Laptop model", ph: "e.g. Dell Latitude 7440", icon: Laptop },
    { k: "application", label: "Application", ph: "e.g. Teams, Zoom, Outlook", icon: AppWindow },
  ];
  return (
    <div className="space-y-3">
      {fields.map(({ k, label, ph, icon: Icon }) => (
        <div key={k}>
          <label htmlFor={`${idPrefix}-${k}`} className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"><Icon className="h-3.5 w-3.5" />{label}</label>
          <input id={`${idPrefix}-${k}`} value={value[k]} maxLength={120} placeholder={ph} data-testid={`input-context-${k}`}
            onChange={(e) => onChange({ ...value, [k]: e.target.value })}
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60" />
        </div>
      ))}
      <div>
        <label htmlFor={`${idPrefix}-deviceType`} className="text-xs font-semibold text-muted-foreground">Device type</label>
        <select id={`${idPrefix}-deviceType`} value={value.deviceType ?? ""} data-testid="select-context-device-type"
          onChange={e => onChange({ ...value, deviceType: e.target.value ? e.target.value as DeviceContext["deviceType"] : undefined })}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
          <option value="">Not confirmed</option><option value="laptop">Laptop</option><option value="desktop">Desktop</option><option value="tablet">Tablet</option>
        </select>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-vendor`} className="text-xs font-semibold text-muted-foreground">Manufacturer</label>
        <select id={`${idPrefix}-vendor`} value={value.vendor ?? ""} data-testid="select-context-vendor"
          onChange={e => onChange({ ...value, vendor: e.target.value ? e.target.value as DeviceContext["vendor"] : undefined })}
          className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm">
          <option value="">Not confirmed</option>
          {["dell", "apple", "hp", "lenovo", "asus", "acer", "microsoft", "other"].map(v => <option key={v} value={v}>{v === "hp" ? "HP" : v[0].toUpperCase() + v.slice(1)}</option>)}
        </select>
        <p className="mt-1 text-[11px] text-muted-foreground">Choose only if known. We do not infer it from the model name.</p>
      </div>
    </div>
  );
}

function ContextPanel({ conversation }: { conversation: ConversationDetail }) {
  const [ctx, setCtx] = useState<DeviceContext>(conversation.context ?? EMPTY_CTX);
  const previousServerContext = useRef(conversation.context ?? EMPTY_CTX);
  useEffect(() => {
    const previous = previousServerContext.current;
    const next = conversation.context ?? EMPTY_CTX;
    setCtx(current => {
      const merged = { ...current };
      for (const key of ["os", "model", "application"] as const) {
        if (current[key] === previous[key]) merged[key] = next[key];
      }
      if (current.vendor === previous.vendor) merged.vendor = next.vendor;
      if (current.deviceType === previous.deviceType) merged.deviceType = next.deviceType;
      return merged;
    });
    previousServerContext.current = next;
  }, [conversation.context?.os, conversation.context?.model, conversation.context?.application, conversation.context?.vendor, conversation.context?.deviceType]);
  const [saved, setSaved] = useState(false);
  const update = useUpdateConversation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const dirty = JSON.stringify(ctx) !== JSON.stringify(conversation.context ?? EMPTY_CTX);
  const save = () =>
    update.mutate({ id: conversation.id, data: ctx }, {
      onSuccess: (d) => {
        qc.setQueryData(getGetConversationQueryKey(conversation.id), d);
        qc.invalidateQueries({ queryKey: getListConversationsQueryKey() });
        setSaved(true); setTimeout(() => setSaved(false), 2200);
      },
      onError: () => toast({ title: "Could not save device details", variant: "destructive" }),
    });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-4">
      <div>
        <h2 className="font-display text-lg">Your device</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">Used to tailor each step. Leave blank if you are not sure.</p>
      </div>
      <ContextFields value={ctx} onChange={setCtx} idPrefix="ctx" />
      <button type="submit" disabled={!dirty || update.isPending} data-testid="button-save-context"
        className={cn("inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition active:scale-[.98]",
          saved ? "bg-accent text-accent-foreground" : "bg-primary text-primary-foreground disabled:opacity-40")}>
        {saved ? <><Check className="h-4 w-4" />Saved</> : update.isPending ? "Saving" : "Save details"}
      </button>
    </form>
  );
}

/* ---------------- Composer ---------------- */

export function Composer({ onSend, disabled, placeholder }: { onSend: (t: string) => void; disabled?: boolean; placeholder: string }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; } }, [text]);
  const submit = () => { const t = text.trim(); if (!t || disabled) return; onSend(t); setText(""); };
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}
      className="flex items-end gap-2 rounded-2xl border border-input bg-card p-2 shadow-[0_10px_30px_-18px_hsl(158_40%_15%/0.35)] transition focus-within:border-primary/50">
      <label htmlFor="composer" className="sr-only">Message</label>
      <textarea id="composer" ref={ref} rows={1} value={text} maxLength={4000} placeholder={placeholder} data-testid="input-message"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        className="max-h-[200px] flex-1 resize-none bg-transparent px-3 py-2 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/70 focus-visible:outline-none" />
      <button type="submit" disabled={!text.trim() || disabled} aria-label="Send message" data-testid="button-send"
        className="grid h-10 w-10 place-items-center rounded-xl bg-primary text-primary-foreground transition hover:bg-primary/90 active:scale-95 disabled:opacity-40">
        <Send className="h-4 w-4" />
      </button>
    </form>
  );
}

/* ---------------- New chat ---------------- */

function NewChat({ onCreated, paused }: { onCreated: (id: string) => void; paused?: boolean }) {
  const [ctx, setCtx] = useState<DeviceContext>(EMPTY_CTX);
  const create = useCreateConversation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const start = (text: string) => {
    if (paused) return;
    const title = text.length > 80 ? text.slice(0, 77).trimEnd() + "..." : text;
    create.mutate({ data: { title, context: ctx } }, {
      onSuccess: (d) => {
        qc.setQueryData(getGetConversationQueryKey(d.id), d);
        qc.invalidateQueries({ queryKey: getListConversationsQueryKey() });
        sessionStorage.setItem(`techassist.pending.${d.id}`, text);
        onCreated(d.id);
      },
      onError: () => toast({ title: "Could not start a conversation", description: "Please try again.", variant: "destructive" }),
    });
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-10 md:px-10 md:py-16">
      <div className="rise">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">New conversation</p>
        <h1 className="font-display mt-3 text-3xl leading-tight md:text-[2.6rem]">What is getting in your way?</h1>
        <p className="mt-3 max-w-lg text-[15px] leading-7 text-muted-foreground">Describe it in your own words. You will get one step to try, and you can tell us how it went.</p>
      </div>
      <div className="rise mt-8 grid gap-2.5 [animation-delay:80ms] sm:grid-cols-2">
        {PROMPTS.map((p) => {
          const Icon = PROMPT_ICONS[p.key as keyof typeof PROMPT_ICONS];
          return (
            <button key={p.key} type="button" disabled={create.isPending || paused} onClick={() => start(p.text)} data-testid={`button-prompt-${p.key}`}
              className="group flex items-start gap-3 rounded-xl border bg-card px-4 py-3.5 text-left transition hover:-translate-y-0.5 hover:border-primary/40 disabled:opacity-50">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground transition group-hover:bg-primary group-hover:text-primary-foreground"><Icon className="h-4 w-4" /></span>
              <span><span className="block text-sm font-semibold">{p.label}</span><span className="block text-xs leading-5 text-muted-foreground">{p.text}</span></span>
            </button>
          );
        })}
      </div>
      <details className="rise group mt-6 rounded-xl border bg-card/70 [animation-delay:140ms]">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium">
          <Laptop className="h-4 w-4 text-primary" />Add device details <span className="text-xs font-normal text-muted-foreground">optional</span>
          <ChevronDown className="ml-auto h-4 w-4 transition group-open:rotate-180" />
        </summary>
        <div className="px-4 pb-4"><ContextFields value={ctx} onChange={setCtx} idPrefix="new" /></div>
      </details>
      <div className="mt-auto pt-8">
        <Composer onSend={start} disabled={create.isPending || paused} placeholder={paused ? "New answers are paused during setup" : create.isPending ? "Starting..." : "Describe the problem"} />
        <p className="mt-2 text-center text-[11px] text-muted-foreground">Enter to send, Shift + Enter for a new line</p>
      </div>
    </div>
  );
}

/* ---------------- Conversation ---------------- */

type Live = { userText: string; stages: string[]; tokens: string } | null;

function ConversationView({ id, onGone, paused }: { id: string; onGone: () => void; paused?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const conv = useGetConversation(id, { query: { queryKey: getGetConversationQueryKey(id), retry: 1 } });
  const outcome = useRecordOutcome();
  const [live, setLive] = useState<Live>(null);
  const [streamError, setStreamError] = useState<{ text: string; msg: string; requestId?: string } | null>(null);
  const [pendingOutcome, setPendingOutcome] = useState<{ id: string; o: Outcome } | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const send = async (text: string) => {
    setStreamError(null);
    setLive({ userText: text, stages: [], tokens: "" });
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const d = await streamMessage(id, text, {
        onProgress: (s) => setLive((l) => (l && l.stages[l.stages.length - 1] !== s ? { ...l, stages: [...l.stages, s] } : l)),
        onToken: (t) => setLive((l) => (l ? { ...l, tokens: l.tokens + t } : l)),
      }, ac.signal);
      qc.setQueryData(getGetConversationQueryKey(id), d);
      qc.invalidateQueries({ queryKey: getListConversationsQueryKey() });
    } catch (e) {
      if (!ac.signal.aborted) setStreamError({ text, msg: e instanceof Error ? e.message : "Something went wrong.",
        requestId: e instanceof StreamServiceError ? e.requestId : undefined });
    } finally {
      setLive(null);
    }
  };
  const sendRef = useRef(send); sendRef.current = send;

  useEffect(() => {
    const k = `techassist.pending.${id}`;
    const pending = sessionStorage.getItem(k);
    if (pending && !paused) { sessionStorage.removeItem(k); sendRef.current(pending); }
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const msgCount = conv.data?.messages.length ?? 0;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgCount, live?.tokens.length, live?.stages.length]);

  const attemptsByMsg = useMemo(() => {
    const m = new Map<string, Outcome>();
    conv.data?.attempts.forEach((a) => m.set(a.messageId, a.outcome));
    return m;
  }, [conv.data?.attempts]);

  const pick = (messageId: string, o: Outcome) => {
    setPendingOutcome({ id: messageId, o });
    outcome.mutate({ id, data: { messageId, outcome: o } }, {
      onSuccess: (d) => { qc.setQueryData(getGetConversationQueryKey(id), d); qc.invalidateQueries({ queryKey: getListConversationsQueryKey() }); },
      onError: () => toast({ title: "Could not record that", description: "Please try again.", variant: "destructive" }),
      onSettled: () => setPendingOutcome(null),
    });
  };

  if (conv.isLoading) {
    return <div className="mx-auto w-full max-w-3xl space-y-6 p-8"><Skeleton className="h-8 w-1/2" /><Skeleton className="ml-auto h-12 w-2/3" /><Skeleton className="h-48 w-full" /></div>;
  }
  if (conv.isError || !conv.data) {
    return (
      <div className="grid flex-1 place-items-center p-8">
        <div className="text-center">
          <h1 className="font-display text-2xl">This conversation could not be opened</h1>
          <p className="mt-2 text-sm text-muted-foreground">It may have been deleted, or the connection dropped.</p>
          <div className="mt-5 flex justify-center gap-2">
            <button type="button" onClick={() => conv.refetch()} className="rounded-lg border bg-card px-4 py-2 text-sm" data-testid="button-retry-conversation">Try again</button>
            <button type="button" onClick={onGone} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" data-testid="button-start-new">Start a new one</button>
          </div>
        </div>
      </div>
    );
  }

  const c = conv.data;
  const lastAssistant = [...c.messages].reverse().find((m) => m.role === "assistant");
  const busy = !!live || !!paused;
  const failedCount = c.attempts.filter((a) => a.outcome !== "solved").length;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-14 z-10 flex items-center gap-3 border-b bg-background/90 px-5 py-3 backdrop-blur md:top-0 md:px-10">
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-lg" data-testid="text-conversation-title">{c.title}</h1>
            <p className="text-xs text-muted-foreground">{statusLabel(c.status)} · updated {formatDistanceToNow(new Date(c.updatedAt), { addSuffix: true })}</p>
          </div>
          <button type="button" onClick={() => setHandoffOpen(true)} data-testid="button-handoff"
            className={cn("inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition hover:border-primary/40",
              c.status === "handoff" || failedCount >= 2 ? "border-primary/40 bg-accent text-accent-foreground" : "bg-card")}>
            <LifeBuoy className="h-4 w-4" /><span className="hidden sm:inline">Prepare IT handoff</span><span className="sm:hidden">IT handoff</span>
          </button>
        </div>

        <details className="border-b bg-card/60 xl:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-2.5 text-sm font-medium md:px-10">
            <Laptop className="h-4 w-4 text-primary" />Device details
            <span className="truncate text-xs font-normal text-muted-foreground">{[c.context?.os, c.context?.model, c.context?.application].filter(Boolean).join(" · ") || "Not set"}</span>
            <ChevronDown className="ml-auto h-4 w-4" />
          </summary>
          <div className="px-5 pb-4 md:px-10"><ContextPanel key={c.updatedAt} conversation={c} /></div>
        </details>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-8 md:px-10">
            {c.messages.length === 0 && !live && (
              <p className="text-center text-sm text-muted-foreground">Describe the problem below to get your first step.</p>
            )}
            {c.messages.map((m) =>
              m.role === "user" ? (
                <UserBubble key={m.id} text={m.text} />
              ) : (
                <div key={m.id} className="rise space-y-4">
                  <AssistantBody text={m.text} step={m.step} explanation={m.explanation} navigation={m.navigation} expectedResult={m.expectedResult} citations={m.citations} kind={m.kind} />
                  {m.step && m.kind !== "handoff" && (m.id === lastAssistant?.id || attemptsByMsg.has(m.id)) && (
                    <OutcomeBar
                      recorded={attemptsByMsg.get(m.id)}
                      pending={pendingOutcome?.id === m.id ? pendingOutcome.o : null}
                      onPick={(o) => pick(m.id, o)}
                      nextDisabled={busy}
                      onNext={m.id === lastAssistant?.id ? () => send(attemptsByMsg.get(m.id) === "blocked" ? "I was not able to do that step. What else can I try?" : "That step did not fix it. What should I try next?") : undefined}
                    />
                  )}
                </div>
              ),
            )}
            {c.status === "handoff" && !live && (
              <div className="rise flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-accent/50 px-5 py-4">
                <LifeBuoy className="h-5 w-5 text-primary" />
                <p className="flex-1 text-sm">This looks like one for your IT team. Prepare a summary of everything you tried.</p>
                <button type="button" onClick={() => setHandoffOpen(true)} className="rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground" data-testid="button-handoff-inline">Prepare summary</button>
              </div>
            )}
            {live && (
              <>
                <UserBubble text={live.userText} />
                <div className="space-y-3" aria-live="polite">
                  {live.stages.length > 0 && (
                    <ol className="space-y-1.5">
                      {live.stages.map((s, i) => {
                        const current = i === live.stages.length - 1 && !live.tokens;
                        return (
                          <li key={i} className="rise flex items-center gap-2 text-sm text-muted-foreground" data-testid={`status-stage-${i}`}>
                            {current ? <span className="breathe h-2 w-2 rounded-full bg-primary" /> : <Check className="h-3.5 w-3.5 text-primary" />}
                            {stageLabel(s)}
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {live.stages.length === 0 && !live.tokens && <span className="breathe inline-block h-2 w-2 rounded-full bg-primary" aria-label="Waiting for response" />}
                  {live.tokens && <AssistantBody text={live.tokens} streaming />}
                </div>
              </>
            )}
            {streamError && (
              <div className="rise flex flex-wrap items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm" role="alert">
                <AlertTriangle className="h-4 w-4 text-destructive" />
                <span className="flex-1">{streamError.msg}</span>
                {streamError.requestId && <button type="button" className="rounded-md border bg-card px-3 py-1.5 font-medium"
                  onClick={() => navigator.clipboard.writeText(streamError.requestId!).then(() => toast({ title: "Support reference copied" }), () => toast({ title: "Could not copy support reference", description: streamError.requestId }))}>
                  Copy support reference
                </button>}
                <button type="button" onClick={() => send(streamError.text)} className="inline-flex items-center gap-1.5 rounded-md border bg-card px-3 py-1.5 font-medium" data-testid="button-retry-send"><RefreshCw className="h-3.5 w-3.5" />Retry</button>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </div>
        <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-background/0 px-5 pb-5 pt-6 md:px-10">
          <div className="mx-auto max-w-3xl">
            <Composer onSend={send} disabled={busy} placeholder={paused ? "New answers are paused during setup" : busy ? "Working on your next step..." : "Add detail or ask a follow-up"} />
          </div>
        </div>
      </div>

      <aside className="hidden w-[300px] shrink-0 border-l bg-card/50 p-6 xl:block">
        <div className="sticky top-6 space-y-8">
          <ContextPanel key={c.updatedAt} conversation={c} />
          <div>
            <h2 className="font-display text-lg">Steps tried</h2>
            {c.attempts.length === 0 ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">As you report back on each step, it is tracked here and included in any IT handoff.</p>
            ) : (
              <ol className="mt-3 space-y-2.5">
                {c.attempts.map((a, i) => (
                  <li key={a.messageId} className="flex gap-2.5 text-sm">
                    <span className="font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                    <span className="flex-1 leading-5">{a.step}<span className={cn("ml-1.5 text-xs font-medium", a.outcome === "solved" ? "text-primary" : "text-muted-foreground")}>{a.outcome === "solved" ? "solved" : a.outcome === "failed" ? "did not work" : "could not do"}</span></span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </aside>

      <HandoffDialog id={id} open={handoffOpen} onOpenChange={setHandoffOpen} />
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return <div className="rise ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-3 text-[15px] leading-6 text-primary-foreground">{text}</div>;
}

function HandoffDialog({ id, open, onOpenChange }: { id: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const h = useGetHandoff(id, { query: { queryKey: getGetHandoffQueryKey(id), enabled: open, staleTime: 0 } });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!h.data) return;
    try { await navigator.clipboard.writeText(h.data.summary); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl">Summary for your IT team</DialogTitle>
          <DialogDescription>This has not been sent to anyone. Copy it into your IT ticket, email, or chat.</DialogDescription>
        </DialogHeader>
        {h.isLoading || h.isFetching && !h.data ? (
          <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /><Skeleton className="h-4 w-2/3" /></div>
        ) : h.isError ? (
          <div className="text-sm">Could not prepare the summary. <button type="button" className="underline" onClick={() => h.refetch()}>Try again</button></div>
        ) : (
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-6" data-testid="text-handoff">{h.data?.summary}</pre>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="rounded-lg border px-4 py-2 text-sm" data-testid="button-close-handoff">Close</button>
          <button type="button" onClick={copy} disabled={!h.data} data-testid="button-copy-handoff"
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40">
            {copied ? <><Check className="h-4 w-4" />Copied</> : <><Copy className="h-4 w-4" />Copy summary</>}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
