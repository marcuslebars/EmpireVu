import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { useOrg } from "@/lib/org-context";
import { Loader2 } from "lucide-react";

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
        <p className="text-muted-foreground">Loading Syncoree...</p>
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }

  if (requireOrg && requiresOnboarding) {
    return <Navigate to="/onboarding" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

export function AuthRedirect() {
  const { status } = useAuth();
  const { isValid } = useOrg();
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

  if (status === "authenticated" && isValid) {
    return <Navigate to={from || "/"} replace />;
  }

  return <Navigate to="/onboarding" replace />;
}
