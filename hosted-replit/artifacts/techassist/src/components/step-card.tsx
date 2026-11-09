import { Check, X, Ban, Compass, Target, Info, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

type Citation = { id: string; title: string; url?: string; excerpt: string };

export function AssistantBody({
  text, step, explanation, navigation, expectedResult, citations, streaming, kind,
}: {
  text: string; step?: string; explanation?: string; navigation?: string; expectedResult?: string;
  citations?: Citation[]; streaming?: boolean;
  kind?: "clarification" | "guidance" | "handoff";
}) {
  return (
    <div className="space-y-4">
      {kind === "clarification" && <p className="text-xs font-semibold text-primary">One quick question</p>}
      {kind === "handoff" && <p className="text-xs font-semibold text-muted-foreground">Guidance coverage limit · IT handoff recommended</p>}
      {text && <p className={cn("whitespace-pre-wrap text-[15px] leading-7 text-foreground/90", streaming && "caret")}>{text}</p>}
      {step && (
        <div className="overflow-hidden rounded-xl border border-primary/25 bg-card">
          <div className="border-b border-primary/15 bg-accent/60 px-5 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-foreground">Your next step</div>
            <p className="font-display mt-1 text-[1.2rem] leading-snug text-foreground" data-testid="text-step">{step}</p>
          </div>
          <dl className="divide-y divide-border">
            {navigation && <Row icon={Compass} label="Where to go" value={navigation} />}
            {expectedResult && <Row icon={Target} label="What you should see" value={expectedResult} />}
            {explanation && <Row icon={Info} label="Why this helps" value={explanation} />}
          </dl>
        </div>
      )}
      {citations && citations.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><BookOpen className="h-3.5 w-3.5" />Based on</div>
          <div className="flex flex-wrap gap-2">
            {citations.map((c) => {
              const inner = (
                <>
                  <span className="font-medium text-foreground">{c.title}</span>
                  <span className="line-clamp-2 text-muted-foreground">{c.excerpt}</span>
                </>
              );
              return c.url ? (
                <a key={c.id} href={c.url} target="_blank" rel="noreferrer" className="flex max-w-xs flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-xs transition hover:-translate-y-0.5 hover:border-primary/40">{inner}</a>
              ) : (
                <div key={c.id} className="flex max-w-xs flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-xs">{inner}</div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ icon: Icon, label, value }: { icon: typeof Compass; label: string; value: string }) {
  return (
    <div className="grid grid-cols-[20px_1fr] gap-3 px-5 py-3">
      <Icon className="mt-0.5 h-4 w-4 text-primary" />
      <div>
        <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
        <dd className="mt-0.5 text-sm leading-6">{value}</dd>
      </div>
    </div>
  );
}

export type Outcome = "solved" | "failed" | "blocked";

export function OutcomeBar({
  recorded, pending, onPick, onNext, nextDisabled,
}: {
  recorded?: Outcome; pending?: Outcome | null; onPick: (o: Outcome) => void; onNext?: () => void; nextDisabled?: boolean;
}) {
  if (recorded) {
    const map = {
      solved: { t: "Marked as solved. Glad that worked.", c: "text-primary" },
      failed: { t: "Noted: still not working. The next suggestion will skip this step.", c: "text-foreground/80" },
      blocked: { t: "Noted: you could not do this step. The next suggestion will work around it.", c: "text-foreground/80" },
    }[recorded];
    return (
      <div className="rise flex flex-wrap items-center gap-3 rounded-lg bg-muted/70 px-4 py-2.5 text-sm">
        <span className={map.c} data-testid="status-outcome">{map.t}</span>
        {recorded !== "solved" && onNext && (
          <button type="button" disabled={nextDisabled} onClick={onNext} data-testid="button-next-step"
            className="ml-auto rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[.98] disabled:opacity-50">
            Get the next step
          </button>
        )}
      </div>
    );
  }
  const btns: { o: Outcome; label: string; icon: typeof Check; cls: string }[] = [
    { o: "solved", label: "That solved it", icon: Check, cls: "border-primary/40 text-primary hover:bg-accent" },
    { o: "failed", label: "Still not working", icon: X, cls: "hover:bg-muted" },
    { o: "blocked", label: "I cannot do this", icon: Ban, cls: "hover:bg-muted" },
  ];
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="How did this step go?">
      {btns.map(({ o, label, icon: Icon, cls }) => (
        <button key={o} type="button" disabled={!!pending} onClick={() => onPick(o)} data-testid={`button-outcome-${o}`}
          className={cn("inline-flex items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 text-sm font-medium transition active:scale-[.97] disabled:opacity-50", cls)}>
          <Icon className={cn("h-3.5 w-3.5", pending === o && "breathe")} />{label}
        </button>
      ))}
    </div>
  );
}
