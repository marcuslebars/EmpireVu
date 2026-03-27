import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { AppLayout } from "@/components/layout/AppLayout";
import { AppContextProvider } from "@/lib/app-context";
import SignInPage from "./pages/SignInPage";
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

function LoadingScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4">
      <Loader2 className="h-10 w-10 animate-spin text-primary" />
      <p className="text-muted-foreground">Loading Syncoree...</p>
    </div>
  );
}

function SignInRoute() {
  const { status, isLoading, session } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (status === "authenticated" && session && session.organizations.length > 0) {
    return <Navigate to="/" replace />;
  }

  if (status === "authenticated" && session && session.organizations.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  return <SignInPage />;
}

function ProtectedLayout() {
  const { status, isLoading, session } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (status === "unauthenticated") {
    return <Navigate to="/signin" replace />;
  }

  if (status === "authenticated" && session && session.organizations.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <AppContextProvider>
      <AppLayout />
    </AppContextProvider>
  );
}

function OnboardingLayout() {
  const { status, isLoading, session } = useAuth();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (status === "unauthenticated") {
    return <Navigate to="/signin" replace />;
  }

  if (status === "authenticated" && session && session.organizations.length > 0) {
    return <Navigate to="/" replace />;
  }

  return <OnboardingPage />;
}

const App = () => {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <BrowserRouter>
            <Routes>
              <Route path="/signin" element={<SignInRoute />} />
              <Route path="/onboarding" element={<OnboardingLayout />} />
              <Route element={<ProtectedLayout />}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/crm" element={<CRMPage />} />
                <Route path="/crm/:id" element={<ContactDetailPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/automations" element={<AutomationsPage />} />
                <Route path="/files" element={<FilesPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
};

export default App;
