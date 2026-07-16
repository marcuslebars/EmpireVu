import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, CheckCircle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "@/components/brand/Logo";

export default function UpdatePasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { updatePassword, status } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  useEffect(() => {
    const errorParam = searchParams.get("error");
    const tokenHash = searchParams.get("token_hash");
    const type = searchParams.get("type");
    // Supabase (@supabase/ssr) uses the PKCE flow, so recovery links arrive with
    // a `code` param; older links use `token_hash` + `type=recovery`. Accept either.
    const code = searchParams.get("code");

    if (errorParam) {
      setTokenError("This password reset link has expired or is invalid. Please request a new one.");
      return;
    }

    if (!code && (!tokenHash || type !== "recovery")) {
      setTokenError("Invalid password reset link. Please use the link from your email.");
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsLoading(true);
    const result = await updatePassword(password);

    if (result.error) {
      setError(result.error);
      setIsLoading(false);
      return;
    }

    setSuccess(true);
    setIsLoading(false);
  };

  useEffect(() => {
    // Don't bounce to sign-in while a recovery link is still being processed — the
    // PKCE code exchange briefly reports "unauthenticated" before the session lands.
    const hasRecoveryParam =
      searchParams.get("code") ||
      (searchParams.get("token_hash") && searchParams.get("type") === "recovery");
    if (status === "unauthenticated" && !tokenError && !hasRecoveryParam) {
      navigate("/signin");
    }
  }, [status, tokenError, navigate, searchParams]);

  if (tokenError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-center mb-8">
            <Logo className="h-8" />
          </div>

          <Card className="border-destructive/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
            <CardHeader className="pb-4">
              <CardTitle className="text-xl font-semibold tracking-tight text-destructive">Invalid reset link</CardTitle>
              <CardDescription className="text-muted-foreground">
                This link has expired or is invalid
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive" className="py-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{tokenError}</AlertDescription>
              </Alert>

              <Button className="w-full h-11" onClick={() => navigate("/forgot-password")}>
                Request new link
              </Button>

              <Button variant="outline" className="w-full h-11" onClick={() => navigate("/signin")}>
                Back to sign in
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-center mb-8">
            <Logo className="h-8" />
          </div>

          <Card className="borderBorder/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
            <CardContent className="pt-8 pb-8">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle className="w-7 h-7 text-green-500" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">Password updated</h2>
                  <p className="text-sm text-muted-foreground mt-2">
                    Your password has been successfully changed.
                  </p>
                </div>
              </div>

              <Button className="w-full mt-8 h-11" onClick={() => navigate("/signin")}>
                Sign in with new password
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center justify-center mb-8">
          <Logo className="h-8" />
        </div>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-semibold tracking-tight">Create new password</CardTitle>
            <CardDescription className="text-muted-foreground">
              Enter your new password below
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error && (
              <Alert variant="destructive" className="py-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password" className="text-sm font-medium">New Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter new password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  autoComplete="new-password"
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-sm font-medium">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm your password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  autoComplete="new-password"
                  className="h-11"
                />
              </div>

              <Button type="submit" className="w-full h-11 text-base font-medium" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  "Update password"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
