import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, AlertCircle, CheckCircle, Shield, ArrowLeft } from "lucide-react";
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
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted/50 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center text-center gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <div>
                <h2 className="text-xl font-semibold">Processing Authorization</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Please wait while we complete the sign-in process...
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
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
              <AlertTitle>Authorization Failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>

            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={handleDecline}>
                <ArrowLeft className="w-4 h-4 mr-2" />
                Go Back
              </Button>
              <Button className="flex-1" onClick={() => navigate("/signin")}>
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
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <Shield className="w-4 h-4 text-primary-foreground" />
            </div>
            <CardTitle className="text-2xl">Syncoree</CardTitle>
          </div>
          <CardDescription>
            OAuth Authorization
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert className="border-primary/50 bg-primary/5">
            <CheckCircle className="h-4 w-4 text-primary" />
            <AlertTitle>Authorization Successful</AlertTitle>
            <AlertDescription>
              You have successfully authorized <strong>{provider}</strong> to access your Syncoree account.
            </AlertDescription>
          </Alert>

          <div className="p-4 rounded-lg bg-muted space-y-2">
            <p className="text-sm font-medium">What happens next:</p>
            <ul className="text-sm text-muted-foreground space-y-1">
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
            <Button variant="outline" className="flex-1" onClick={handleDecline}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={handleContinue}>
              Continue to Dashboard
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
