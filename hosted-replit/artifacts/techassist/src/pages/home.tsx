import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { Plus, Search, Trash2, LifeBuoy, Laptop, ChevronDown, Check, Copy, FlaskConical, LogIn, LogOut } from "lucide-react";
import { useGetSupportStatus, getGetSupportStatusQueryKey, type DeviceContext } from "@workspace/api-client-react";
import { Shell, DemoBadge } from "@/components/shell";
import { PROMPTS } from "@/components/brand";
import { AssistantBody, OutcomeBar, type Outcome } from "@/components/step-card";
import { ContextFields, Composer, UserBubble, PROMPT_ICONS, EMPTY_CTX, SetupNotice } from "@/pages/chat";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  demoHandoff, demoReply, isDemoOn, loadDemo, newId, saveDemo, setDemoOn, clearDemo, userMsg, type DemoSession,
} from "@/lib/demo";
import { cn } from "@/lib/utils";

export default function Home() {
  const status = useGetSupportStatus({ query: { queryKey: getGetSupportStatusQueryKey(), retry: false } });
  const [demo, setDemo] = useState(() => isDemoOn());
  const [sessions, setSessions] = useState<DemoSession[]>(() => (isDemoOn() ? loadDemo() : []));
  const [selected, setSelected] = useState<string | null>(null);
  const [guestCtx, setGuestCtx] = useState<DeviceContext>(EMPTY_CTX);
  const [gate, setGate] = useState<string | null>(null);

  useEffect(() => { if (demo) saveDemo(sessions); }, [sessions, demo]);

  const enterDemo = (firstText?: string) => {
    setDemoOn(true); setDemo(true); setGate(null);
    if (firstText) startDemo(firstText, guestCtx);
  };
  const exitDemo = () => { clearDemo(); setDemo(false); setSessions([]); setSelected(null); };

  const startDemo = (text: string, ctx: DeviceContext) => {
    const u = userMsg(text);
    const s: DemoSession = {
      id: newId(), title: text.length > 70 ? text.slice(0, 67) + "..." : text, updatedAt: new Date().toISOString(),
      context: ctx, messages: [u, demoReply([u], text)],
    };
    setSessions((all) => [s, ...all]);
    setSelected(s.id);
  };
  const patch = (id: string, fn: (s: DemoSession) => DemoSession) =>
    setSessions((all) => all.map((s) => (s.id === id ? { ...fn(s), updatedAt: new Date().toISOString() } : s)));

  const current = sessions.find((s) => s.id === selected) ?? null;
  const notReady = status.data ? !status.data.ready : false;

  return (
    <Shell
      active="home"
      demo={demo}
      sidebar={(close) =>
        demo ? (
          <DemoHistory sessions={sessions} selected={selected}
            onSelect={(id) => { setSelected(id); close(); }}
            onDelete={(id) => { setSessions((a) => a.filter((s) => s.id !== id)); if (id === selected) setSelected(null); }}
            onExit={() => { exitDemo(); close(); }} />
        ) : (
          <GuestSidebar onDemo={() => { enterDemo(); close(); }} />
        )
      }
    >
      {notReady && !demo && <SetupNotice />}
      {demo && current ? (
        <DemoConversation key={current.id} session={current} patch={(fn) => patch(current.id, fn)} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <Welcome
            demo={demo}
            ctx={guestCtx}
            onCtx={setGuestCtx}
            gate={gate}
            onSubmit={(t) => (demo ? startDemo(t, guestCtx) : setGate(t))}
            onDemo={() => enterDemo(gate ?? undefined)}
            onDismissGate={() => setGate(null)}
          />
          <aside className="hidden w-[300px] shrink-0 border-l bg-card/50 p-6 xl:block">
            <div className="sticky top-6 space-y-3">
              <h2 className="font-display text-lg">Your device</h2>
              <p className="text-xs leading-5 text-muted-foreground">Optional. Helps tailor each step to your setup.</p>
              <ContextFields value={guestCtx} onChange={setGuestCtx} idPrefix="guest" />
            </div>
          </aside>
        </div>
      )}
    </Shell>
  );
}

