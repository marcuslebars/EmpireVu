import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { Loader2 } from "lucide-react";
import { platformBrand } from "@/lib/platform-brand";

interface ProtectedRouteProps {
  children: ReactNode;
  requireOrg?: boolean;
}

export function ProtectedRoute({ children, requireOrg = true }: ProtectedRouteProps) {
  const { status } = useAuth();
  const { isValid, requiresOnboarding } = useOrg();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <p className="text-muted-foreground">Loading {platformBrand.name}...</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }

  if (requireOrg && requiresOnboarding) {
    return <Navigate to="/onboarding" state={{ from: location }} replace />;
  }

  // Authenticated and the account HAS an organization, but the active org id is still
  // hydrating from the session (see OrgProvider). Wait rather than render pages with an
  // empty org — which briefly reads as "no workspace" and used to bounce to onboarding.
  if (requireOrg && !isValid) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <p className="text-muted-foreground">Loading your workspace...</p>
      </div>
    );
  }

  return <>{children}</>;
}

export function AuthRedirect() {
  const { status } = useAuth();
  const { requiresOnboarding } = useOrg();
  const location = useLocation();
  const from = (location.state as { from?: Location } | null)?.from?.pathname;

  if (status === "loading") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-background to-muted/50 gap-4">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (status === "authenticated") {
    // A returning user with an organization goes to the app; only a brand-new account
    // (no organization) is sent to onboarding.
    return <Navigate to={requiresOnboarding ? "/onboarding" : from || "/"} replace />;
  }

  return <Navigate to="/signin" replace />;
}
