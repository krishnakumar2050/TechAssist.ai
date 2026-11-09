import { useState } from "react";
import { useUser } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, FileUp, KeyRound, RefreshCw, ShieldAlert, Lock } from "lucide-react";
import {
  useGetSupportStatus, getGetSupportStatusQueryKey, useGetAdminStatus, getGetAdminStatusQueryKey, useIngestKnowledge,
  useValidateSupportSource,
} from "@workspace/api-client-react";
import { Shell } from "@/components/shell";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const MAX = 500000;
const SECRETS = [
  { name: "NEBIUS_API_KEY", secret: true, note: "Generation access" },
  { name: "PINECONE_API_KEY", secret: true, note: "Read index + inference access" },
  { name: "PINECONE_INDEX_HOST", secret: false, note: "Index host URL" },
  { name: "PINECONE_NAMESPACE", secret: false, note: "Namespace for this corpus" },
  { name: "NEBIUS_MODEL", secret: false, note: "Chat model identifier" },
];

export default function AdminPage() {
  const { user } = useUser();
  const status = useGetSupportStatus({ query: { queryKey: getGetSupportStatusQueryKey() } });
  const isAdmin = !!status.data?.admin;
  return (
    <Shell active="admin" admin={isAdmin}>
      {status.isLoading ? (
        <div className="mx-auto w-full max-w-4xl space-y-4 p-8"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-48 w-full" /></div>
      ) : !isAdmin ? (
        <div className="grid flex-1 place-items-center p-8">
          <div className="max-w-sm text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-muted"><Lock className="h-5 w-5" /></span>
            <h1 className="font-display mt-4 text-2xl">Administrators only</h1>
            <p className="mt-2 text-sm text-muted-foreground">Knowledge setup is limited to TechAssist administrators. Ask your IT team if you need access.</p>
            <p className="mt-4 text-xs leading-6 text-muted-foreground">A project owner must explicitly authorize your account through the server-only TECHASSIST_ADMIN_USER_IDS setting in the correct environment. Signing up never grants this permission.</p>
            {user && <p className="mt-3 break-all rounded-lg border p-3 font-mono text-xs">Your signed-in account ID: {user.id}</p>}
          </div>
        </div>
      ) : (
        <AdminContent />
      )}
    </Shell>
  );
}

