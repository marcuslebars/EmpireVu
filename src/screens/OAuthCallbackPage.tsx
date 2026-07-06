import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, CheckCircle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

export default function OAuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { status: authStatus } = useAuth();

  useEffect(() => {
    const errorParam = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    if (errorParam) {
      console.error("[OAuthCallback] OAuth error:", errorParam, errorDescription);
      setErrorMessage(errorDescription || `OAuth error: ${errorParam}`);
      setStatus("error");
      return;
    }

    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (code) {
      console.log("[OAuthCallback] Received code, waiting for auth state update...");
    }

    const timeout = setTimeout(() => {
      if (authStatus === "authenticated") {
        setStatus("success");
      } else if (authStatus === "unauthenticated") {
        setErrorMessage("Authentication failed. Please try again.");
        setStatus("error");
      }
    }, 2000);

    if (authStatus === "authenticated") {
      clearTimeout(timeout);
      setStatus("success");
    } else if (authStatus === "unauthenticated") {
      clearTimeout(timeout);
      setErrorMessage("Authentication failed. Please try again.");
      setStatus("error");
    }

    return () => clearTimeout(timeout);
  }, [searchParams, authStatus]);

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
              <span className="text-primary-foreground font-bold text-lg">S</span>
            </div>
            <span className="text-2xl font-semibold tracking-tight text-foreground">Hubcos</span>
          </div>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
            <CardContent className="pt-8 pb-8">
              <div className="flex flex-col items-center text-center gap-4">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">Completing sign in</h2>
                  <p className="text-sm text-muted-foreground mt-2">
                    Please wait while we complete the authentication...
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
              <span className="text-primary-foreground font-bold text-lg">S</span>
            </div>
            <span className="text-2xl font-semibold tracking-tight text-foreground">Hubcos</span>
          </div>

          <Card className="border-destructive/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl font-semibold tracking-tight text-destructive">Authentication failed</CardTitle>
              <CardDescription className="text-muted-foreground">
                Something went wrong during sign in
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive" className="py-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>

              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 h-11" onClick={() => navigate("/signin")}>
                  Back to sign in
                </Button>
                <Button className="flex-1 h-11" onClick={() => window.location.reload()}>
                  Try again
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
            <span className="text-primary-foreground font-bold text-lg">S</span>
          </div>
          <span className="text-2xl font-semibold tracking-tight text-foreground">Hubcos</span>
        </div>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
          <CardContent className="pt-8 pb-8">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center">
                <CheckCircle className="w-7 h-7 text-green-500" />
              </div>
              <div>
                <h2 className="text-xl font-semibold tracking-tight">Sign in successful</h2>
                <p className="text-sm text-muted-foreground mt-2">
                  Redirecting you to the app...
                </p>
              </div>
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
