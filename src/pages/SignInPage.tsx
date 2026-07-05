import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Loader2, AlertCircle, Mail, Phone, Chrome } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { getSupabaseConfigDiagnostic } from "@/lib/supabase";

export default function SignInPage() {
  console.log("[SignInPage] Component rendering/mounting");

  const navigate = useNavigate();
  const { signIn, signInWithOAuth } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isOAuthLoading, setIsOAuthLoading] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<{ isConfigured: boolean } | null>(null);

  useEffect(() => {
    console.log("[SignInPage] useEffect fired - page mounted");
    const status = getSupabaseConfigDiagnostic();
    setConfigStatus(status);
    console.log("[SignInPage] Supabase config:", status);
    return () => console.log("[SignInPage] Component unmounting");
  }, []);

  console.log("[SignInPage] Rendering form UI");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const result = await signIn(email, password);

    if (result.error) {
      setError(result.error);
      setIsLoading(false);
      return;
    }

    setIsLoading(false);
  };

  const handleOAuthSignIn = async (provider: "google" | "github" | "apple") => {
    setOauthError(null);
    setIsOAuthLoading(true);

    const result = await signInWithOAuth(provider);

    if (result.error) {
      setOauthError(result.error);
      setIsOAuthLoading(false);
      return;
    }
  };

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
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-semibold tracking-tight">Welcome back</CardTitle>
            <CardDescription className="text-muted-foreground">
              Sign in to your workspace
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {error && (
              <Alert variant="destructive" className="py-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {oauthError && (
              <Alert variant="destructive" className="py-3">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{oauthError}</AlertDescription>
              </Alert>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={isLoading}
                  autoComplete="email"
                  className="h-11"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                  <Link
                    to="/forgot-password"
                    className="text-sm text-primary hover:text-primary/90 transition-colors"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  autoComplete="current-password"
                  className="h-11"
                />
              </div>

              <Button
                type="submit"
                className="w-full h-11 text-base font-medium"
                disabled={isLoading}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  <>
                    <Mail className="mr-2 h-4 w-4" />
                    Sign in with email
                  </>
                )}
              </Button>
            </form>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <Separator className="w-full" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-card px-3 text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  or continue with
                </span>
              </div>
            </div>

            <Button
              variant="outline"
              className="w-full h-11 text-base font-medium"
              onClick={() => handleOAuthSignIn("google")}
              disabled={isOAuthLoading || !configStatus?.isConfigured}
            >
              {isOAuthLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Chrome className="mr-2 h-4 w-4" />
              )}
              Continue with Google
            </Button>

            <div className="flex items-center justify-center pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate("/phone-auth")}
                disabled={!configStatus?.isConfigured}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Phone className="mr-2 h-4 w-4" />
                Sign in with phone
              </Button>
            </div>

            <div className="pt-4 text-center text-sm text-muted-foreground border-t border-border/50">
              Don&apos;t have an account?{" "}
              <Link to="/signup" className="text-primary font-medium hover:text-primary/90 transition-colors">
                Create account
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
