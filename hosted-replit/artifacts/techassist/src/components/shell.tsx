import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { Menu, LogOut, ShieldCheck, MessagesSquare } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Wordmark } from "@/components/brand";
import { cn } from "@/lib/utils";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function Shell({
  sidebar, children, admin, active, demo,
}: { sidebar?: (close: () => void) => ReactNode; children: ReactNode; admin?: boolean; active: "chat" | "admin" | "home"; demo?: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const nav = (
    <SidebarInner active={active} admin={admin} demo={demo} onNavigate={close}>
      {sidebar?.(close)}
    </SidebarInner>
  );
  return (
    <div className="flex min-h-[100dvh] bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">Skip to content</a>
      <aside className="on-forest sticky top-0 hidden h-[100dvh] w-[288px] shrink-0 bg-sidebar text-sidebar-foreground md:flex">{nav}</aside>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="on-forest w-[300px] border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {nav}
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur md:hidden">
          <button type="button" onClick={() => setOpen(true)} aria-label="Open navigation" data-testid="button-mobile-nav" className="rounded-md p-2 hover:bg-muted">
            <Menu className="h-5 w-5" />
          </button>
          <Wordmark />
          {demo && <DemoBadge />}
        </header>
        {demo && (
          <div className="flex items-center gap-2 border-b bg-[hsl(38_70%_92%)] px-4 py-2 text-xs text-[hsl(30_50%_22%)] md:px-10" role="status" data-testid="banner-demo">
            <DemoBadge />Demo workspace. Answers are illustrative, not live retrieval. Nothing leaves this browser tab.
          </div>
        )}
        <main id="main" className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}

export function DemoBadge() {
  return <span className="rounded bg-[hsl(32_70%_40%)] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-[hsl(40_40%_97%)]">Demo</span>;
}

function SidebarInner({ children, active, admin, demo, onNavigate }: { children: ReactNode; active: string; admin?: boolean; demo?: boolean; onNavigate: () => void }) {
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const name = user?.firstName || user?.primaryEmailAddress?.emailAddress || "Signed in";
  const initials = (user?.firstName?.[0] ?? name[0] ?? "U").toUpperCase() + (user?.lastName?.[0] ?? "").toUpperCase();
  const item = (on: boolean) =>
    cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition", on ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground");
  return (
    <div className="flex h-full w-full flex-col">
      <div className="px-5 pb-4 pt-5">
        <Link href="/" onClick={onNavigate} className="inline-flex items-center gap-2" data-testid="link-home"><Wordmark light />{demo && <DemoBadge />}</Link>
      </div>
      <nav className="space-y-0.5 px-3" aria-label="Primary">
        <Link href={isSignedIn ? "/chat" : "/"} onClick={onNavigate} className={item(active === "chat" || active === "home")} data-testid="link-chat"><MessagesSquare className="h-4 w-4" />Support chat</Link>
        {admin && <Link href="/admin" onClick={onNavigate} className={item(active === "admin")} data-testid="link-admin"><ShieldCheck className="h-4 w-4" />Knowledge setup</Link>}
      </nav>
      <div className="mt-4 min-h-0 flex-1 overflow-hidden">{children}</div>
      {!isSignedIn ? (
        <div className="space-y-2 border-t border-sidebar-border px-4 py-4">
          <p className="text-xs leading-5 text-sidebar-foreground/65">Sign in to get real answers and keep your history.</p>
          <div className="flex gap-2">
            <Link href="/sign-in" onClick={onNavigate} className="flex-1 rounded-lg bg-sidebar-primary px-3 py-2 text-center text-sm font-semibold text-sidebar-primary-foreground" data-testid="link-signin">Sign in</Link>
            <Link href="/sign-up" onClick={onNavigate} className="flex-1 rounded-lg border border-sidebar-border px-3 py-2 text-center text-sm text-sidebar-accent-foreground hover:bg-sidebar-accent" data-testid="link-signup">Create account</Link>
          </div>
        </div>
      ) : (
      <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-3">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-sidebar-primary/20 text-xs font-semibold text-sidebar-primary">{initials}</span>
        <span className="min-w-0 flex-1 truncate text-sm" data-testid="text-username">{name}</span>
        <button type="button" onClick={() => signOut({ redirectUrl: basePath || "/" })} aria-label="Sign out" data-testid="button-signout"
          className="rounded-md p-2 text-sidebar-foreground/70 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
          <LogOut className="h-4 w-4" />
        </button>
      </div>
      )}
    </div>
  );
}
