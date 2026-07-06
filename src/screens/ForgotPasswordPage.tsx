import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertCircle, CheckCircle, ArrowLeft } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

export default function ForgotPasswordPage() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const result = await resetPassword(email);

    if (result.error) {
      setError(result.error);
      setIsLoading(false);
      return;
    }

    setSuccess(true);
    setIsLoading(false);
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center justify-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20">
              <span className="text-primary-foreground font-bold text-lg">S</span>
            </div>
            <span className="text-2xl font-semibold tracking-tight text-foreground">EmpireVu</span>
          </div>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
            <CardContent className="pt-8 pb-8">
              <div className="flex flex-col items-center text-center gap-4">
                <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle className="w-7 h-7 text-green-500" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold tracking-tight">Check your email</h2>
                  <p className="text-sm text-muted-foreground mt-2">
                    We&apos;ve sent a password reset link to{" "}
                    <span className="font-medium text-foreground">{email}</span>
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Click the link to reset your password. It expires in 1 hour.
                </p>
              </div>

              <div className="mt-8">
                <Button variant="outline" className="w-full h-11" asChild>
                  <Link to="/signin">
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    Back to sign in
                  </Link>
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
          <span className="text-2xl font-semibold tracking-tight text-foreground">EmpireVu</span>
        </div>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm shadow-xl shadow-black/10">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl font-semibold tracking-tight">Reset your password</CardTitle>
            <CardDescription className="text-muted-foreground">
              Enter your email and we&apos;ll send you a reset link
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

              <Button type="submit" className="w-full h-11 text-base font-medium" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Sending link...
                  </>
                ) : (
                  "Send reset link"
                )}
              </Button>
            </form>

            <div className="pt-4 text-center text-sm text-muted-foreground border-t border-border/50">
              Remember your password?{" "}
              <Link to="/signin" className="text-primary font-medium hover:text-primary/90 transition-colors">
                Sign in
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
