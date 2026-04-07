import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <div>
                <h2 className="text-xl font-semibold">Completing Sign In</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Please wait while we complete the authentication...
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2">
              <div className="w-8 h-8 rounded-lg bg-destructive flex items-center justify-center">
                <span className="text-destructive-foreground font-bold text-sm">!</span>
              </div>
              <CardTitle className="text-2xl">Syncoree</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Authentication Failed</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => navigate("/signin")}>
                Back to Sign In
              </Button>
              <Button className="flex-1" onClick={() => window.location.reload()}>
                Try Again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
      <Card className="w-full max-w-md">
        <CardContent className="pt-6">
          <div className="flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-full bg-green-500/10 flex items-center justify-center">
              <CheckCircle className="w-6 h-6 text-green-500" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">Sign In Successful</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Redirecting you to the app...
              </p>
            </div>
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
