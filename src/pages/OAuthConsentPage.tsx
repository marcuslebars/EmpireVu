import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, CheckCircle, Shield } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

export default function OAuthConsentPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isProcessing, setIsProcessing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [provider] = useState(searchParams.get("provider") || "the application");
  const { status } = useAuth();

  useEffect(() => {
    const errorParam = searchParams.get("error");
    const errorDescription = searchParams.get("error_description");

    if (errorParam) {
      setError(errorDescription || `OAuth error: ${errorParam}`);
      setIsProcessing(false);
      return;
    }

    const code = searchParams.get("code");
    const state = searchParams.get("state");

    if (code) {
      console.log("[OAuthConsent] Received auth code, processing...");
    }

    if (status === "authenticated") {
      setIsProcessing(false);
    } else if (status === "unauthenticated") {
      setError("Authentication failed. Please try again.");
      setIsProcessing(false);
    }
  }, [searchParams, status]);

  const handleDecline = () => {
    navigate("/signin", { replace: true });
  };

  const handleContinue = () => {
    navigate("/", { replace: true });
  };

  if (isProcessing) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
              <span className="text-primary-foreground font-bold text-lg">S</span>
            </div>
            <span className="text-2xl font-semibold tracking-tight text-foreground">Syncoree</span>
          </div>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
            <CardContent className="pt-8 pb-8">
              <div className="flex flex-col items-center text-center gap-4">
                <Loader2 className="h-10 w-10 animate-spin text-primary" />
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">Processing authorization</h2>
                  <p className="text-sm text-muted-foreground mt-2">
                    Please wait while we complete the sign-in process...
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
              <span className="text-primary-foreground font-bold text-lg">S</span>
            </div>
            <span className="text-2xl font-semibold tracking-tight text-foreground">Syncoree</span>
          </div>

          <Card className="border-destructive/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl font-semibold tracking-tight text-destructive">Authorization failed</CardTitle>
              <CardDescription className="text-muted-foreground">
                Something went wrong during sign in
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive" className="py-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>

              <div className="flex gap-3">
                <Button variant="outline" className="flex-1 h-11" onClick={handleDecline}>
                  Back to sign in
                </Button>
                <Button className="flex-1 h-11" onClick={() => navigate("/signin")}>
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
          <span className="text-2xl font-semibold tracking-tight text-foreground">Syncoree</span>
        </div>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
          <CardHeader className="pb-4">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Shield className="w-5 h-5 text-primary" />
              </div>
            </div>
            <CardTitle className="text-xl font-semibold tracking-tight">Authorization successful</CardTitle>
            <CardDescription className="text-muted-foreground">
              {provider} has been linked to your account
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Alert className="border-green-500/30 bg-green-500/5 py-3">
              <CheckCircle className="h-4 w-4 text-green-500" />
              <AlertDescription className="text-green-500 font-medium">
                Your account is now connected
              </AlertDescription>
            </Alert>

            <div className="p-4 rounded-lg bg-muted/50 space-y-2">
              <p className="text-sm font-medium text-foreground">What happens next:</p>
              <ul className="text-sm text-muted-foreground space-y-1.5">
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                  Your account has been linked
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                  You can now sign in using this provider
                </li>
                <li className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>
                  Click below to continue to your dashboard
                </li>
              </ul>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1 h-11" onClick={handleDecline}>
                Cancel
              </Button>
              <Button className="flex-1 h-11 font-medium" onClick={handleContinue}>
                Continue to dashboard
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
