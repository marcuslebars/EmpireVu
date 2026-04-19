import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { OrgProvider } from "@/lib/org-context";
import { ErrorBoundary, GlobalErrorHandler } from "@/components/system/ErrorBoundary";
import { ProtectedRoute, AuthRedirect } from "@/components/system/ProtectedRoute";
import { AppLayout } from "@/components/layout/AppLayout";
import { AppDiagnosticsPage } from "@/pages/AppDiagnosticsPage";
import { OpsPage } from "@/pages/OpsPage";
import SignInPage from "./pages/SignInPage";
import SignUpPage from "./pages/SignUpPage";
import OAuthConsentPage from "./pages/OAuthConsentPage";
import OAuthCallbackPage from "./pages/OAuthCallbackPage";
import PhoneAuthPage from "./pages/PhoneAuthPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import UpdatePasswordPage from "./pages/UpdatePasswordPage";
import OnboardingPage from "./pages/OnboardingPage";
import Dashboard from "./pages/Dashboard";
import CalendarPage from "./pages/CalendarPage";
import TasksPage from "./pages/TasksPage";
import CRMPage from "./pages/CRMPage";
import ContactDetailPage from "./pages/ContactDetailPage";
import ProjectsPage from "./pages/ProjectsPage";
import AutomationsPage from "./pages/AutomationsPage";
import FilesPage from "./pages/FilesPage";
import TeamPage from "./pages/TeamPage";
import SettingsPage from "./pages/SettingsPage";
import NotFound from "./pages/NotFound";
import { Loader2, AlertTriangle, Bug, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function LoadingScreen({ message = "Loading Syncoree..." }: { message?: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4">
      <Loader2 className="h-10 w-10 animate-spin text-primary" />
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}

const ORG_STORAGE_KEY = "syncoree_org_id";

function getEffectiveOrgId(session: { activeOrganizationId: string | null; organizations: Array<{ id: string }> } | null): string {
  if (!session) return "";
  if (session.activeOrganizationId) return session.activeOrganizationId;
  if (session.organizations?.length > 0) return session.organizations[0].id;
  return "";
}

function BootstrapDiagnostics({
  authStatus,
  session,
  bootstrapPhase,
}: {
  authStatus: string;
  session: { activeOrganizationId: string | null; organizations: Array<{ id: string; name: string }> } | null;
  bootstrapPhase: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const effectiveOrgId = getEffectiveOrgId(session);
  const storedOrgId = typeof window !== "undefined" ? localStorage.getItem(ORG_STORAGE_KEY) : null;

  const canProceedToApp = authStatus === "authenticated" && effectiveOrgId !== "";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
      <Card className="w-full max-w-md border-primary/50">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Bug className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground mb-1">Bootstrap Diagnostics</h1>
              <p className="text-sm text-muted-foreground">
                Internal view — shows auth and org context state
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-3 text-left">
            <div className="flex justify-between items-center py-1 border-b border-border">
              <span className="text-sm text-muted-foreground">Bootstrap Phase</span>
              <span className="text-sm font-mono font-medium">{bootstrapPhase}</span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-border">
              <span className="text-sm text-muted-foreground">Auth Status</span>
              <span className={`text-sm font-mono font-medium ${authStatus === "authenticated" ? "text-green-500" : authStatus === "loading" ? "text-yellow-500" : "text-red-500"}`}>
                {authStatus}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-border">
              <span className="text-sm text-muted-foreground">Session Active Org ID</span>
              <span className="text-sm font-mono font-medium truncate max-w-[180px]">
                {session?.activeOrganizationId ?? <span className="text-muted-foreground">(null)</span>}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-border">
              <span className="text-sm text-muted-foreground">localStorage Org ID</span>
              <span className="text-sm font-mono font-medium truncate max-w-[180px]">
                {storedOrgId ?? <span className="text-muted-foreground">(none)</span>}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-border">
              <span className="text-sm text-muted-foreground">Effective Org ID</span>
              <span className={`text-sm font-mono font-medium ${effectiveOrgId ? "text-green-500" : "text-red-500"}`}>
                {effectiveOrgId || <span className="text-muted-foreground">(none)</span>}
              </span>
            </div>
            <div className="flex justify-between items-center py-1 border-b border-border">
              <span className="text-sm text-muted-foreground">Session Orgs Count</span>
              <span className="text-sm font-mono font-medium">
                {session?.organizations?.length ?? 0}
              </span>
            </div>
            <div className="flex justify-between items-center py-1">
              <span className="text-sm text-muted-foreground">Can Proceed to App</span>
              <span className={`text-sm font-mono font-medium ${canProceedToApp ? "text-green-500" : "text-red-500"}`}>
                {canProceedToApp ? "YES" : "NO"}
              </span>
            </div>
          </div>

          {expanded && session?.organizations && session.organizations.length > 0 && (
            <div className="mt-4 p-3 rounded-lg bg-muted">
              <p className="text-xs font-medium text-muted-foreground mb-2">Organizations in session:</p>
              <div className="space-y-1">
                {session.organizations.map(org => (
                  <div key={org.id} className="flex justify-between text-xs font-mono">
                    <span>{org.id}</span>
                    {org.name && <span className="text-muted-foreground">{org.name}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-4 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown className="w-4 h-4 mr-1" /> : <ChevronRight className="w-4 h-4 mr-1" />}
              {expanded ? "Hide" : "Show"} Details
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ImpossibleStateFallback({ phase }: { phase: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4">
      <Card className="w-full max-w-md border-destructive/50">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <AlertTriangle className="w-6 h-6 text-destructive" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground mb-1">Syncoree failed to load</h1>
              <p className="text-sm text-muted-foreground">
                An unexpected bootstrap state was reached: {phase}
              </p>
            </div>
            <div className="flex gap-3">
              <Button onClick={() => window.location.reload()}>
                <Loader2 className="w-4 h-4 mr-2" />
                Reload
              </Button>
              <Button variant="outline" onClick={() => { localStorage.clear(); window.location.href = "/signin"; }}>
                Clear Data & Sign In
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AppBootstrapInner({ children }: { children?: React.ReactNode }) {
  const { status: authStatus, session } = useAuth();

  console.log("[AppBootstrap] Render:", {
    authStatus,
    hasSession: Boolean(session),
    activeOrgId: session?.activeOrganizationId,
    orgCount: session?.organizations?.length,
    storedOrgId: typeof window !== "undefined" ? localStorage.getItem(ORG_STORAGE_KEY) : null,
    sessionData: session ? {
      hasOrgId: Boolean(session.activeOrganizationId),
      orgCount: session.organizations?.length ?? 0,
      hasUser: Boolean(session.user?.id),
    } : null,
  });

  if (authStatus === "loading") {
    return <LoadingScreen />;
  }

  if (authStatus === "unauthenticated") {
    console.log("[AppBootstrap] Unauthenticated -> showing signin route");
    return children;
  }

  if (authStatus === "authenticated" && !session) {
    console.error("[AppBootstrap] IMPOSSIBLE STATE: authenticated but session is null!");
    return <Navigate to="/signin" replace />;
  }

  if (authStatus === "authenticated" && session) {
    console.log("[AppBootstrap] SESSION CONTEXT:", JSON.stringify({
      activeOrgId: session.activeOrganizationId,
      orgCount: session.organizations?.length ?? 0,
      userId: session.user?.id,
      profile: session.profile ? { id: session.profile.id, email: session.profile.email } : null,
    }, null, 2));
  }

  const effectiveOrgId = getEffectiveOrgId(session);
  const hasOrgContext = effectiveOrgId !== "";

  console.log("[AppBootstrap] Effective org ID:", effectiveOrgId, "| Has org context:", hasOrgContext);

  if (!hasOrgContext) {
    console.log("[AppBootstrap] No valid org context -> redirect to /onboarding");
    return <Navigate to="/onboarding" replace />;
  }

  return <OrgProvider>{children}</OrgProvider>;
}

function AppBootstrapWithDiagnostics() {
  const { status: authStatus, session } = useAuth();

  const getPhase = () => {
    if (authStatus === "loading") return "AUTH_LOADING";
    if (authStatus === "unauthenticated") return "UNAUTHENTICATED";
    if (!session) return "SESSION_NULL";
    const effectiveOrgId = getEffectiveOrgId(session);
    if (!effectiveOrgId) return "NO_ORG_CONTEXT";
    return "READY_TO_RENDER";
  };

  const phase = getPhase();
  const showDiagnostics = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug_bootstrap");
  const isImpossibleState = authStatus === "authenticated" && !session;
  const isFullyReady = authStatus === "authenticated" && session && getEffectiveOrgId(session) !== "";

  if (isImpossibleState) {
    console.error("[AppBootstrap] IMPOSSIBLE STATE: authenticated but session is null!");
    return <ImpossibleStateFallback phase="AUTHENTICATED_BUT_SESSION_NULL" />;
  }

  if (showDiagnostics && !isFullyReady) {
    return (
      <BootstrapDiagnostics
        authStatus={authStatus}
        session={session}
        bootstrapPhase={phase}
      />
    );
  }

  return <AppBootstrapInner>{<AppRoutes />}</AppBootstrapInner>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInPageWrapper />} />
      <Route path="/signup" element={<SignUpPageWrapper />} />
      <Route path="/oauth/consent" element={<OAuthConsentPageWrapper />} />
      <Route path="/oauth/callback" element={<OAuthCallbackPageWrapper />} />
      <Route path="/phone-auth" element={<PhoneAuthPageWrapper />} />
      <Route path="/forgot-password" element={<ForgotPasswordPageWrapper />} />
      <Route path="/update-password" element={<UpdatePasswordPageWrapper />} />
      <Route path="/onboarding" element={<OnboardingPageWrapper />} />
      <Route path="/internal/diagnostics" element={<AppDiagnosticsPage />} />
      <Route path="/internal/ops" element={<OpsPageWrapper />} />
      <Route element={<AppLayout />}>
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/calendar"
          element={
            <ProtectedRoute>
              <CalendarPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/tasks"
          element={
            <ProtectedRoute>
              <TasksPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/crm"
          element={
            <ProtectedRoute>
              <CRMPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/crm/:id"
          element={
            <ProtectedRoute>
              <ContactDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/projects"
          element={
            <ProtectedRoute>
              <ProjectsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/automations"
          element={
            <ProtectedRoute>
              <AutomationsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/files"
          element={
            <ProtectedRoute>
              <FilesPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/team"
          element={
            <ProtectedRoute>
              <TeamPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function AppBootstrap() {
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Syncoree failed to load</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred during bootstrap. Try reloading.
                  </p>
                </div>
                <Button onClick={() => window.location.reload()}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Reload
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <AppBootstrapWithDiagnostics />
    </ErrorBoundary>
  );
}

function App() {
  return (
    <BrowserRouter>
      <GlobalErrorHandler>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <TooltipProvider>
              <Toaster />
              <Sonner />
              <AppBootstrap />
            </TooltipProvider>
          </AuthProvider>
        </QueryClientProvider>
      </GlobalErrorHandler>
    </BrowserRouter>
  );
}

function SignInPageWrapper() {
  console.log("[SignInPageWrapper] Route matched: /signin");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Sign-in screen failed to load</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred while loading the sign-in page.
                  </p>
                </div>
                <Button onClick={() => window.location.reload()}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <SignInPage />
    </ErrorBoundary>
  );
}

function SignUpPageWrapper() {
  console.log("[SignUpPageWrapper] Route matched: /signup");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Sign-up screen failed</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred while loading.
                  </p>
                </div>
                <Button onClick={() => window.location.reload()}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <SignUpPage />
    </ErrorBoundary>
  );
}

function OnboardingPageWrapper() {
  console.log("[OnboardingPageWrapper] Route matched: /onboarding");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Onboarding failed to load</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred during setup.
                  </p>
                </div>
                <Button onClick={() => window.location.reload()}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <OnboardingPage />
    </ErrorBoundary>
  );
}

function OAuthConsentPageWrapper() {
  console.log("[OAuthConsentPageWrapper] Route matched: /oauth/consent");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Authorization failed</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred during OAuth.
                  </p>
                </div>
                <Button onClick={() => window.location.reload()}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <OAuthConsentPage />
    </ErrorBoundary>
  );
}

function OAuthCallbackPageWrapper() {
  console.log("[OAuthCallbackPageWrapper] Route matched: /oauth/callback");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Authentication failed</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred during callback.
                  </p>
                </div>
                <Button onClick={() => window.location.href = "/signin"}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Go to Sign In
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <OAuthCallbackPage />
    </ErrorBoundary>
  );
}

function PhoneAuthPageWrapper() {
  console.log("[PhoneAuthPageWrapper] Route matched: /phone-auth");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Phone auth failed</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred while loading.
                  </p>
                </div>
                <Button onClick={() => window.location.reload()}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <PhoneAuthPage />
    </ErrorBoundary>
  );
}

function ForgotPasswordPageWrapper() {
  console.log("[ForgotPasswordPageWrapper] Route matched: /forgot-password");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Reset password failed</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred while loading.
                  </p>
                </div>
                <Button onClick={() => window.location.reload()}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <ForgotPasswordPage />
    </ErrorBoundary>
  );
}

function UpdatePasswordPageWrapper() {
  console.log("[UpdatePasswordPageWrapper] Route matched: /update-password");
  return (
    <ErrorBoundary
      fallback={
        <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4 p-4">
          <Card className="w-full max-w-md border-destructive/50">
            <CardContent className="pt-6">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-foreground mb-1">Update password failed</h1>
                  <p className="text-sm text-muted-foreground">
                    An error occurred while loading.
                  </p>
                </div>
                <Button onClick={() => window.location.href = "/signin"}>
                  <Loader2 className="w-4 h-4 mr-2" />
                  Go to Sign In
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      }
    >
      <UpdatePasswordPage />
    </ErrorBoundary>
  );
}

function OpsPageWrapper() {
  return <OpsPage />;
}

export default App;
