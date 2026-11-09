import { useEffect, useRef, type ReactNode } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import ChatPage from "@/pages/chat";
import AdminPage from "@/pages/admin";
import { clearDemo } from "@/lib/demo";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(156 62% 27%)",
    colorForeground: "hsl(160 28% 12%)",
    colorMutedForeground: "hsl(160 9% 36%)",
    colorDanger: "hsl(4 62% 44%)",
    colorBackground: "hsl(40 40% 98.5%)",
    colorInput: "hsl(40 30% 96%)",
    colorInputForeground: "hsl(160 28% 12%)",
    colorNeutral: "hsl(160 28% 12%)",
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[hsl(40_40%_98.5%)] rounded-2xl w-[440px] max-w-full overflow-hidden border border-[hsl(38_18%_85%)] shadow-[0_30px_60px_-30px_hsl(158_40%_15%/0.3)]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "font-['Fraunces'] text-2xl font-medium text-[hsl(160_28%_12%)]",
    headerSubtitle: "text-[hsl(160_9%_36%)]",
    socialButtonsBlockButtonText: "text-[hsl(160_28%_12%)] font-medium",
    formFieldLabel: "text-[hsl(160_28%_14%)] font-semibold",
    footerActionLink: "text-[hsl(156_62%_27%)] font-semibold",
    footerActionText: "text-[hsl(160_9%_36%)]",
    dividerText: "text-[hsl(160_9%_40%)]",
    identityPreviewEditButton: "text-[hsl(156_62%_27%)]",
    formFieldSuccessText: "text-[hsl(156_62%_27%)]",
    alertText: "text-[hsl(160_28%_12%)]",
    logoBox: "h-12 justify-center",
    logoImage: "h-12 w-12",
    socialButtonsBlockButton: "border border-[hsl(38_16%_80%)] bg-[hsl(40_30%_96%)]",
    formButtonPrimary: "bg-[hsl(156_62%_27%)] text-[hsl(60_30%_97%)] font-semibold",
    formFieldInput: "border border-[hsl(38_16%_80%)] bg-[hsl(40_30%_96%)] text-[hsl(160_28%_12%)]",
    footerAction: "bg-transparent",
    dividerLine: "bg-[hsl(38_18%_85%)]",
    alert: "border border-[hsl(38_18%_85%)] bg-[hsl(40_22%_91%)]",
    otpCodeFieldInput: "border border-[hsl(38_16%_80%)] text-[hsl(160_28%_12%)]",
    formFieldRow: "gap-2",
    main: "gap-5",
  },
};

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-[100dvh] md:grid-cols-[1fr_1.1fr]">
      <div className="on-forest relative hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground md:flex">
        <span className="font-display text-xl text-sidebar-accent-foreground">TechAssist<span className="text-sidebar-primary">.ai</span></span>
        <div>
          <p className="font-display text-4xl leading-tight text-sidebar-accent-foreground">Calm IT help,<br />one step at a time.</p>
          <p className="mt-4 max-w-sm text-sm leading-6 text-sidebar-foreground/70">Sign in to keep your support history, device details, and IT handoff summaries in one place.</p>
        </div>
        <span className="text-xs text-sidebar-foreground/50">Your conversations are visible only to you.</span>
      </div>
      <div className="flex items-center justify-center bg-background px-4 py-10">{children}</div>
    </div>
  );
}

function SignInPage() {
  const adminReturn = new URLSearchParams(window.location.search).get("admin") === "1";
  return <AuthFrame><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    {...(adminReturn ? { forceRedirectUrl: `${basePath}/admin` } : {})} /></AuthFrame>;
}
function SignUpPage() {
  return <AuthFrame><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></AuthFrame>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
        clearDemo();
        try {
          Object.keys(sessionStorage).filter((k) => k.startsWith("techassist.")).forEach((k) => sessionStorage.removeItem(k));
        } catch { /* ignore */ }
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);
  return null;
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/chat" /></Show>
      <Show when="signed-out"><Home /></Show>
    </>
  );
}
function Protected({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">{admin ? (
        <AuthFrame><div className="max-w-md rounded-2xl border bg-card p-8">
          <h1 className="font-display text-2xl">Administrator sign-in required</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">This is the restricted TechAssist setup page, not the demo. Sign in with your explicitly authorized administrator account. Creating an account does not grant administrator access.</p>
          <a className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" href={`${basePath}/sign-in?admin=1`}>Sign in to administration</a>
        </div></AuthFrame>
      ) : <Redirect to="/" />}</Show>
    </>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: { start: { title: "Welcome back", subtitle: "Sign in to pick up where you left off" } },
        signUp: { start: { title: "Create your account", subtitle: "Keep your IT support history in one place" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route path="/chat">{() => <Protected><ChatPage /></Protected>}</Route>
              <Route path="/admin">{() => <Protected admin><AdminPage /></Protected>}</Route>
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
