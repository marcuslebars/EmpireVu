import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { OrgProvider } from "@/lib/org-context";
import { ErrorBoundary } from "@/components/system/ErrorBoundary";
import { ProtectedRoute, AuthRedirect } from "@/components/system/ProtectedRoute";
import { AppLayout } from "@/components/layout/AppLayout";
import { AppDiagnosticsPage } from "@/pages/AppDiagnosticsPage";
import { OpsPage } from "@/pages/OpsPage";
import SignInPage from "./pages/SignInPage";
import SignUpPage from "./pages/SignUpPage";
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
import { Loader2 } from "lucide-react";

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

function AppBootstrap() {
  const { status: authStatus, session } = useAuth();

  if (authStatus === "loading") {
    return <LoadingScreen />;
  }

  if (authStatus === "unauthenticated") {
    return <Navigate to="/signin" replace />;
  }

  if (authStatus === "authenticated" && !session?.activeOrganizationId && !session?.organizations?.length) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <OrgProvider>
      <Routes>
        <Route path="/signin" element={<SignInPageWrapper />} />
        <Route path="/signup" element={<SignUpPageWrapper />} />
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
    </OrgProvider>
  );
}

function App() {
  return (
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ErrorBoundary>
            <TooltipProvider>
              <Toaster />
              <Sonner />
              <AppBootstrap />
            </TooltipProvider>
          </ErrorBoundary>
        </AuthProvider>
      </QueryClientProvider>
    </BrowserRouter>
  );
}

function SignInPageWrapper() {
  return <SignInPage />;
}

function SignUpPageWrapper() {
  return <SignUpPage />;
}

function OnboardingPageWrapper() {
  return <OnboardingPage />;
}

function OpsPageWrapper() {
  return <OpsPage />;
}

export default App;