function GuestSidebar({ onDemo }: { onDemo: () => void }) {
  return (
    <div className="space-y-4 px-3">
      <div className="rounded-xl border border-sidebar-border bg-sidebar-accent/40 p-4">
        <p className="text-sm text-sidebar-accent-foreground">Your history lives here once you sign in.</p>
        <p className="mt-1.5 text-xs leading-5 text-sidebar-foreground/60">Want to see how it works first? The demo stays in this tab and uses illustrative answers.</p>
        <button type="button" onClick={onDemo} data-testid="button-try-demo"
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-sidebar-primary/50 px-3 py-2 text-sm font-medium text-sidebar-primary transition hover:bg-sidebar-accent active:scale-[.98]">
          <FlaskConical className="h-4 w-4" />Try the demo
        </button>
      </div>
    </div>
  );
}

function Welcome({ demo, ctx, onCtx, gate, onSubmit, onDemo, onDismissGate }: {
  demo: boolean; ctx: DeviceContext; onCtx: (c: DeviceContext) => void; gate: string | null;
  onSubmit: (t: string) => void; onDemo: () => void; onDismissGate: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <details className="border-b bg-card/60 xl:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-2.5 text-sm font-medium md:px-10">
          <Laptop className="h-4 w-4 text-primary" />Device details <span className="text-xs font-normal text-muted-foreground">optional</span>
          <ChevronDown className="ml-auto h-4 w-4" />
        </summary>
        <div className="px-5 pb-4 md:px-10"><ContextFields value={ctx} onChange={onCtx} idPrefix="guest-m" /></div>
      </details>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 py-10 md:px-10 md:py-16">
        <div className="rise">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">{demo ? "Demo conversation" : "IT help for people at work"}</p>
          <h1 className="font-display mt-3 text-3xl leading-tight md:text-[2.6rem]">What is getting in your way?</h1>
          <p className="mt-3 max-w-lg text-[15px] leading-7 text-muted-foreground">You get one grounded step to try, then tell us how it went. If it does not work, the next step skips it.</p>
        </div>
        <div className="rise mt-8 grid gap-2.5 [animation-delay:80ms] sm:grid-cols-2">
          {PROMPTS.map((p) => {
            const Icon = PROMPT_ICONS[p.key as keyof typeof PROMPT_ICONS];
            return (
              <button key={p.key} type="button" onClick={() => onSubmit(p.text)} data-testid={`button-prompt-${p.key}`}
                className="group flex items-start gap-3 rounded-xl border bg-card px-4 py-3.5 text-left transition hover:-translate-y-0.5 hover:border-primary/40">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground transition group-hover:bg-primary group-hover:text-primary-foreground"><Icon className="h-4 w-4" /></span>
                <span><span className="block text-sm font-semibold">{p.label}</span><span className="block text-xs leading-5 text-muted-foreground">{p.text}</span></span>
              </button>
            );
          })}
        </div>
        {gate && (
          <div className="rise mt-6 rounded-xl border border-primary/30 bg-accent/50 p-5" role="dialog" aria-label="Sign in or try demo" data-testid="panel-gate">
            <p className="text-sm text-muted-foreground">You asked:</p>
            <p className="mt-1 font-medium">{gate}</p>
            <p className="mt-3 text-sm leading-6">Sign in to get a real answer from your IT knowledge base. Or explore the demo, which uses illustrative answers only.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/sign-in" className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground" data-testid="link-gate-signin"><LogIn className="h-4 w-4" />Sign in</Link>
              <button type="button" onClick={onDemo} className="inline-flex items-center gap-2 rounded-lg border bg-card px-4 py-2 text-sm font-medium" data-testid="button-gate-demo"><FlaskConical className="h-4 w-4 text-primary" />Continue in demo</button>
              <button type="button" onClick={onDismissGate} className="ml-auto rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted" data-testid="button-gate-dismiss">Not now</button>
            </div>
          </div>
        )}
        <div className="mt-auto pt-8">
          <Composer onSend={onSubmit} placeholder={demo ? "Describe the problem (demo)" : "Describe the problem"} />
          <p className="mt-2 text-center text-[11px] text-muted-foreground">{demo ? "Demo answers are illustrative and stay in this tab." : "Sign in to send. Enter to send, Shift + Enter for a new line."}</p>
        </div>
      </div>
    </div>
  );
}