function AdminContent() {
  const st = useGetAdminStatus({ query: { queryKey: getGetAdminStatusQueryKey() } });
  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-10 md:px-10">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Administration</p>
      <h1 className="font-display mt-2 text-3xl md:text-4xl">Knowledge setup</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Validate your approved laptop corpus and synchronize its records for lexical search and citations. Original Pinecone vectors are read-only. Live chat requires verified providers and a complete synchronized corpus; the authenticated synthetic regression is reported separately.</p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section className="space-y-6">
          <div className="rounded-2xl border bg-card p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg">Configuration</h2>
              <button type="button" onClick={() => st.refetch()} aria-label="Refresh status" data-testid="button-refresh-status" className="rounded-md p-1.5 hover:bg-muted"><RefreshCw className={cn("h-4 w-4", st.isFetching && "animate-spin")} /></button>
            </div>
            {st.isLoading ? (
              <div className="mt-4 space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
            ) : st.isError ? (
              <p className="mt-4 text-sm">Could not load status. <button type="button" onClick={() => st.refetch()} className="underline">Retry</button></p>
            ) : (
              <>
                <ul className="mt-4 space-y-2">
                  {st.data!.checks.map((c) => (
                    <li key={c.name} className="flex items-center gap-2.5 text-sm" data-testid={`status-check-${c.name}`}>
                      {c.configured ? <CheckCircle2 className="h-4 w-4 text-primary" /> : <CircleDashed className="h-4 w-4 text-muted-foreground" />}
                      <span className="font-mono text-xs">{c.name}</span>
                      <span className={cn("ml-auto text-xs", c.configured ? "text-primary" : "text-muted-foreground")}>{c.configured ? "Configured" : "Missing"}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-5 grid grid-cols-2 gap-3 border-t pt-4">
                  <Stat label="Documents" value={st.data!.documents} />
                  <Stat label="Chunks indexed" value={st.data!.chunks} />
                </div>
              </>
            )}
          </div>

          <div className="rounded-2xl border bg-card p-5">
            <h2 className="flex items-center gap-2 font-display text-lg"><KeyRound className="h-4 w-4 text-primary" />Add credentials securely</h2>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-muted-foreground">
              <li>Open the <span className="font-medium text-foreground">Secrets</span> tool in your Replit workspace.</li>
              <li>Add each value below with the exact name shown.</li>
              <li>For the hosted app, also use Publishing → Production app secrets, then republish. Development values are not a production verification.</li>
              <li>Refresh this page, then run the checks in order.</li>
            </ol>
            <p className="mt-3 text-xs text-muted-foreground">Credentials are never entered into this app. Do not paste keys into chat or documents.</p>
            <ul className="mt-4 divide-y rounded-lg border">
              {SECRETS.map((s) => (
                <li key={s.name} className="flex items-center gap-2 px-3 py-2">
                  <span className="font-mono text-xs">{s.name}</span>
                  <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", s.secret ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground")}>{s.secret ? "Secret" : "Setting"}</span>
                  <span className="hidden w-40 text-right text-xs text-muted-foreground sm:block">{s.note}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">Administrator access comes from a Clerk user with publicMetadata role set to admin, or from user IDs listed in TECHASSIST_ADMIN_USER_IDS on the server.</p>
          </div>
        </section>

        <SourceValidationPanel />
      </div>
    </div>
  );
}

function SourceValidationPanel() {
  const st = useGetAdminStatus({ query: { queryKey: getGetAdminStatusQueryKey() } });
  const mutation = useValidateSupportSource();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const report = st.data?.validation;
  async function run(action: "providers" | "sync" | "regression") {
    setBusy(true); setError(""); setProgress("Checking the live services…");
    try {
      let result = await mutation.mutateAsync({ data: { action } });
      setProgress(result.message);
      // One page per authenticated request keeps large corpus sync resumable.
      while (action === "sync" && result.stage === "syncing") {
        await qc.invalidateQueries({ queryKey: getGetAdminStatusQueryKey() });
        await new Promise(resolve => setTimeout(resolve, 2200));
        result = await mutation.mutateAsync({ data: { action: "sync" } });
        setProgress(result.message);
      }
    } catch (e: any) {
      setError(e?.data?.error || "The request did not complete. Refresh status before retrying.");
    } finally {
      await qc.invalidateQueries({ queryKey: getGetAdminStatusQueryKey() });
      await qc.invalidateQueries({ queryKey: getGetSupportStatusQueryKey() });
      setBusy(false);
    }
  }
  return <section className="rounded-2xl border bg-card p-5">
    <h2 className="font-display text-lg">Existing source validation</h2>
    <dl className="mt-4 space-y-3 break-words text-sm">
      <div><dt className="text-xs text-muted-foreground">Index / namespace</dt><dd className="mt-1 font-mono text-xs">techassist-laptops-hybrid / laptop-corpus-recursive-v2</dd></div>
      <div><dt className="text-xs text-muted-foreground">Embedding</dt><dd>Pinecone llama-text-embed-v2 · 1024 dimensions · cosine</dd></div>
      <div><dt className="text-xs text-muted-foreground">Reranking</dt><dd>Reciprocal-rank fusion → Pinecone bge-reranker-v2-m3 → up to five chunks</dd></div>
      <div><dt className="text-xs text-muted-foreground">Generation</dt><dd className="font-mono text-xs">Nebius Qwen/Qwen3-30B-A3B-Instruct-2507</dd></div>
    </dl>
    <div className="mt-5 rounded-lg border bg-background p-4" role="status" aria-live="polite">
      <p className="text-sm font-semibold">{report?.stage === "ready" ? "Source and synthetic regression passed" : report?.stage === "synced" ? "Source ready · synthetic regression pending" : "Setup required"} · {report?.stage || "Loading"}</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{busy ? progress : report?.message}</p>
      <p className="mt-2 text-xs text-muted-foreground">{report?.records || 0} records synchronized{report?.expected ? ` / ${report.expected} expected` : ""}</p>
      {report?.checkedAt && <p className="mt-1 text-xs text-muted-foreground">Last passed: {new Date(report.checkedAt).toLocaleString()}</p>}
      {report?.firstStep && <p className="mt-3 text-sm"><strong>First step tested:</strong> {report.firstStep}</p>}
      {report?.followupStep && <p className="mt-2 text-sm"><strong>Different follow-up tested:</strong> {report.followupStep}</p>}
      {report?.testConversationId && <p className="mt-3 break-all text-xs">Saved synthetic conversation: {report.testConversationId}. Open your chat history and search “SYNTHETIC TEST” to review full responses, citations and failed-step memory.</p>}
    </div>
    <div className="mt-5 space-y-3">
      {([
        ["providers", "1. Validate providers and index", !st.data?.checks.every(c => c.configured)],
        ["sync", "2. Synchronize existing corpus", !["providers", "syncing"].includes(report?.stage || "")],
        ["regression", "3. Test camera query and failed follow-up", !["synced", "ready"].includes(report?.stage || "")],
      ] as const).map(([action, label, disabled]) => <button key={action} type="button" disabled={busy || disabled}
        onClick={() => run(action)} className="w-full rounded-lg border px-4 py-3 text-left text-sm font-semibold hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40">
        {label}
      </button>)}
    </div>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <p className="mt-5 text-xs leading-6 text-muted-foreground">Synchronization reads every Pinecone record and stores its text and original metadata in this app's database. It does not upsert, re-embed, delete or rewrite existing vectors. URL checks validate citation syntax, not destination availability. Corpus content is shared with all authenticated employees.</p>
    <p className="mt-3 text-xs leading-6 text-muted-foreground">New text/JSON ingestion into this protected namespace is disabled. Have the source corpus owner approve and index additions, then validate and synchronize again.</p>
  </section>;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-display text-2xl tabular-nums" data-testid={`text-${label.toLowerCase().replace(/\s/g, "-")}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function IngestForm() {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [result, setResult] = useState<{ documentId: string; chunks: number } | null>(null);
  const ingest = useIngestKnowledge();
  const qc = useQueryClient();
  const { toast } = useToast();
  const valid = title.trim().length > 0 && content.trim().length >= 10 && content.length <= MAX;

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(txt|json)$/i.test(f.name)) { setFileNote("Only .txt or .json files are supported."); return; }
    let text = await f.text();
    if (/\.json$/i.test(f.name)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { setFileNote("That JSON file could not be parsed; loaded as plain text."); } }
    if (text.length > MAX) { setFileNote(`File is ${text.length.toLocaleString()} characters; the limit is ${MAX.toLocaleString()}.`); return; }
    setContent(text);
    if (!title) setTitle(f.name.replace(/\.(txt|json)$/i, ""));
    setFileNote(`Loaded ${f.name} into the content field. Review it, then add to knowledge.`);
  };

  const submit = () => {
    setResult(null);
    ingest.mutate({ data: { title: title.trim(), content, ...(url.trim() ? { sourceUrl: url.trim() } : {}) } }, {
      onSuccess: (r) => {
        setResult(r); setTitle(""); setUrl(""); setContent(""); setFileNote(null);
        qc.invalidateQueries({ queryKey: getGetAdminStatusQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSupportStatusQueryKey() });
      },
      onError: (e: any) => toast({ title: "Ingestion failed", description: e?.data?.error ?? "Check configuration and try again.", variant: "destructive" }),
    });
  };

  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="font-display text-lg">Add IT guidance</h2>
      <p className="mt-1 text-sm text-muted-foreground">Paste an article or load a .txt or .json file. Nothing has been imported yet unless it shows in the document count.</p>
      <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); if (valid) submit(); }}>
        <div>
          <label htmlFor="k-title" className="text-xs font-semibold text-muted-foreground">Title</label>
          <input id="k-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} data-testid="input-knowledge-title" placeholder="e.g. Reconnecting to corporate Wi-Fi"
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="k-url" className="text-xs font-semibold text-muted-foreground">Source URL <span className="font-normal">optional</span></label>
          <input id="k-url" type="url" value={url} maxLength={2000} onChange={(e) => setUrl(e.target.value)} data-testid="input-knowledge-url" placeholder="https://intranet.example/it/wifi"
            className="mt-1 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm" />
        </div>
        <div>
          <div className="flex items-end justify-between">
            <label htmlFor="k-content" className="text-xs font-semibold text-muted-foreground">Content</label>
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:border-primary/40 focus-within:outline focus-within:outline-2 focus-within:outline-ring">
              <FileUp className="h-3.5 w-3.5" />Load file
              <input type="file" accept=".txt,.json,text/plain,application/json" className="sr-only" data-testid="input-knowledge-file" onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          </div>
          <textarea id="k-content" value={content} onChange={(e) => setContent(e.target.value)} rows={14} data-testid="input-knowledge-content"
            className="mt-1 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-5" placeholder="Paste the full text of the support article" />
          <div className="mt-1 flex justify-between text-xs text-muted-foreground">
            <span>{fileNote}</span>
            <span className={cn("tabular-nums", content.length > MAX && "text-destructive")}>{content.length.toLocaleString()} / {MAX.toLocaleString()}</span>
          </div>
        </div>
        <button type="submit" disabled={!valid || ingest.isPending} data-testid="button-ingest"
          className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[.99] disabled:opacity-40">
          {ingest.isPending ? "Indexing..." : "Add to knowledge"}
        </button>
        {result && (
          <div className="rise flex items-start gap-2 rounded-lg bg-accent px-3 py-2.5 text-sm text-accent-foreground" data-testid="status-ingest">
            <CheckCircle2 className="mt-0.5 h-4 w-4" />Indexed into {result.chunks} chunks. Document ID <span className="font-mono text-xs">{result.documentId}</span>
          </div>
        )}
        {ingest.isError && <p className="flex items-center gap-1.5 text-sm text-destructive"><ShieldAlert className="h-4 w-4" />Ingestion did not complete.</p>}
      </form>
    </section>
  );
}