function DemoHistory({ sessions, selected, onSelect, onDelete, onExit }: {
  sessions: DemoSession[]; selected: string | null; onSelect: (id: string | null) => void; onDelete: (id: string) => void; onExit: () => void;
}) {
  const [q, setQ] = useState("");
  const [toDelete, setToDelete] = useState<DemoSession | null>(null);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? sessions.filter((s) => s.title.toLowerCase().includes(t) || s.messages.some((m) => m.text.toLowerCase().includes(t))) : sessions;
  }, [q, sessions]);
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 px-3">
        <button type="button" onClick={() => onSelect(null)} data-testid="button-new-chat"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-sidebar-primary px-3 py-2 text-sm font-semibold text-sidebar-primary-foreground transition hover:brightness-105 active:scale-[.98]">
          <Plus className="h-4 w-4" />New demo conversation
        </button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground/50" />
          <label htmlFor="demo-search" className="sr-only">Search demo history</label>
          <input id="demo-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search demo history" data-testid="input-search"
            className="w-full rounded-lg border border-sidebar-border bg-sidebar-accent/50 py-2 pl-8 pr-3 text-sm text-sidebar-accent-foreground placeholder:text-sidebar-foreground/45" />
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2 px-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/50">Demo history <DemoBadge /></div>
      <ul className="mt-1.5 flex-1 space-y-0.5 overflow-y-auto px-3 pb-3">
        {shown.length === 0 && <li className="px-2 py-3 text-xs leading-5 text-sidebar-foreground/60">{q ? "No demo conversations match." : "Demo conversations you start appear here, only in this tab."}</li>}
        {shown.map((s) => (
          <li key={s.id} className="group relative">
            <button type="button" onClick={() => onSelect(s.id)} data-testid={`button-conversation-${s.id}`}
              className={cn("w-full rounded-lg px-3 py-2 pr-9 text-left transition", s.id === selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50")}>
              <span className="block truncate text-sm">{s.title}</span>
              <span className="mt-0.5 block text-[11px] text-sidebar-foreground/55">{formatDistanceToNow(new Date(s.updatedAt), { addSuffix: true })}</span>
            </button>
            <button type="button" onClick={() => setToDelete(s)} aria-label={`Delete ${s.title}`} data-testid={`button-delete-${s.id}`}
              className="absolute right-1.5 top-2 rounded p-1.5 text-sidebar-foreground/50 opacity-0 transition hover:bg-sidebar-accent focus:opacity-100 group-hover:opacity-100">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="px-3 pb-3">
        <button type="button" onClick={onExit} data-testid="button-exit-demo"
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-sidebar-border px-3 py-2 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent">
          <LogOut className="h-4 w-4" />Exit demo and clear
        </button>
      </div>
      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display">Delete this demo conversation?</AlertDialogTitle>
            <AlertDialogDescription>"{toDelete?.title}" will be removed from this tab.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Keep it</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-delete" className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (toDelete) onDelete(toDelete.id); setToDelete(null); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DemoContext({ session, onSave }: { session: DemoSession; onSave: (c: DeviceContext) => void }) {
  const [ctx, setCtx] = useState<DeviceContext>(session.context);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(ctx) !== JSON.stringify(session.context);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(ctx); setSaved(true); setTimeout(() => setSaved(false), 2000); }} className="space-y-4">
      <div><h2 className="font-display text-lg">Your device</h2><p className="mt-1 text-xs text-muted-foreground">Saved in this tab only.</p></div>
      <ContextFields value={ctx} onChange={setCtx} idPrefix={`demo-${session.id}`} />
      <button type="submit" disabled={!dirty && !saved} data-testid="button-save-context"
        className={cn("inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition active:scale-[.98]", saved ? "bg-accent text-accent-foreground" : "bg-primary text-primary-foreground disabled:opacity-40")}>
        {saved ? <><Check className="h-4 w-4" />Saved</> : "Save details"}
      </button>
    </form>
  );
}

function DemoConversation({ session, patch }: { session: DemoSession; patch: (fn: (s: DemoSession) => DemoSession) => void }) {
  const [handoff, setHandoff] = useState(false);
  const [copied, setCopied] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [session.messages.length]);
  const lastA = [...session.messages].reverse().find((m) => m.role === "assistant");
  const send = (t: string) => patch((s) => { const u = userMsg(t); return { ...s, messages: [...s.messages, u, demoReply([...s.messages, u], t)] }; });
  const pick = (id: string, o: Outcome) => patch((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, outcome: o } : m)) }));
  const summary = demoHandoff(session);
  const saveCtx = (c: DeviceContext) => patch((s) => ({ ...s, context: c }));

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-14 z-10 flex items-center gap-3 border-b bg-background/90 px-5 py-3 backdrop-blur md:top-0 md:px-10">
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 truncate font-display text-lg" data-testid="text-conversation-title"><DemoBadge /><span className="truncate">{session.title}</span></h1>
            <p className="text-xs text-muted-foreground">Session only · not saved to your account</p>
          </div>
          <button type="button" onClick={() => setHandoff(true)} data-testid="button-handoff" className="inline-flex shrink-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm font-medium hover:border-primary/40">
            <LifeBuoy className="h-4 w-4" /><span className="hidden sm:inline">Prepare IT handoff</span><span className="sm:hidden">IT handoff</span>
          </button>
        </div>
        <details className="border-b bg-card/60 xl:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-2.5 text-sm font-medium md:px-10"><Laptop className="h-4 w-4 text-primary" />Device details<ChevronDown className="ml-auto h-4 w-4" /></summary>
          <div className="px-5 pb-4 md:px-10"><DemoContext session={session} onSave={saveCtx} /></div>
        </details>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-8 md:px-10">
            {session.messages.map((m) =>
              m.role === "user" ? <UserBubble key={m.id} text={m.text} /> : (
                <div key={m.id} className="rise space-y-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(32_70%_38%)]">Illustrative demo answer · not live retrieval</div>
                  <AssistantBody text={m.text} step={m.step} explanation={m.explanation} navigation={m.navigation} expectedResult={m.expectedResult} />
                  {m.step && (m.id === lastA?.id || m.outcome) && (
                    <OutcomeBar recorded={m.outcome} onPick={(o) => pick(m.id, o)}
                      onNext={m.id === lastA?.id ? () => send(m.outcome === "blocked" ? "I was not able to do that step. What else can I try?" : "That step did not fix it. What should I try next?") : undefined} />
                  )}
                </div>
              ),
            )}
            <div ref={endRef} />
          </div>
        </div>
        <div className="sticky bottom-0 bg-gradient-to-t from-background via-background to-background/0 px-5 pb-5 pt-6 md:px-10">
          <div className="mx-auto max-w-3xl"><Composer onSend={send} placeholder="Add detail (demo)" /></div>
        </div>
      </div>
      <aside className="hidden w-[300px] shrink-0 border-l bg-card/50 p-6 xl:block">
        <div className="sticky top-6"><DemoContext session={session} onSave={saveCtx} /></div>
      </aside>
      <Dialog open={handoff} onOpenChange={setHandoff}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display text-xl"><DemoBadge />Summary for your IT team</DialogTitle>
            <DialogDescription>Illustrative demo summary. It has not been sent to anyone.</DialogDescription>
          </DialogHeader>
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/50 p-4 font-mono text-xs leading-6" data-testid="text-handoff">{summary}</pre>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setHandoff(false)} className="rounded-lg border px-4 py-2 text-sm" data-testid="button-close-handoff">Close</button>
            <button type="button" data-testid="button-copy-handoff" onClick={async () => { try { await navigator.clipboard.writeText(summary); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* ignore */ } }}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
              {copied ? <><Check className="h-4 w-4" />Copied</> : <><Copy className="h-4 w-4" />Copy summary</>}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
